import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { defineTool, type ToolDef } from './tools/types.js';
import { getSetting, setSetting } from './sandbox/connections.js';
import { computeNextRun } from './tools/tasks.js';
import { isValidTimezone } from './cron.js';
import { CHARACTERS } from './persona.js';
import type { AgentStore } from './store.js';

/**
 * Agent powers modelled on this year's agent apps (each is our own build, not a copy):
 * - Goals with a plan, progress and check-ins (Meta Muse's goals and action plans).
 * - Proactive mode: a morning brief and quiet check-ins that only speak up when something needs the
 *   user (Claude Duet's daily brief and "only when it needs your attention").
 * - A team: one agent hands part of a job to another (Orin, Nova, Sage, Max), who works on it in
 *   parallel in the background and passes the result back (Grok Bot's bots that work together).
 *
 * Everything lives in the per-agent setup_settings rows, so the durable Firestore mirror keeps it
 * and deleting an account removes it. Proactive runs are ordinary schedules (visible, pausable).
 */

/** A scheduled run whose answer starts with this posts nothing to the chat (see runtime.ts). */
export const QUIET = 'NOTHING_TO_REPORT';
export const isQuietResult = (text: string) => text.trim().replace(/^[*_`\s]+/, '').startsWith(QUIET);

// ------------------------------------------------------------------ goals

export interface GoalStep {
  id: string;
  text: string;
  done: boolean;
  doneAt: number | null;
}
export interface Goal {
  id: string;
  title: string;
  why: string;
  status: 'active' | 'paused' | 'done';
  steps: GoalStep[];
  log: { at: number; text: string }[];
  checkScheduleId: string | null;
  createdAt: number;
  updatedAt: number;
}
const MAX_GOALS = 30;

export function listGoals(store: AgentStore, owner: string): Goal[] {
  const items = getSetting<{ items: Goal[] }>(store, owner, 'goals', { items: [] }).items;
  return Array.isArray(items) ? items : [];
}
function saveGoals(store: AgentStore, owner: string, items: Goal[]) {
  setSetting(store, owner, 'goals', { items: items.slice(0, MAX_GOALS) });
}
export function findGoal(store: AgentStore, owner: string, key: string): Goal | null {
  const k = key.trim().toLowerCase();
  const all = listGoals(store, owner);
  return all.find((g) => g.id === key) ?? all.find((g) => g.title.toLowerCase() === k) ?? all.find((g) => g.title.toLowerCase().includes(k)) ?? null;
}
export function goalProgress(g: Goal): { done: number; total: number; pct: number } {
  const total = g.steps.length;
  const done = g.steps.filter((s) => s.done).length;
  return { done, total, pct: g.status === 'done' ? 100 : total ? Math.round((done / total) * 100) : 0 };
}

export interface GoalPatch {
  title?: string;
  why?: string;
  status?: Goal['status'];
  addSteps?: string[];
  completeSteps?: string[];
  reopenSteps?: string[];
  removeSteps?: string[];
  note?: string;
}

function stepMatch(g: Goal, key: string): GoalStep | undefined {
  const k = key.trim().toLowerCase();
  const n = Number(k);
  if (Number.isInteger(n) && n >= 1 && n <= g.steps.length && String(n) === k) return g.steps[n - 1];
  return g.steps.find((s) => s.id === key) ?? g.steps.find((s) => s.text.toLowerCase() === k) ?? g.steps.find((s) => s.text.toLowerCase().includes(k));
}

export function createGoal(store: AgentStore, owner: string, v: { title: string; why?: string; steps?: string[] }): Goal {
  const now = Date.now();
  const all = listGoals(store, owner);
  if (all.filter((g) => g.status !== 'done').length >= MAX_GOALS) throw new Error(`There are already ${MAX_GOALS} goals. Finish or delete one first.`);
  const g: Goal = {
    id: randomUUID(),
    title: v.title.trim().slice(0, 120),
    why: (v.why ?? '').trim().slice(0, 600),
    status: 'active',
    steps: (v.steps ?? []).map((t) => t.trim()).filter(Boolean).slice(0, 25).map((text) => ({ id: randomUUID(), text: text.slice(0, 240), done: false, doneAt: null })),
    log: [{ at: now, text: 'Goal set' }],
    checkScheduleId: null,
    createdAt: now,
    updatedAt: now,
  };
  saveGoals(store, owner, [g, ...all]);
  return g;
}

export function updateGoal(store: AgentStore, owner: string, key: string, p: GoalPatch): Goal | null {
  const all = listGoals(store, owner);
  const found = findGoal(store, owner, key);
  if (!found) return null;
  const g = all.find((x) => x.id === found.id)!;
  const now = Date.now();
  const log: string[] = [];
  if (p.title?.trim()) g.title = p.title.trim().slice(0, 120);
  if (p.why !== undefined) g.why = p.why.trim().slice(0, 600);
  for (const k of p.removeSteps ?? []) {
    const s = stepMatch(g, k);
    if (s) g.steps = g.steps.filter((x) => x.id !== s.id);
  }
  for (const k of p.completeSteps ?? []) {
    const s = stepMatch(g, k);
    if (s && !s.done) {
      s.done = true;
      s.doneAt = now;
      log.push(`Done: ${s.text}`);
    }
  }
  for (const k of p.reopenSteps ?? []) {
    const s = stepMatch(g, k);
    if (s && s.done) {
      s.done = false;
      s.doneAt = null;
    }
  }
  for (const t of p.addSteps ?? []) if (t.trim() && g.steps.length < 25) g.steps.push({ id: randomUUID(), text: t.trim().slice(0, 240), done: false, doneAt: null });
  if (p.status && p.status !== g.status) {
    g.status = p.status;
    log.push(p.status === 'done' ? 'Goal reached' : p.status === 'paused' ? 'Paused' : 'Back on');
  }
  if (p.note?.trim()) log.push(p.note.trim().slice(0, 400));
  g.log = [...g.log, ...log.map((text) => ({ at: now, text }))].slice(-40);
  g.updatedAt = now;
  // a goal that is finished or paused stops its check-ins; turning it back on restarts them
  if (g.checkScheduleId) {
    const sch = store.getSchedule(owner, g.checkScheduleId);
    if (!sch) g.checkScheduleId = null;
    else if (p.status) store.updateSchedule(owner, sch.id, { enabled: g.status === 'active' });
  }
  saveGoals(store, owner, all);
  return g;
}

export function deleteGoal(store: AgentStore, owner: string, id: string): boolean {
  const all = listGoals(store, owner);
  const g = all.find((x) => x.id === id);
  if (!g) return false;
  if (g.checkScheduleId) store.deleteSchedule(owner, g.checkScheduleId);
  saveGoals(store, owner, all.filter((x) => x.id !== id));
  return true;
}

const CHECK_EVERY = { daily: '0 9 * * *', weekdays: '0 9 * * 1-5', weekly: '0 9 * * 1' } as const;
export type CheckEvery = keyof typeof CHECK_EVERY | 'off';

function goalCheckPrompt(g: Goal): string {
  return [
    `Goal check-in for "${g.title}" (goal id ${g.id}).`,
    'Call list_goals to read the goal, its plan and its progress log.',
    'Do the next step yourself when it is safe and you have the tools (research, drafting, building, organising). Ask before anything that sends, buys, posts, books or deletes.',
    'Record what you did with update_goal (complete_steps, note). Add missing steps to the plan if you find any.',
    `Then write the user a short update: what moved, what is next, and anything you need from them. If nothing changed and nothing needs them, reply with exactly ${QUIET}.`,
  ].join('\n');
}

/** Turn a goal's check-ins on (daily / weekdays / weekly at 9:00) or off. */
export function setGoalCheckIns(store: AgentStore, owner: string, goalId: string, every: CheckEvery, timezone: string): Goal | null {
  const all = listGoals(store, owner);
  const g = all.find((x) => x.id === goalId);
  if (!g) return null;
  if (g.checkScheduleId) {
    store.deleteSchedule(owner, g.checkScheduleId);
    g.checkScheduleId = null;
  }
  if (every !== 'off') {
    const tz = isValidTimezone(timezone) ? timezone : 'UTC';
    const cron = CHECK_EVERY[every];
    const s = store.createSchedule(owner, { title: `Goal: ${g.title}`.slice(0, 120), prompt: goalCheckPrompt(g), skillId: null, cron, intervalSec: null, timezone: tz, enabled: g.status === 'active', nextRunAt: computeNextRun({ cron, intervalSec: null, timezone: tz }, Date.now()) });
    g.checkScheduleId = s.id;
  }
  g.updatedAt = Date.now();
  saveGoals(store, owner, all);
  return g;
}

export function checkInsOf(store: AgentStore, owner: string, g: Goal): CheckEvery {
  if (!g.checkScheduleId) return 'off';
  const s = store.getSchedule(owner, g.checkScheduleId);
  if (!s) return 'off';
  const hit = (Object.entries(CHECK_EVERY) as [keyof typeof CHECK_EVERY, string][]).find(([, c]) => c === s.cron);
  return hit ? hit[0] : 'daily';
}

function goalText(store: AgentStore, owner: string, g: Goal): string {
  const p = goalProgress(g);
  const steps = g.steps.map((s, i) => `  ${i + 1}. [${s.done ? 'x' : ' '}] ${s.text}`).join('\n') || '  (no steps yet: add a plan with update_goal add_steps)';
  const log = g.log.slice(-5).map((l) => `  - ${new Date(l.at).toISOString().slice(0, 16).replace('T', ' ')}: ${l.text}`).join('\n');
  return `Goal "${g.title}" (id ${g.id}) - ${g.status}, ${p.done}/${p.total} steps, check-ins: ${checkInsOf(store, owner, g)}${g.why ? `\n  Why: ${g.why}` : ''}\n  Plan:\n${steps}\n  Recent progress:\n${log}`;
}

// ------------------------------------------------------------------ proactive mode

export interface ProactiveSettings {
  brief: { on: boolean; hour: number; scheduleId: string | null };
  checkins: { on: boolean; everyHours: number; scheduleId: string | null };
  timezone: string;
}
const PROACTIVE_DEFAULT: ProactiveSettings = { brief: { on: false, hour: 8, scheduleId: null }, checkins: { on: false, everyHours: 4, scheduleId: null }, timezone: 'UTC' };
export const CHECKIN_HOURS = [2, 4, 6, 12] as const;

const BRIEF_PROMPT = [
  'Morning brief for the user. Gather what matters today, using only the tools you have (skip a source you cannot reach and say nothing about it):',
  '- Calendar: today\'s events (calendar_list_events).',
  '- Email: unread mail from the last day that needs a reply or a decision (gmail_search "is:unread newer_than:1d").',
  '- Goals: each active goal from list_goals, its progress and the next step.',
  '- Tasks and schedules: what finished, failed or is waiting for the user since yesterday (task_status), and what runs today (list_schedules).',
  '- GitHub or Slack when connected: anything assigned to the user or mentioning them.',
  'Write it short and scannable: a one-line headline, then at most 6 bullets, then up to 3 suggested next actions the user can approve with one word ("Want me to draft the reply to Sam?").',
  'Read only: do not send, post, buy or delete anything in this run.',
].join('\n');

const CHECKIN_PROMPT = [
  'Quiet check-in. Look for anything that needs the user now, using only the tools you have:',
  '- Email that arrived in the last few hours and needs a reply or a decision (gmail_search "is:unread newer_than:6h").',
  '- Calendar events starting in the next 2 hours that need preparation.',
  '- Background tasks that failed or are waiting for the user (task_status).',
  '- Active goals (list_goals): if a next step is safe and you have the tools, do it and record it with update_goal.',
  'Read only for the outside world: do not send, post, buy or delete anything in this run.',
  `If something needs the user or you made real progress, write a 1-3 line note. Otherwise reply with exactly ${QUIET} and nothing else. Most check-ins should be quiet.`,
].join('\n');

export function getProactive(store: AgentStore, owner: string): ProactiveSettings {
  const s = getSetting<ProactiveSettings>(store, owner, 'proactive', PROACTIVE_DEFAULT);
  const p: ProactiveSettings = { brief: { ...PROACTIVE_DEFAULT.brief, ...s.brief }, checkins: { ...PROACTIVE_DEFAULT.checkins, ...s.checkins }, timezone: s.timezone || 'UTC' };
  // the user may have deleted or paused a proactive schedule on the Schedules page: follow that
  for (const k of ['brief', 'checkins'] as const) {
    const id = p[k].scheduleId;
    const sch = id ? store.getSchedule(owner, id) : null;
    if (!sch) p[k] = { ...p[k], on: false, scheduleId: null } as never;
    else if (!sch.enabled) p[k] = { ...p[k], on: false } as never;
  }
  return p;
}

export function setProactive(store: AgentStore, owner: string, patch: { brief?: { on?: boolean; hour?: number }; checkins?: { on?: boolean; everyHours?: number }; timezone?: string }): ProactiveSettings {
  const cur = getProactive(store, owner);
  const tz = patch.timezone && isValidTimezone(patch.timezone) ? patch.timezone : cur.timezone;
  const brief = { ...cur.brief, ...patch.brief };
  brief.hour = Math.min(23, Math.max(0, Math.round(brief.hour)));
  const checkins = { ...cur.checkins, ...patch.checkins };
  if (!(CHECKIN_HOURS as readonly number[]).includes(checkins.everyHours)) checkins.everyHours = 4;

  const sync = (cur: string | null, on: boolean, title: string, prompt: string, cron: string): string | null => {
    const existing = cur ? store.getSchedule(owner, cur) : null;
    if (!on) {
      if (existing) store.deleteSchedule(owner, existing.id);
      return null;
    }
    const nextRunAt = computeNextRun({ cron, intervalSec: null, timezone: tz }, Date.now());
    if (existing) {
      store.updateSchedule(owner, existing.id, { title, prompt, cron, intervalSec: null, timezone: tz, enabled: true, nextRunAt });
      return existing.id;
    }
    return store.createSchedule(owner, { title, prompt, skillId: null, cron, intervalSec: null, timezone: tz, enabled: true, nextRunAt }).id;
  };
  // check-ins run between 8:00 and 22:00 only, so nobody is woken up at night
  brief.scheduleId = sync(cur.brief.scheduleId, brief.on, 'Morning brief', BRIEF_PROMPT, `0 ${brief.hour} * * *`);
  checkins.scheduleId = sync(cur.checkins.scheduleId, checkins.on, 'Check-in', CHECKIN_PROMPT, `30 8-22/${checkins.everyHours} * * *`);
  const next: ProactiveSettings = { brief, checkins, timezone: tz };
  setSetting(store, owner, 'proactive', next);
  return next;
}

// ------------------------------------------------------------------ tools

const needsWorker = ({ services }: { services: { config: { agent: { worker: boolean } } } }) => (services.config.agent.worker ? null : 'WORKER_ENABLED=1');

export const createGoalTool = defineTool({
  name: 'create_goal',
  description:
    'Set a long-term goal the user wants to reach (learn something, ship an app, get fit, save money), with a step-by-step plan. It shows on the Activity page with a progress bar. Optionally check in on it on a schedule: you then work on the next step and report progress. Use for multi-week aims, not one-off tasks (create_task) or reminders.',
  schema: z.object({
    title: z.string().min(2).max(120),
    why: z.string().max(600).optional().describe('What the user wants it for, in their words'),
    steps: z.array(z.string().min(2).max(240)).max(25).optional().describe('The plan: concrete steps in order'),
    check_ins: z.enum(['off', 'daily', 'weekdays', 'weekly']).optional().describe('Work on it and report at 9:00: default off'),
  }),
  label: (a) => `Setting the goal “${a.title}”…`,
  writes: true,
  handler: async (a, ctx) => {
    let g = createGoal(ctx.services.store, ctx.owner, a);
    if (a.check_ins && a.check_ins !== 'off') {
      if (!ctx.services.config.agent.worker) return { content: `Goal saved (id ${g.id}), but check-ins need the background worker, which is off on this server.`, summary: 'Goal set' };
      g = setGoalCheckIns(ctx.services.store, ctx.owner, g.id, a.check_ins, ctx.timezone || 'UTC') ?? g;
    }
    return { content: `Goal saved.\n${goalText(ctx.services.store, ctx.owner, g)}`, summary: `Goal set: ${g.title}` };
  },
});

export const updateGoalTool = defineTool({
  name: 'update_goal',
  description:
    'Update a goal: tick off steps (by number, id or text), add or remove steps, log progress, change its status (active, paused, done) or its check-ins. Call it whenever you or the user make progress on a goal.',
  schema: z.object({
    goal: z.string().min(1).max(160).describe('Goal id or title'),
    complete_steps: z.array(z.string().max(240)).max(25).optional(),
    reopen_steps: z.array(z.string().max(240)).max(25).optional(),
    add_steps: z.array(z.string().min(2).max(240)).max(25).optional(),
    remove_steps: z.array(z.string().max(240)).max(25).optional(),
    note: z.string().max(400).optional().describe('A line for the progress log'),
    status: z.enum(['active', 'paused', 'done']).optional(),
    title: z.string().min(2).max(120).optional(),
    why: z.string().max(600).optional(),
    check_ins: z.enum(['off', 'daily', 'weekdays', 'weekly']).optional(),
  }),
  label: () => 'Updating the goal…',
  writes: true,
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    let g = updateGoal(st, ctx.owner, a.goal, { title: a.title, why: a.why, status: a.status, addSteps: a.add_steps, completeSteps: a.complete_steps, reopenSteps: a.reopen_steps, removeSteps: a.remove_steps, note: a.note });
    if (!g) return { ok: false, content: `No goal matches "${a.goal}". Call list_goals.`, summary: 'Goal not found' };
    if (a.check_ins) g = setGoalCheckIns(st, ctx.owner, g.id, a.check_ins, ctx.timezone || 'UTC') ?? g;
    const p = goalProgress(g);
    return { content: `Goal updated.\n${goalText(st, ctx.owner, g)}`, summary: `${g.title}: ${p.done}/${p.total}` };
  },
});

export const listGoalsTool = defineTool({
  name: 'list_goals',
  description: "List the user's goals with their plans, progress and recent progress log.",
  schema: z.object({ include_done: z.boolean().optional() }),
  label: () => 'Checking goals…',
  handler: async (a, ctx) => {
    const goals = listGoals(ctx.services.store, ctx.owner).filter((g) => a.include_done || g.status !== 'done');
    if (!goals.length) return { content: 'No goals yet.', summary: 'No goals' };
    return { content: goals.map((g) => goalText(ctx.services.store, ctx.owner, g)).join('\n\n'), summary: `${goals.length} goal${goals.length === 1 ? '' : 's'}` };
  },
});

const TEAM = CHARACTERS.map((c) => c.id) as [string, ...string[]];
const nameOf = (id: string) => CHARACTERS.find((c) => c.id === id)?.name ?? id;
const agentOfOwner = (owner: string) => (owner.includes('#') ? owner.split('#')[1]! : 'orin');
const ownerFor = (owner: string, agent: string) => {
  const base = owner.split('#')[0]!;
  return agent === 'orin' ? base : `${base}#${agent}`;
};

async function waitForTask(store: AgentStore, id: string, ms: number, signal: AbortSignal) {
  const end = Date.now() + ms;
  while (Date.now() < end && !signal.aborted) {
    const t = store.getTaskById(id);
    if (t && t.status !== 'queued' && t.status !== 'running') return t;
    // every background slot is busy: stop waiting so this run does not hold the slot it needs
    if (t?.status === 'queued' && Date.now() > end - ms + 60_000) return t;
    await new Promise((r) => setTimeout(r, 2000));
  }
  return store.getTaskById(id);
}

function teammateResult(t: NonNullable<ReturnType<AgentStore['getTaskById']>>, who: string): string {
  if (t.status === 'done') return `${who} finished:\n\n${(t.result ?? '').slice(0, 12000)}`;
  if (t.status === 'failed' || t.status === 'cancelled') return `${who}'s part did not finish (${t.status}): ${t.error ?? 'no reason given'}.`;
  return `${who} is still working on it (task id ${t.id}). Carry on with your own part, then call teammate_result with this id.`;
}

export const askTeammateTool = defineTool({
  name: 'ask_teammate',
  description:
    "Hand part of a job to a teammate (Orin, Nova, Sage or Max: the user's other agents). The teammate works on it in parallel in the background with its own computer, tools and memory, and the result comes back to you. Good for splitting big work (one researches while you build, one reviews your code, one writes the copy). Give complete instructions: the teammate does not see this chat. Set wait_seconds to wait for the result (up to 9 minutes), or 0 to keep working and collect it later with teammate_result.",
  schema: z.object({
    teammate: z.enum(TEAM),
    instructions: z.string().min(10).max(8000).describe('Self-contained instructions and everything the teammate needs'),
    title: z.string().min(2).max(100).optional(),
    wait_seconds: z.number().int().min(0).max(540).optional().describe('Default 240'),
  }),
  label: (a) => `Asking ${nameOf(a.teammate)}…`,
  needs: needsWorker,
  timeoutMs: 600_000,
  handler: async (a, ctx) => {
    const me = agentOfOwner(ctx.owner);
    if (a.teammate === me) return { ok: false, content: 'That is you. Pick another teammate, or do it yourself.', summary: 'Pick another teammate' };
    // a teammate does its own part; it does not hand work on again (no chains that wait on each other)
    if (ctx.taskId && ctx.services.store.getTaskById(ctx.taskId)?.input.teamFrom) return { ok: false, content: 'You are already doing a part for a teammate: finish it yourself.', summary: 'Do this part yourself' };
    const target = ownerFor(ctx.owner, a.teammate);
    const who = nameOf(a.teammate);
    const title = (a.title || a.instructions.split('\n')[0]!).slice(0, 100);
    const prompt = `${nameOf(me)}, your teammate on the user's team, handed you this part of a job:\n\n${a.instructions}\n\nDo it fully with your tools and give a complete, self-contained result: it goes back to ${nameOf(me)}, who finishes the job for the user. Ask the user before anything that sends, buys, posts, books or deletes.`;
    const t = ctx.services.store.createTask(target, 'agent', `From ${nameOf(me)}: ${title}`, { prompt, saveAsNote: false, timezone: ctx.timezone, teamFrom: ctx.owner });
    ctx.services.store.addTaskEvent(t.id, 'queued', `${nameOf(me)} handed this over`);
    ctx.services.enqueue?.(t.id);
    if (ctx.taskId) ctx.services.store.addTaskEvent(ctx.taskId, 'note', `Handed a part to ${who}`);
    const wait = (a.wait_seconds ?? 240) * 1000;
    if (!wait) return { content: `${who} started (task id ${t.id}). Collect the result with teammate_result.`, summary: `${who} is on it`, display: { kind: 'task', id: t.id, title: t.title, status: t.status } };
    const done = await waitForTask(ctx.services.store, t.id, wait, ctx.signal);
    return { content: teammateResult(done ?? t, who), summary: done?.status === 'done' ? `${who} finished` : `${who} is still working`, ok: done?.status !== 'failed' };
  },
});

export const teammateResultTool = defineTool({
  name: 'teammate_result',
  description: 'Get the result of work you handed to a teammate with ask_teammate (waits up to wait_seconds if it is still running).',
  schema: z.object({ task_id: z.string().min(8).max(80), wait_seconds: z.number().int().min(0).max(540).optional() }),
  label: () => 'Checking on a teammate…',
  needs: needsWorker,
  timeoutMs: 600_000,
  handler: async (a, ctx) => {
    const t = ctx.services.store.getTaskById(a.task_id);
    if (!t || t.input.teamFrom !== ctx.owner) return { ok: false, content: 'No handed-over task with that id.', summary: 'Not found' };
    const done = a.wait_seconds ? await waitForTask(ctx.services.store, t.id, a.wait_seconds * 1000, ctx.signal) : t;
    return { content: teammateResult(done ?? t, nameOf(agentOfOwner(t.owner))), summary: done?.status === 'done' ? 'Result in' : 'Still working' };
  },
});

export const powerTools: ToolDef[] = [createGoalTool, updateGoalTool, listGoalsTool, askTeammateTool, teammateResultTool];

/** The Activity page's overview of goals for one agent. */
export function goalsOverview(store: AgentStore, owner: string) {
  return listGoals(store, owner).map((g) => ({ ...g, progress: goalProgress(g), checkIns: checkInsOf(store, owner, g) }));
}
