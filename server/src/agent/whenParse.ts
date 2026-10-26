/**
 * "When to run" in plain words -> a schedule's timing.
 *
 * The New schedule form has one free-text box ("Weekdays at 8 AM", "Mondays at 11 AM and 5 PM", "every 2 hours",
 * "tomorrow at 9 AM"). This turns that text into exactly one of: a cron (repeats), an interval (repeats) or a single
 * moment (runs once), in the user's timezone, with a summary that reads back what was understood. Anything it is
 * not sure about is refused with a hint, never guessed: a one-time run needs an hour, a day of the month past the
 * 28th is refused (some months never reach it), and times on different minutes can't share one cron.
 */
import { nextCronRun, parseCron } from './cron.js';

export type WhenResult =
  | { kind: 'cron'; cron: string; summary: string; text: string }
  | { kind: 'interval'; intervalSec: number; summary: string; text: string }
  | { kind: 'once'; runAt: number; summary: string; text: string };

export class WhenError extends Error {}

const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const DAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A part of the day with no clock time: the hour it stands for (named in the summary so the user can change it). */
const DAY_PARTS: Record<string, number> = { morning: 8, noon: 12, midday: 12, afternoon: 15, evening: 18, tonight: 21, night: 21, midnight: 0 };

function dayIndex(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length < 2) return -1;
  for (let i = 0; i < 7; i++) {
    const n = DAY_NAMES[i]!;
    // monday, mondays, mon, mons, tue, tues, thur, thurs, weds ...
    if (w === n || w === `${n}s` || (w.length >= 3 && (n.startsWith(w) || n.startsWith(w.replace(/s$/, ''))))) return i;
  }
  return -1;
}

function monthIndex(word: string): number {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length < 3) return -1;
  return MONTHS.findIndex((m) => m.startsWith(w));
}

export function localParts(tz: string, t: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { year: Number(o.year), month: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute), dow: DAY_SHORT.indexOf(o.weekday!) };
}

function clock(h: number, m: number): string {
  const ap = h < 12 ? 'AM' : 'PM';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')} ${ap}`;
}

