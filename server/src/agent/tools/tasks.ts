import { z } from 'zod';
import { defineTool, type AgentServices } from './types.js';
import { isValidTimezone, nextCronRun } from '../cron.js';
import type { Schedule } from '../store.js';
import { amendments, taskKey } from '../amendments.js';
import { ensureBuiltinSkills } from '../builtinSkills.js';

export function computeNextRun(s: Pick<Schedule, 'cron' | 'intervalSec' | 'timezone'> & { runAt?: number | null }, from: number): number {
  if (s.runAt && !s.cron && !s.intervalSec) {
    if (s.runAt <= from) throw new Error('That time has already passed.');
    return s.runAt;
  }
  if (s.intervalSec) return from + s.intervalSec * 1000;
  if (s.cron) return nextCronRun(s.cron, from, s.timezone || 'UTC');
  throw new Error('A schedule needs a cron expression or an interval.');
}

function enqueue(svc: AgentServices, id: string) {
  svc.enqueue?.(id);
}

export const createTaskTool = defineTool({
  name: 'create_task',
  description:
    'Start a background task for work that takes many steps or minutes (multi-step research, compiling information, writing a long document). It runs on the server with its own tools; the user is notified when it finishes. Tell the user you started it.',
  schema: z.object({
    title: z.string().min(2).max(120).describe('Short name shown in the Tasks screen'),
    instructions: z.string().min(5).max(8000).describe('Complete, self-contained instructions for the background agent'),
    save_as_note: z.boolean().optional().describe('Save the final result as a note (default true)'),
  }),
  label: () => 'Starting a background task…',
  interactiveOnly: true,
  needs: ({ services }) => (services.config.agent.worker ? null : 'WORKER_ENABLED=1'),
  handler: async (a, ctx) => {
    const t = ctx.services.store.createTask(ctx.owner, 'agent', a.title, { prompt: a.instructions, saveAsNote: a.save_as_note ?? true, timezone: ctx.timezone, conversationId: ctx.conversationId });
    enqueue(ctx.services, t.id);
    return { content: `Background task started (id ${t.id}): "${t.title}". The user will get a notification when it is done; they can follow it in Tasks.`, summary: 'Task started', display: { kind: 'task', id: t.id, title: t.title, status: t.status } };
  },
});

export const deepResearchTool = defineTool({
  name: 'deep_research',
  description:
    'Run deep research in the background: several web searches, reading the best sources, and a report written up as a page (numbered citations linked to a sources list) that arrives in this chat as a card with the key findings. Use for questions that need a thorough, sourced answer. Tell the user it has started and that they will be notified.',
  schema: z.object({
    question: z.string().min(5).max(1000),
    depth: z.enum(['quick', 'standard', 'thorough']).optional().describe('quick: ~3 sources, standard: ~6, thorough: ~10'),
  }),
  label: () => 'Starting deep research…',
  interactiveOnly: true,
  needs: ({ services }) => (services.config.agent.worker ? null : 'WORKER_ENABLED=1'),
  handler: async (a, ctx) => {
    const t = ctx.services.store.createTask(ctx.owner, 'deep_research', `Research: ${a.question.slice(0, 100)}`, { question: a.question, depth: a.depth ?? 'standard', timezone: ctx.timezone, conversationId: ctx.conversationId });
    enqueue(ctx.services, t.id);
    return { content: `Deep research started (task id ${t.id}). When it finishes (usually 1–3 minutes) the key findings and a card that opens the full page arrive in this chat on their own. Tell the user that in one short line; do not wait for it.`, summary: 'Research started', display: { kind: 'task', id: t.id, title: t.title, status: t.status } };
  },
});

export const taskStatusTool = defineTool({
  name: 'task_status',
  description: 'Check background tasks: pass an id for one task (with its result), or nothing for the recent list.',
  schema: z.object({ id: z.string().optional() }),
  label: () => 'Checking tasks…',
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    if (a.id) {
      const t = st.getTask(ctx.owner, a.id);
      if (!t) return { ok: false, content: 'No task with that id.', summary: 'Task not found' };
      return { content: `Task "${t.title}": ${t.status}.${t.result ? `\nResult:\n${t.result.slice(0, 6000)}` : ''}${t.error ? `\nError: ${t.error}` : ''}`, summary: `Task ${t.status}`, display: { kind: 'task', id: t.id, title: t.title, status: t.status } };
    }
    const list = st.listTasks(ctx.owner, { limit: 10 });
    if (!list.length) return { content: 'No background tasks yet.', summary: 'No tasks' };
    return { content: list.map((t) => `- ${t.title} (id ${t.id}): ${t.status}`).join('\n'), summary: `${list.length} tasks` };
  },
});

