/**
 * Minimal 5-field cron (minute hour day-of-month month day-of-week) evaluated in an IANA timezone.
 * Supports *, numbers, ranges (1-5), lists (1,3,5), steps (*\/15, 0-30/10) and day names (mon-fri).
 * As in standard cron, when both day-of-month and day-of-week are restricted, either may match.
 */

interface Field {
  values: Set<number>;
  any: boolean;
}

const NAMES: Record<string, number> = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6, jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function parseField(src: string, min: number, max: number): Field {
  const values = new Set<number>();
  const any = src === '*' || src === '?';
  for (const part of src.toLowerCase().split(',')) {
    const [rangeRaw, stepRaw] = part.split('/');
    const step = stepRaw ? Number(stepRaw) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`Bad step in "${part}"`);
    let lo = min;
    let hi = max;
    const range = rangeRaw ?? '*';
    if (range !== '*' && range !== '?') {
      const [a, b] = range.split('-');
      const num = (x: string) => (x in NAMES ? NAMES[x]! : Number(x));
      lo = num(a!);
      hi = b !== undefined ? num(b) : stepRaw ? max : lo;
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max + (max === 6 ? 1 : 0) || lo > hi) throw new Error(`Out of range: "${part}"`);
    for (let v = lo; v <= hi; v += step) values.add(max === 6 && v === 7 ? 0 : v);
  }
  return { values, any };
}

export interface Cron {
  minute: Field;
  hour: Field;
  dom: Field;
  month: Field;
  dow: Field;
}

export function parseCron(expr: string): Cron {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error('A cron expression needs 5 fields: minute hour day-of-month month day-of-week');
  return {
    minute: parseField(parts[0]!, 0, 59),
    hour: parseField(parts[1]!, 0, 23),
    dom: parseField(parts[2]!, 1, 31),
    month: parseField(parts[3]!, 1, 12),
    dow: parseField(parts[4]!, 0, 6),
  };
}

const WD: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function partsIn(tz: string, t: number) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'short' });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(t))) o[p.type] = p.value;
  return { month: Number(o.month), day: Number(o.day), hour: Number(o.hour) % 24, minute: Number(o.minute), dow: WD[o.weekday!] ?? 0 };
}

export function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Next time strictly after `from` (ms) that matches the cron in `tz`. */
export function nextCronRun(expr: string | Cron, from: number, tz = 'UTC'): number {
  const c = typeof expr === 'string' ? parseCron(expr) : expr;
  let t = Math.floor(from / 60_000) * 60_000 + 60_000;
  const limit = from + 400 * 86_400_000;
  while (t < limit) {
    const p = partsIn(tz, t);
    const domOk = c.dom.values.has(p.day);
    const dowOk = c.dow.values.has(p.dow);
    const dayOk = c.dom.any && c.dow.any ? true : c.dom.any ? dowOk : c.dow.any ? domOk : domOk || dowOk;
    if (!c.month.values.has(p.month) || !dayOk || !c.hour.values.has(p.hour)) {
      t += (60 - p.minute) * 60_000; // jump to the next local hour
      continue;
    }
    if (!c.minute.values.has(p.minute)) {
      t += 60_000;
      continue;
    }
    return t;
  }
  throw new Error('That cron expression never fires.');
}