function joinList(xs: string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

function ordinal(n: number): string {
  const s = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
  return `${n}${s.length === 2 ? s : 'th'}`;
}

interface Clock {
  h: number;
  m: number;
}

/** Every clock time in the text: "8", "8am", "8:30 pm", "20:00", "noon", "midnight". Removes what it read. */
function takeTimes(s: string): { times: Clock[]; rest: string; partOfDay: string | null } {
  const times: Clock[] = [];
  let rest = s;
  let partOfDay: string | null = null;
  // 8am, 8 am, 8:30pm, 8.30 p.m.
  rest = rest.replace(/\b(\d{1,2})(?:[:.](\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/g, (_x, hs: string, ms: string | undefined, ap: string) => {
    let h = Number(hs);
    const m = ms ? Number(ms) : 0;
    if (h < 1 || h > 12 || m > 59) throw new WhenError(`"${_x.trim()}" isn't a time I can read.`);
    const pm = ap.startsWith('p');
    if (h === 12) h = pm ? 12 : 0;
    else if (pm) h += 12;
    times.push({ h, m });
    return ' ';
  });
  // 20:00, 08:30
  rest = rest.replace(/\b([01]?\d|2[0-3]):([0-5]\d)\b/g, (_x, hs: string, ms: string) => {
    times.push({ h: Number(hs), m: Number(ms) });
    return ' ';
  });
  rest = rest.replace(/\b(noon|midday)\b/g, () => {
    times.push({ h: 12, m: 0 });
    return ' ';
  });
  rest = rest.replace(/\bmidnight\b/g, () => {
    times.push({ h: 0, m: 0 });
    return ' ';
  });
  // "at 8" / "at 8 and 5": a bare hour after "at" (and the ones that follow it)
  rest = rest.replace(/\bat\s+(\d{1,2})((?:\s*(?:,|and|&)\s*\d{1,2})*)\b(?!\s*(?:st|nd|rd|th|min|minute|hour|day|week))/g, (_x, first: string, more: string) => {
    const all = [first, ...(more.match(/\d{1,2}/g) ?? [])].map(Number);
    for (const h of all) {
      if (h > 23) throw new WhenError(`"${h}" isn't an hour.`);
      times.push({ h, m: 0 });
    }
    return ' at ';
  });
  const part = rest.match(/\b(morning|afternoon|evening|tonight|night)\b/);
  if (part) partOfDay = part[1]!;
  // "9 in the evening" / "at 7 tonight": a bare hour with a part of the day after it reads as that half of the day
  if (partOfDay && times.length) {
    const pm = partOfDay !== 'morning';
    for (const t of times) if (pm && t.h >= 1 && t.h < 12 && !/[ap]\.?m/.test(s)) t.h += 12;
  }
  return { times, rest, partOfDay };
}

function uniqTimes(times: Clock[]): Clock[] {
  const seen = new Set<string>();
  return times.filter((t) => (seen.has(`${t.h}:${t.m}`) ? false : (seen.add(`${t.h}:${t.m}`), true))).sort((a, b) => a.h * 60 + a.m - (b.h * 60 + b.m));
}

function timesFor(times: Clock[], partOfDay: string | null, needHour: boolean): Clock[] {
  if (times.length) return uniqTimes(times);
  if (partOfDay) return [{ h: DAY_PARTS[partOfDay]!, m: 0 }];
  if (needHour) throw new WhenError('Add a time, for example "at 8 AM".');
  return [];
}

function cronTimes(times: Clock[]): { minute: string; hour: string } {
  const minutes = new Set(times.map((t) => t.m));
  if (minutes.size > 1) throw new WhenError('Those times are on different minutes, so they need two schedules. Try times on the same minute, like 11 AM and 5 PM.');
  return { minute: String(times[0]!.m), hour: times.map((t) => t.h).join(',') };
}

function describeTimes(times: Clock[]): string {
  return joinList(times.map((t) => clock(t.h, t.m)));
}

function describeDays(days: number[]): string {
  const set = [...new Set(days)].sort((a, b) => a - b);
  const key = set.join(',');
  if (key === '0,1,2,3,4,5,6') return 'Every day';
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '0,6') return 'Weekends';
  return joinList(set.map((d) => `${DAY_LONG[d]}s`));
}

function humanInterval(sec: number): string {
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return h === 1 ? 'Every hour' : `Every ${h} hours`;
  }
  const m = Math.round(sec / 60);
  return m === 1 ? 'Every minute' : `Every ${m} minutes`;
}

function onceSummary(runAt: number, tz: string, now: number): string {
  const p = localParts(tz, runAt);
  const n = localParts(tz, now);
  const tomorrow = localParts(tz, now + 86_400_000);
  const at = clock(p.hour, p.minute);
  if (p.year === n.year && p.month === n.month && p.day === n.day) return `Once, today at ${at}`;
  if (p.year === tomorrow.year && p.month === tomorrow.month && p.day === tomorrow.day) return `Once, tomorrow at ${at}`;
  return `Once, ${DAY_LONG[p.dow]}, ${MONTH_LONG[p.month - 1]} ${p.day} at ${at}`;
}

/** Text that parses back to the same timing (what the edit form shows). */
function onceText(runAt: number, tz: string): string {
  const p = localParts(tz, runAt);
  return `On ${MONTH_LONG[p.month - 1]} ${p.day}, ${p.year} at ${clock(p.hour, p.minute)}`;
}

/** The next moment a local date and clock time happen (a cron on that day of that month). */
function atLocal(month: number, day: number, t: Clock, tz: string, now: number, year?: number): number {
  const cron = `${t.m} ${t.h} ${day} ${month} *`;
  let at = nextCronRun(cron, now - 60_000, tz);
  if (year) {
    // walk forward to the named year (at most a few hops; nextCronRun looks 400 days ahead)
    let guard = 0;
    while (localParts(tz, at).year < year && guard++ < 3) at = nextCronRun(cron, at, tz);
    if (localParts(tz, at).year !== year) throw new WhenError("That date is too far ahead. Pick one within the next year.");
  }
  return at;
}

/** The moment if it falls on that local calendar day (not the same date a year later), else null. */
function sameDay(at: number, d: { year: number; month: number; day: number }, tz: string): number | null {
  const p = localParts(tz, at);
  return p.year === d.year && p.month === d.month && p.day === d.day ? at : null;
}

function validDayOfMonth(month: number, day: number) {
  const max = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  if (day < 1 || day > max) throw new WhenError(`${MONTH_LONG[month - 1]} doesn't have a ${ordinal(day)}.`);
}

export function parseWhen(input: string, tz: string, now = Date.now(), minIntervalSec = 60): WhenResult {
  const raw = input.trim();
  if (!raw) throw new WhenError('Say when it should run, for example "Weekdays at 8 AM".');
  if (raw.length > 200) throw new WhenError('Keep "When to run" short, for example "Weekdays at 8 AM".');

  // a raw 5-field cron still works for people who know it
  if (/^[\d*/,\-?a-z]+(\s+[\d*/,\-?a-z]+){4}$/i.test(raw) && /[\d*]/.test(raw.split(/\s+/)[0]!)) {
    try {
      parseCron(raw);
      nextCronRun(raw, now, tz);
      return { kind: 'cron', cron: raw, summary: describeCron(raw), text: describeCron(raw) };
    } catch (e) {
      throw new WhenError(`That cron expression doesn't work: ${(e as Error).message}`);
    }
  }

  let s = ` ${raw.toLowerCase().replace(/[’']/g, '').replace(/\s+/g, ' ')} `;
  s = s.replace(/\beveryday\b/g, 'every day').replace(/\bweek days\b/g, 'weekdays').replace(/\bweek ends\b/g, 'weekends').replace(/\bo ?clock\b/g, '');

  // ---- "in 20 minutes", "in 2 hours", "in an hour" (once)
  const rel = s.match(/^\s*in\s+(an?|\d+)\s*(minutes?|mins?|hours?|hrs?|days?)\s*$/);
  if (rel) {
    const n = /^an?$/.test(rel[1]!) ? 1 : Number(rel[1]);
    const unit = rel[2]!.startsWith('m') ? 60 : rel[2]!.startsWith('d') ? 86400 : 3600;
    if (n < 1) throw new WhenError('Pick a time in the future.');
    const runAt = now + n * unit * 1000;
    return { kind: 'once', runAt, summary: onceSummary(runAt, tz, now), text: onceText(runAt, tz) };
  }

  // ---- "every 2 hours", "hourly", "every 30 minutes"
  const every = s.match(/\bevery\s+(\d+|an?|one|other)?\s*(minutes?|mins?|hours?|hrs?)\b/) ?? (/\bhourly\b/.test(s) ? ['', '1', 'hour'] : null);
  if (every && !/\b(day|week|month)/.test(s.replace(/\bhourly\b/, ''))) {
    const word = every[1] ?? '1';
    const n = word === 'other' ? 2 : /^(an?|one)$/.test(word) || word === '' ? 1 : Number(word);
    const unit = every[2]!.startsWith('m') ? 60 : 3600;
    const sec = n * unit;
    if (!Number.isFinite(sec) || sec < 60) throw new WhenError('Pick an interval of at least a minute.');
    if (sec > 7 * 86400) throw new WhenError('That interval is too long. Try a day of the week instead.');
    if (sec < minIntervalSec) throw new WhenError(`The shortest interval here is ${humanInterval(minIntervalSec).toLowerCase()}.`);
    return { kind: 'interval', intervalSec: sec, summary: humanInterval(sec), text: humanInterval(sec) };
  }

  const { times, rest, partOfDay } = takeTimes(s);

  // ---- monthly: "on the 1st of every month at 9", "every month on the 15th", "monthly"
  if (/\b(month|monthly)\b/.test(rest)) {
    const dm = rest.match(/\b(\d{1,2})(?:st|nd|rd|th)?\b/);
    const day = dm ? Number(dm[1]) : 1;
    if (day < 1 || day > 31) throw new WhenError('Pick a day of the month from 1 to 28.');
    if (day > 28) throw new WhenError(`Some months have no ${ordinal(day)}. Pick a day from the 1st to the 28th.`);
    const ts = timesFor(times, partOfDay, true);
    const { minute, hour } = cronTimes(ts);
    const cron = `${minute} ${hour} ${day} * *`;
    const summary = `Monthly on the ${ordinal(day)} at ${describeTimes(ts)}`;
    return { kind: 'cron', cron, summary, text: summary };
  }

  // ---- days of the week
  let days: number[] = [];
  let recurring = /\b(every|each|daily|weekly|weekdays|weekends|on\s+weekdays)\b/.test(rest);
  if (/\b(every day|each day|daily|every (morning|afternoon|evening|night))\b/.test(rest)) days = [0, 1, 2, 3, 4, 5, 6];
  if (/\b(weekdays?|every weekday|work ?days)\b/.test(rest) && !/\bweekdays? and weekends?\b/.test(rest)) days.push(1, 2, 3, 4, 5);
  if (/\bweekends?\b/.test(rest)) days.push(0, 6);
  if (/\bweekdays? and weekends?\b/.test(rest)) days = [0, 1, 2, 3, 4, 5, 6];
  // ranges: monday to friday, mon-fri, monday through thursday
  const range = rest.match(/\b([a-z]{3,9})\s*(?:-|to|through|thru|till|until)\s*([a-z]{3,9})\b/);
  let named = false;
  if (range && dayIndex(range[1]!) >= 0 && dayIndex(range[2]!) >= 0) {
    let a = dayIndex(range[1]!);
    const b = dayIndex(range[2]!);
    for (let guard = 0; guard < 7; guard++) {
      days.push(a);
      if (a === b) break;
      a = (a + 1) % 7;
    }
    named = true;
    recurring = true;
  }
  const plural: boolean[] = [];
  for (const w of rest.split(/[\s,&/]+/)) {
    if (/^(sat|sun|mon|tue|wed|thu|fri)/.test(w) || /^(tues|thur|thurs|weds)$/.test(w)) {
      const d = dayIndex(w);
      if (d >= 0) {
        days.push(d);
        named = true;
        plural.push(/s$/.test(w) && !/^(tues|thurs|weds)$/.test(w));
      }
    }
  }
  if (named && plural.some(Boolean)) recurring = true;
  if (/\bweekly\b/.test(rest) && !days.length) throw new WhenError('Say which day, for example "Mondays at 9 AM".');

  if (days.length && recurring) {
    const ts = timesFor(times, partOfDay, false);
    if (!ts.length) throw new WhenError('Add a time, for example "Weekdays at 8 AM".');
    const { minute, hour } = cronTimes(ts);
    const set = [...new Set(days)].sort((a, b) => a - b);
    const dow = set.length === 7 ? '*' : set.join(',');
    const cron = `${minute} ${hour} * * ${dow}`;
    const summary = `${describeDays(set)} at ${describeTimes(ts)}`;
    return { kind: 'cron', cron, summary, text: summary };
  }

  // ---- one time from here on
  const n = localParts(tz, now);
  const ts = timesFor(times, partOfDay, true);
  if (ts.length > 1) throw new WhenError('A one-time run happens at one time. For more than one, say which days, like "Mondays at 11 AM and 5 PM".');
  const t = ts[0]!;

  // a date: "october 30", "30 october", "oct 30 2026", "2026-11-02"
  const iso = rest.match(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/);
  const md = rest.match(/\b([a-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d\d))?\b/);
  const dm = rest.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+)?([a-z]{3,9})(?:,?\s+(20\d\d))?\b/);
  let date: { month: number; day: number; year?: number } | null = null;
  if (iso) date = { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
  else if (md && monthIndex(md[1]!) >= 0) date = { month: monthIndex(md[1]!) + 1, day: Number(md[2]), year: md[3] ? Number(md[3]) : undefined };
  else if (dm && monthIndex(dm[2]!) >= 0) date = { month: monthIndex(dm[2]!) + 1, day: Number(dm[1]), year: dm[3] ? Number(dm[3]) : undefined };

  let runAt: number;
  if (date) {
    if (date.month < 1 || date.month > 12) throw new WhenError("That date doesn't exist.");
    validDayOfMonth(date.month, date.day);
    if (date.year && date.year < n.year) throw new WhenError('That date has already passed.');
    try {
      runAt = atLocal(date.month, date.day, t, tz, now, date.year);
    } catch (e) {
      if (e instanceof WhenError) throw e;
      throw new WhenError("That date doesn't exist.");
    }
    if (runAt <= now) throw new WhenError('That time has already passed.');
  } else if (/\btomorrow\b/.test(rest)) {
    // the calendar day after today, even across a DST change
    let d = localParts(tz, now + 86_400_000);
    if (d.day === n.day) d = localParts(tz, now + 30 * 3_600_000);
    runAt = atLocal(d.month, d.day, t, tz, now, d.year);
  } else if (named && days.length === 1) {
    // "friday at 3 PM" / "next friday at 3": the next one that has not passed; "next" = the first after today
    const target = days[0]!;
    const next = /\bnext\b/.test(rest);
    let offset = (target - n.dow + 7) % 7;
    if (next && offset === 0) offset = 7;
    const candidate = localParts(tz, now + offset * 86_400_000);
    const first = sameDay(atLocal(candidate.month, candidate.day, t, tz, now), candidate, tz);
    if (first) runAt = first;
    else {
      const later = localParts(tz, now + (offset + 7) * 86_400_000);
      runAt = atLocal(later.month, later.day, t, tz, now, later.year);
    }
  } else if (named) {
    throw new WhenError('For more than one day, say "every", like "every Monday and Friday at 9 AM".');
  } else {
    // today (or "tonight"); a bare time is today while it is still ahead, else tomorrow
    const explicitToday = /\b(today|tonight|this (morning|afternoon|evening))\b/.test(rest);
    const today = sameDay(atLocal(n.month, n.day, t, tz, now), n, tz);
    if (today) runAt = today;
    else {
      if (explicitToday) throw new WhenError(`${clock(t.h, t.m)} has already passed today.`);
      const d = localParts(tz, now + 86_400_000);
      runAt = atLocal(d.month, d.day, t, tz, now, d.year);
    }
  }
  const leftover = rest
    .replace(/\b(at|on|the|of|in|this|next|today|tonight|tomorrow|morning|afternoon|evening|night|once|only|run|it|please|and|a|an)\b/g, ' ')
    .replace(/\b(20\d\d)-(\d{1,2})-(\d{1,2})\b/g, ' ')
    .replace(/\b\d{1,2}(st|nd|rd|th)?\b/g, ' ')
    .replace(/\b20\d\d\b/g, ' ')
    .split(/[\s,.]+/)
    .filter((w) => w && dayIndex(w) < 0 && monthIndex(w) < 0);
  if (leftover.length) throw new WhenError(`I couldn't read "${leftover.join(' ')}". Try something like "Weekdays at 8 AM" or "Tomorrow at 9 AM".`);
  return { kind: 'once', runAt, summary: onceSummary(runAt, tz, now), text: onceText(runAt, tz) };
}