export const addToTaskTool = defineTool({
  name: 'add_to_task',
  description:
    'Pass something the user just said to a background task that is still RUNNING (or waiting to start), so that task takes it into account at its next step: a change, an addition, a correction or a detail for that work. Use it instead of starting the same work again. The task posts its own result; tell the user in a few words that it will be included.',
  schema: z.object({
    id: z.string().min(4).max(80).describe('The running task id (from the work list or task_status)'),
    message: z.string().min(1).max(4000).describe("What to pass on, in the user's own words where you can"),
  }),
  label: () => 'Passing that on…',
  interactiveOnly: true,
  handler: async (a, ctx) => {
    const t = ctx.services.store.getTask(ctx.owner, a.id);
    if (!t) return { ok: false, content: 'No task with that id.', summary: 'Task not found' };
    if (t.status !== 'running' && t.status !== 'queued') return { ok: false, content: `That task is already ${t.status}, so it cannot take more input. Start new work for this instead, or tell the user.`, summary: `Task ${t.status}` };
    const key = amendments.add(taskKey(t.id), a.message);
    // the task may already have carried on as a next part: say where it went
    const to = key.startsWith('task:') ? key.slice(5) : t.id;
    return { content: `Passed to the task "${t.title}" (id ${to}). It takes it in at its next step and posts the result itself.`, summary: 'Passed on to the task', display: { kind: 'task', id: to, title: t.title, status: t.status } };
  },
});

export const saveSkillTool = defineTool({
  name: 'save_skill',
  writes: true,
  description: 'Create or update a skill: a named, reusable set of instructions the user can run any time ("run my morning brief") or on a schedule.',
  schema: z.object({
    name: z.string().min(2).max(80),
    description: z.string().max(300).optional(),
    instructions: z.string().min(5).max(8000).describe('Step-by-step instructions the agent follows when the skill runs'),
  }),
  label: (a) => `Saving skill “${a.name}”…`,
  handler: async (a, ctx) => {
    const s = ctx.services.store.upsertSkill(ctx.owner, { name: a.name, description: a.description ?? '', instructions: a.instructions });
    return { content: `Skill saved: "${s.name}" (id ${s.id}).`, summary: 'Skill saved', display: { kind: 'skill', id: s.id, name: s.name } };
  },
});

export const runSkillTool = defineTool({
  name: 'run_skill',
  description: 'Run a saved skill by name or id as a background task.',
  schema: z.object({ name_or_id: z.string().min(1).max(100), extra: z.string().max(2000).optional().describe('Extra context for this run') }),
  label: () => 'Running skill…',
  interactiveOnly: true,
  needs: ({ services }) => (services.config.agent.worker ? null : 'WORKER_ENABLED=1'),
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    ensureBuiltinSkills(st, ctx.owner);
    let skill = st.findSkill(ctx.owner, a.name_or_id);
    if (!skill) {
      ensureBuiltinSkills(st, ctx.owner, a.name_or_id);
      skill = st.findSkill(ctx.owner, a.name_or_id);
    }
    if (!skill) return { ok: false, content: `No skill called "${a.name_or_id}". Skills: ${st.listSkills(ctx.owner).map((s) => s.name).join(', ') || 'none'}.`, summary: 'Skill not found' };
    const t = st.createTask(ctx.owner, 'skill', skill.name, { skillId: skill.id, extra: a.extra ?? '', timezone: ctx.timezone });
    enqueue(ctx.services, t.id);
    return { content: `Skill "${skill.name}" is running as task ${t.id}.`, summary: 'Skill running', display: { kind: 'task', id: t.id, title: t.title, status: t.status } };
  },
});

export const listSkillsTool = defineTool({
  name: 'list_skills',
  description: 'List the user\'s saved skills and schedules (routines).',
  schema: z.object({}),
  label: () => 'Checking skills…',
  handler: async (_a, ctx) => {
    const st = ctx.services.store;
    ensureBuiltinSkills(st, ctx.owner);
    const skills = st.listSkills(ctx.owner);
    const schedules = st.listSchedules(ctx.owner);
    return {
      content: `Skills:\n${skills.map((s) => `- ${s.name} (id ${s.id}): ${s.description}`).join('\n') || '(none)'}\n\nSchedules:\n${schedules.map((s) => `- ${s.title} (id ${s.id}) ${s.cron ? `cron "${s.cron}" ${s.timezone}` : `every ${s.intervalSec}s`}, ${s.enabled ? 'on' : 'paused'}, next ${new Date(s.nextRunAt).toISOString()}`).join('\n') || '(none)'}`,
      summary: `${skills.length} skills, ${schedules.length} schedules`,
    };
  },
});

