import { z } from 'zod';
import { defineTool, type AgentServices } from './types.js';
import { isValidTimezone, nextCronRun } from '../cron.js';
import type { Schedule } from '../store.js';

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
    'Run deep research in the background: several web searches, reading the best sources, and a written Markdown report with citations saved as a note. Use for questions that need a thorough, sourced answer. Tell the user it has started and that they will be notified.',
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
    return { content: `Deep research started (task id ${t.id}). A report note will be saved and the user notified when it finishes (usually 1–3 minutes).`, summary: 'Research started', display: { kind: 'task', id: t.id, title: t.title, status: t.status } };
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
    const skill = st.findSkill(ctx.owner, a.name_or_id);
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
    'Create a routine that runs the agent automatically on a schedule (e.g. "every weekday at 8am summarise tech news"). Give a 5-field cron in the user\'s timezone, or every_minutes. Results appear in Tasks with a notification.',
  schema: z.object({
    title: z.string().min(2).max(120),
    instructions: z.string().min(5).max(8000).describe('What the agent should do each run (self-contained)'),
    cron: z.string().max(100).optional().describe('e.g. "0 8 * * 1-5" = 8:00 on weekdays'),
    every_minutes: z.number().int().min(1).max(10080).optional(),
    timezone: z.string().max(60).optional().describe('IANA timezone; defaults to the user\'s'),
    skill: z.string().max(100).optional().describe('Run this saved skill instead of instructions'),
  }),
  label: (a) => `Scheduling “${a.title}”…`,
  needs: ({ services }) => (services.config.agent.worker ? null : 'WORKER_ENABLED=1'),
  handler: async (a, ctx) => {
    const svc = ctx.services;
    const tz = a.timezone || ctx.timezone || 'UTC';
    if (!isValidTimezone(tz)) return { ok: false, content: `Unknown timezone "${tz}".`, summary: 'Bad timezone' };
    if (!a.cron && !a.every_minutes) return { ok: false, content: 'Give either cron or every_minutes. Ask the user how often if unclear.', summary: 'Needs a time' };
    const intervalSec = a.every_minutes ? Math.max(a.every_minutes * 60, svc.config.agent.scheduleMinIntervalSec) : null;
    let skillId: string | null = null;
    if (a.skill) {
      const sk = svc.store.findSkill(ctx.owner, a.skill);
      if (!sk) return { ok: false, content: `No skill called "${a.skill}".`, summary: 'Skill not found' };
      skillId = sk.id;
    }
    let next: number;
    try {
      next = computeNextRun({ cron: a.cron ?? null, intervalSec, timezone: tz }, Date.now());
    } catch (e) {
      return { ok: false, content: `Invalid schedule: ${(e as Error).message}`, summary: 'Invalid schedule' };
    }
    const s = svc.store.createSchedule(ctx.owner, { title: a.title, prompt: a.instructions, skillId, cron: a.cron ?? null, intervalSec, timezone: tz, enabled: true, nextRunAt: next });
    const when = new Date(next).toLocaleString('en-US', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' });
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
