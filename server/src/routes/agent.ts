import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { agentOwnerKey } from '../middleware/auth.js';
import { parseBody } from './util.js';
import { capabilityReport } from '../agent/capabilities.js';
import { computeNextRun } from '../agent/tools/tasks.js';
import { isValidTimezone } from '../agent/cron.js';
import { listConnectors, googleAuthUrl, googleConfigured } from '../agent/connectors.js';
import { requestBaseUrl } from './agentChat.js';

const owner = (req: Request) => agentOwnerKey(req);
const idParam = (req: Request) => String(req.params.id ?? '');

const NoteBody = z.object({ title: z.string().trim().min(1).max(200), body: z.string().max(200_000).default('') });
const NotePatch = z.object({ title: z.string().trim().min(1).max(200).optional(), body: z.string().max(200_000).optional() });
const MemoryBody = z.object({ text: z.string().trim().min(2).max(500) });
const TaskBody = z.object({
  kind: z.enum(['agent', 'deep_research']).default('agent'),
  title: z.string().trim().min(2).max(120).optional(),
  prompt: z.string().trim().min(3).max(8000),
  timezone: z.string().max(60).optional(),
  saveAsNote: z.boolean().optional(),
  conversationId: z.string().max(80).optional(),
});
const SkillBody = z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(300).default(''), instructions: z.string().trim().min(5).max(8000) });
const ScheduleBody = z
  .object({
    title: z.string().trim().min(2).max(120),
    prompt: z.string().trim().max(8000).default(''),
    skillId: z.string().optional(),
    cron: z.string().max(100).optional(),
    intervalSec: z.number().int().positive().max(7 * 86400).optional(),
    /** one-time run at this moment (ms) */
    runAt: z.number().int().positive().optional(),
    timezone: z.string().max(60).default('UTC'),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.cron || v.intervalSec || v.runAt, { message: 'Give a time: once, cron or intervalSec' })
  .refine((v) => v.prompt || v.skillId, { message: 'Give a prompt or a skill' });
const SchedulePatch = z.object({
  enabled: z.boolean().optional(),
  title: z.string().trim().min(2).max(120).optional(),
  prompt: z.string().max(8000).optional(),
  cron: z.string().trim().max(100).nullable().optional(),
  intervalSec: z.number().int().min(60).max(31 * 86400).nullable().optional(),
  timezone: z.string().trim().max(60).optional(),
  skillId: z.string().nullable().optional(),
  runAt: z.number().int().positive().nullable().optional(),
});

/** REST surface for the app's Tasks, Notes, Memory, Reminders, Skills/Routines, Connected apps and capabilities screens. */
export function agentRouter(deps: Deps): Router {
  const r = Router();
  const agent = deps.agent!;
  const st = agent.store;

  r.get('/agent/capabilities', (req, res) => {
    res.json({
      capabilities: capabilityReport(deps.config, deps.providers, agent, owner(req)),
      tools: agent.tools.status(owner(req), agent.services),
      model: { provider: deps.config.chat.provider, name: deps.config.chat.displayName, strong: deps.config.chat.model, fast: deps.config.chat.fastModel, caps: deps.config.chat.caps },
    });
  });

  // ---- memory
  r.get('/agent/memories', (req, res) => res.json({ memories: st.listMemories(owner(req)) }));
  r.post('/agent/memories', (req, res) => {
    const b = parseBody(MemoryBody, req.body);
    res.status(201).json({ memory: st.addMemory(owner(req), b.text) });
  });
  r.delete('/agent/memories/:id', (req, res) => {
    if (!st.deleteMemory(owner(req), idParam(req))) throw new AppError('not_found', 'Memory not found.');
    res.json({ ok: true });
  });
  r.delete('/agent/memories', (req, res) => res.json({ deleted: st.clearMemories(owner(req)) }));

  // ---- notes
  r.get('/agent/notes', (req, res) => res.json({ notes: st.listNotes(owner(req), String(req.query.q ?? ''), 200) }));
  r.get('/agent/notes/:id', (req, res) => {
    const n = st.getNote(owner(req), idParam(req));
    if (!n) throw new AppError('not_found', 'Note not found.');
    res.json({ note: n });
  });
  r.post('/agent/notes', (req, res) => {
    const b = parseBody(NoteBody, req.body);
    res.status(201).json({ note: st.createNote(owner(req), b.title, b.body, 'app') });
  });
  r.post('/agent/notes/:id', (req, res) => {
    const b = parseBody(NotePatch, req.body);
    const n = st.updateNote(owner(req), idParam(req), b);
    if (!n) throw new AppError('not_found', 'Note not found.');
    res.json({ note: n });
  });
  r.delete('/agent/notes/:id', (req, res) => {
    if (!st.deleteNote(owner(req), idParam(req))) throw new AppError('not_found', 'Note not found.');
    res.json({ ok: true });
  });

  // ---- reminders (the phone schedules the local notification)
  r.get('/agent/reminders', (req, res) => {
    const status = req.query.status === 'scheduled' ? 'scheduled' : undefined;
    res.json({ reminders: st.listReminders(owner(req), status) });
  });
  r.post('/agent/reminders/:id/done', (req, res) => {
    if (!st.setReminderStatus(owner(req), idParam(req), 'done')) throw new AppError('not_found', 'Reminder not found.');
    res.json({ ok: true });
  });
  r.delete('/agent/reminders/:id', (req, res) => {
    if (!st.setReminderStatus(owner(req), idParam(req), 'cancelled')) throw new AppError('not_found', 'Reminder not found.');
    res.json({ ok: true });
  });

  // ---- background tasks
  r.get('/agent/tasks', (req, res) => {
    res.json({ tasks: st.listTasks(owner(req), { status: typeof req.query.status === 'string' ? req.query.status : undefined, unacked: req.query.unacked === '1', limit: Math.min(Number(req.query.limit) || 50, 200) }) });
  });
  r.get('/agent/tasks/:id', (req, res) => {
    const t = st.getTask(owner(req), idParam(req));
    if (!t) throw new AppError('not_found', 'Task not found.');
    res.json({ task: t });
  });
  r.post('/agent/tasks', (req, res) => {
    if (!agent.enabled) throw new AppError('provider_not_configured', 'No tool-capable AI model is configured on the server.');
    const b = parseBody(TaskBody, req.body);
    const t =
      b.kind === 'deep_research'
        ? st.createTask(owner(req), 'deep_research', b.title ?? `Research: ${b.prompt.slice(0, 100)}`, { question: b.prompt, depth: 'standard', timezone: b.timezone, conversationId: b.conversationId })
        : st.createTask(owner(req), 'agent', b.title ?? b.prompt.slice(0, 80), { prompt: b.prompt, timezone: b.timezone, saveAsNote: b.saveAsNote ?? false, conversationId: b.conversationId });
    agent.kick();
    res.status(201).json({ task: t });
  });
  r.post('/agent/tasks/:id/cancel', (req, res) => {
    if (!agent.cancelTask(owner(req), idParam(req))) throw new AppError('not_found', 'No running task with that id.');
    res.json({ ok: true });
  });
  r.post('/agent/tasks/:id/ack', (req, res) => {
    st.ackTask(owner(req), idParam(req));
    res.json({ ok: true });
  });

  // ---- skills
  r.get('/agent/skills', (req, res) => res.json({ skills: st.listSkills(owner(req)) }));
  r.post('/agent/skills', (req, res) => {
    const b = parseBody(SkillBody, req.body);
    res.status(201).json({ skill: st.upsertSkill(owner(req), b) });
  });
  r.post('/agent/skills/:id', (req, res) => {
    const b = parseBody(SkillBody, req.body);
    if (!st.getSkill(owner(req), idParam(req))) throw new AppError('not_found', 'Skill not found.');
    res.json({ skill: st.upsertSkill(owner(req), { ...b, id: idParam(req) }) });
  });
  r.post('/agent/skills/:id/run', (req, res) => {
    if (!agent.enabled) throw new AppError('provider_not_configured', 'No tool-capable AI model is configured on the server.');
    const sk = st.getSkill(owner(req), idParam(req));
    if (!sk) throw new AppError('not_found', 'Skill not found.');
    const tz = typeof req.body?.timezone === 'string' ? (req.body.timezone as string) : undefined;
    const t = st.createTask(owner(req), 'skill', sk.name, { skillId: sk.id, timezone: tz, saveAsNote: false });
    agent.kick();
    res.status(201).json({ task: t });
  });
  r.delete('/agent/skills/:id', (req, res) => {
    if (!st.deleteSkill(owner(req), idParam(req))) throw new AppError('not_found', 'Skill not found.');
    res.json({ ok: true });
  });

  // ---- schedules (routines)
  r.get('/agent/schedules', (req, res) => res.json({ schedules: st.listSchedules(owner(req)) }));
  r.post('/agent/schedules', (req, res) => {
    const b = parseBody(ScheduleBody, req.body);
    if (!isValidTimezone(b.timezone)) throw new AppError('validation_error', 'Unknown timezone.');
    if (b.skillId && !st.getSkill(owner(req), b.skillId)) throw new AppError('not_found', 'Skill not found.');
    const intervalSec = b.intervalSec ? Math.max(b.intervalSec, deps.config.agent.scheduleMinIntervalSec) : null;
    let next: number;
    try {
      next = computeNextRun({ cron: b.cron ?? null, intervalSec, timezone: b.timezone, runAt: b.runAt ?? null }, Date.now());
    } catch (e) {
      throw new AppError('validation_error', (e as Error).message);
    }
    const s = st.createSchedule(owner(req), { title: b.title, prompt: b.prompt, skillId: b.skillId ?? null, cron: b.cron ?? null, intervalSec, timezone: b.timezone, enabled: b.enabled, nextRunAt: next });
    res.status(201).json({ schedule: s });
  });
  r.post('/agent/schedules/:id', (req, res) => {
    const b = parseBody(SchedulePatch, req.body);
    const cur = st.getSchedule(owner(req), idParam(req));
    if (!cur) throw new AppError('not_found', 'Schedule not found.');
    const patch: Parameters<typeof st.updateSchedule>[2] = { ...b };
    const timing = b.cron !== undefined || b.intervalSec !== undefined || b.timezone !== undefined;
    delete (patch as { runAt?: unknown }).runAt;
    if (b.runAt) {
      if (b.runAt <= Date.now()) throw new AppError('validation_error', 'That time has already passed.');
      Object.assign(patch, { cron: null, intervalSec: null, nextRunAt: b.runAt, enabled: b.enabled ?? true });
    } else if (timing) {
      const next = { cron: b.cron !== undefined ? b.cron : b.intervalSec ? null : cur.cron, intervalSec: b.intervalSec !== undefined ? b.intervalSec : b.cron ? null : cur.intervalSec, timezone: b.timezone ?? cur.timezone };
      if (!next.cron && !next.intervalSec) throw new AppError('validation_error', 'Give a cron expression or an interval.');
      if (next.intervalSec) next.intervalSec = Math.max(next.intervalSec, agent.config.agent.scheduleMinIntervalSec);
      try {
        patch.nextRunAt = computeNextRun(next, Date.now());
      } catch (e) {
        throw new AppError('validation_error', `Invalid schedule: ${(e as Error).message}`);
      }
      Object.assign(patch, next);
    } else if (b.enabled && !cur.enabled) {
      if (!cur.cron && !cur.intervalSec) {
        if (cur.nextRunAt <= Date.now()) throw new AppError('validation_error', 'This one-time schedule already ran. Pick a new time to turn it back on.');
      } else patch.nextRunAt = computeNextRun(cur, Date.now());
    }
    res.json({ schedule: st.updateSchedule(owner(req), cur.id, patch) });
  });
  r.delete('/agent/schedules/:id', (req, res) => {
    if (!st.deleteSchedule(owner(req), idParam(req))) throw new AppError('not_found', 'Schedule not found.');
    res.json({ ok: true });
  });

  // ---- connectors
  r.get('/connectors', (req, res) => res.json({ connectors: listConnectors(agent.services, st, owner(req)) }));
  r.post('/connectors/google/start', (req, res) => {
    if (!googleConfigured(agent.services)) throw new AppError('provider_not_configured', 'Google is not set up on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
    res.json({ url: googleAuthUrl(agent.services, owner(req), requestBaseUrl(req)) });
  });
  r.delete('/connectors/google', (req, res) => {
    st.deleteConnection(owner(req), 'google');
    res.json({ ok: true });
  });

  return r;
}