/** Read a cron back in words, for the crons this file writes; anything else is shown as the cron itself. */
export function describeCron(cron: string): string {
  const p = cron.trim().split(/\s+/);
  if (p.length !== 5) return cron;
  const [mi, hr, dom, mon, dow] = p as [string, string, string, string, string];
  if (!/^\d+$/.test(mi) || !/^\d+(,\d+)*$/.test(hr) || mon !== '*') return cron;
  const ts = hr.split(',').map((h) => ({ h: Number(h), m: Number(mi) }));
  const at = describeTimes(ts);
  if (dom === '*' && dow === '*') return `Every day at ${at}`;
  if (dom === '*' && /^[0-6](?:[,-][0-6])*$/.test(dow)) {
    const days: number[] = [];
    for (const part of dow.split(',')) {
      const [a, b] = part.split('-').map(Number);
      if (b === undefined) days.push(a!);
      else for (let d = a!; d <= b; d++) days.push(d);
    }
    return `${describeDays(days)} at ${at}`;
  }
  if (/^\d+$/.test(dom) && dow === '*') return `Monthly on the ${ordinal(Number(dom))} at ${at}`;
  return cron;
}

/** What the edit form shows in "When to run" for a saved schedule. */
export function whenTextFor(s: { cron: string | null; intervalSec: number | null; nextRunAt: number; timezone: string }): string {
  if (s.cron) return describeCron(s.cron);
  if (s.intervalSec) return humanInterval(s.intervalSec);
  return onceText(s.nextRunAt, s.timezone || 'UTC');
}