export const createScheduleTool = defineTool({
  name: 'create_schedule',
  description:
    'Run the agent automatically later, unattended, and post the result to the user\'s chat. For ONE run at a set time ("in 3 minutes look up X and tell me", "tomorrow at 9 check Y") give run_at_minutes or once_at, never a cron: a cron with a day and month repeats every year. ' +
    'For a routine ("every weekday at 8am summarise tech news") give a 5-field cron in the user\'s timezone, or every_minutes. A plain reminder with nothing to do is create_reminder; anything that has to look something up or do work at that time belongs here.',
  schema: z.object({
    title: z.string().min(2).max(120),
    instructions: z.string().min(5).max(8000).describe('What the agent should do each run (self-contained)'),
    cron: z.string().max(100).optional().describe('e.g. "0 8 * * 1-5" = 8:00 on weekdays'),
    every_minutes: z.number().int().min(1).max(10080).optional(),
    run_at_minutes: z.number().min(1).max(525600).optional().describe('One run, this many minutes from now'),
    once_at: z.string().max(40).optional().describe('One run at this local date and time, ISO like 2026-11-16T09:00 (user\'s timezone)'),
    timezone: z.string().max(60).optional().describe('IANA timezone; defaults to the user\'s'),
    skill: z.string().max(100).optional().describe('Run this saved skill instead of instructions'),
  }),
  label: (a) => `Scheduling “${a.title}”…`,
  needs: ({ services }) => (services.config.agent.worker ? null : 'WORKER_ENABLED=1'),
  handler: async (a, ctx) => {
    const svc = ctx.services;
    const tz = a.timezone || ctx.timezone || 'UTC';
    if (!isValidTimezone(tz)) return { ok: false, content: `Unknown timezone "${tz}".`, summary: 'Bad timezone' };
    let runAt: number | null = null;
    if (a.run_at_minutes) runAt = Date.now() + Math.round(a.run_at_minutes * 60_000);
    else if (a.once_at) {
      const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{1,2}):(\d{2})/.exec(a.once_at);
      if (!m) return { ok: false, content: 'once_at must look like 2026-11-16T09:00.', summary: 'Bad time' };
      runAt = localToUtc(+m[1]!, +m[2]!, +m[3]!, +m[4]!, +m[5]!, tz);
    }
    if (runAt !== null) {
      if (runAt <= Date.now()) return { ok: false, content: 'That time has already passed. Ask the user which time they meant.', summary: 'Time passed' };
      if (a.cron || a.every_minutes) return { ok: false, content: 'Give either a one-time run (run_at_minutes / once_at) or a repeat (cron / every_minutes), not both.', summary: 'Both given' };
    }
    if (!a.cron && !a.every_minutes && runAt === null) return { ok: false, content: 'Give run_at_minutes or once_at for one run, or cron / every_minutes for a routine. Ask the user when if unclear.', summary: 'Needs a time' };
    const intervalSec = a.every_minutes ? Math.max(a.every_minutes * 60, svc.config.agent.scheduleMinIntervalSec) : null;
    let skillId: string | null = null;
    if (a.skill) {
      const sk = svc.store.findSkill(ctx.owner, a.skill);
      if (!sk) return { ok: false, content: `No skill called "${a.skill}".`, summary: 'Skill not found' };
      skillId = sk.id;
    }
    let next: number;
    try {
      next = computeNextRun({ cron: a.cron ?? null, intervalSec, timezone: tz, runAt }, Date.now());
    } catch (e) {
      return { ok: false, content: `Invalid schedule: ${(e as Error).message}`, summary: 'Invalid schedule' };
    }
    const s = svc.store.createSchedule(ctx.owner, { title: a.title, prompt: a.instructions, skillId, cron: a.cron ?? null, intervalSec, timezone: tz, enabled: true, nextRunAt: next });
    const when = new Date(next).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
    if (runAt !== null)
      return { content: `One-time run scheduled (id ${s.id}) for ${when} (${tz}). It runs once, posts the result to the user's chat, then switches off.`, summary: `Runs once at ${when}`, display: { kind: 'schedule', id: s.id, title: s.title, nextRunAt: next } };
    return { content: `Schedule created (id ${s.id}). First run: ${when} (${tz}).`, summary: `Scheduled, first run ${when}`, display: { kind: 'schedule', id: s.id, title: s.title, nextRunAt: next } };
  },
});

export const deleteScheduleTool = defineTool({
  name: 'delete_schedule',
  description: 'Delete (or pause with pause=true) a schedule by id.',
  schema: z.object({ id: z.string().min(1), pause: z.boolean().optional() }),
  label: () => 'Updating schedule…',
  approval: (a, ctx) => {
    if (a.pause) return null;
    const s = ctx.services.store.getSchedule(ctx.owner, a.id);
    return s ? { title: 'Delete schedule', body: `Orin wants to delete the schedule "${s.title}". It will stop running.`, fields: [{ label: 'Schedule', value: s.title }] } : null;
  },
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    if (a.pause) {
      const s = st.updateSchedule(ctx.owner, a.id, { enabled: false });
      return s ? { content: 'Schedule paused.', summary: 'Schedule paused' } : { ok: false, content: 'No schedule with that id.', summary: 'Not found' };
    }
    return st.deleteSchedule(ctx.owner, a.id) ? { content: 'Schedule deleted.', summary: 'Schedule deleted' } : { ok: false, content: 'No schedule with that id.', summary: 'Not found' };
  },
});

/** A wall-clock time in an IANA zone -> epoch ms (two passes settle DST edges). */
export function localToUtc(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const want = Date.UTC(y, mo - 1, d, h, mi);
  let t = want;
  for (let i = 0; i < 2; i++) {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(t)).map((x) => [x.type, x.value]));
    const seen = Date.UTC(+p.year!, +p.month! - 1, +p.day!, +p.hour!, +p.minute!);
    t += want - seen;
  }
  return t;
}
