import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { agentOwnerKey, agentOwners, requesterKey } from '../middleware/auth.js';
import { chatRuns } from '../agent/chatRuns.js';
import { parseBody } from './util.js';
import { capabilityReport } from '../agent/capabilities.js';
import { computeNextRun } from '../agent/tools/tasks.js';
import { isValidTimezone } from '../agent/cron.js';
import { parseWhen, whenTextFor, WhenError, type WhenResult } from '../agent/whenParse.js';
import { listConnectors, googleAuthUrl, googleConfigured } from '../agent/connectors.js';
import { connectTokenApp, tokenApp, type TokenAppId } from '../agent/tokenApps.js';
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
// name is optional (the New skill form marks it so): a blank one is taken from the instructions
const SkillBody = z.object({ name: z.string().trim().max(80).default(''), description: z.string().max(300).default(''), instructions: z.string().trim().min(5, 'Add instructions for this skill.').max(8000) });

/** A short name from the first words of some instructions ("Check my inbox and …" -> "Check my inbox and"). */
function nameFrom(text: string, max = 48): string {
  const first = text.replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s/)[0] ?? '';
  const words = first.replace(/[.!?:;,]+$/, '').split(' ');
  let out = '';
  for (const w of words.slice(0, 7)) {
    if ((out + ' ' + w).trim().length > max) break;
    out = (out + ' ' + w).trim();
  }
  out = out || first.slice(0, max);
  // don't end on a joining word ("Check my calendar for the week and")
  out = out.replace(/(\s+(and|or|the|a|an|to|for|of|with|in|on|at|my|your|then))+$/i, '') || out;
  return out.charAt(0).toUpperCase() + out.slice(1);
}
const ScheduleBody = z
  .object({
    /** optional in the New schedule form: a blank one is taken from "What to run" */
    title: z.string().trim().max(120).default(''),
    /** "When to run" in plain words ("Weekdays at 8 AM"); the server reads it into cron / interval / once */
    when: z.string().trim().max(200).optional(),
    prompt: z.string().trim().max(8000).default(''),
    skillId: z.string().optional(),
    cron: z.string().max(100).optional(),
    intervalSec: z.number().int().positive().max(7 * 86400).optional(),
    /** one-time run at this moment (ms) */
    runAt: z.number().int().positive().optional(),
    timezone: z.string().max(60).default('UTC'),
    enabled: z.boolean().default(true),
  })
  .refine((v) => v.when || v.cron || v.intervalSec || v.runAt, { message: 'Say when it should run, for example "Weekdays at 8 AM".' })
  .refine((v) => v.prompt || v.skillId, { message: 'Add what it should do when it runs.' });
const SchedulePatch = z.object({
  enabled: z.boolean().optional(),
  when: z.string().trim().max(200).optional(),
  title: z.string().trim().max(120).optional(),
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
  // "reply:<run id>" is work done inside a chat reply, listed in Activity next to the stored tasks
  // (see chatRuns.activity). It opens, stops and acks through the same routes, so every app build works.
  const replyRow = (req: Request) => {
    const id = idParam(req);
    for (const o of agentOwners(requesterKey(req))) {
      const a = chatRuns.activity(o).find((x) => x.id === id);
      if (a) return a;
    }
    return null;
  };
  r.get('/agent/tasks/:id', (req, res) => {
    if (idParam(req).startsWith('reply:')) {
      const a = replyRow(req);
      if (!a) throw new AppError('not_found', 'That work is no longer listed. Its reply is in the chat.');
      return void res.json({ task: a });
    }
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
    if (idParam(req).startsWith('reply:')) {
      const run = chatRuns.get(idParam(req).slice(6), requesterKey(req));
      if (!run || run.done) throw new AppError('not_found', 'No running task with that id.');
      run.controller.abort();
      return void res.json({ ok: true });
    }
    if (!agent.cancelTask(owner(req), idParam(req))) throw new AppError('not_found', 'No running task with that id.');
    res.json({ ok: true });
  });
  r.post('/agent/tasks/:id/ack', (req, res) => {
    if (idParam(req).startsWith('reply:')) return void res.json({ ok: true });
    st.ackTask(owner(req), idParam(req));
    res.json({ ok: true });
  });

  // ---- skills
  r.get('/agent/skills', (req, res) => res.json({ skills: st.listSkills(owner(req)) }));
  const skillName = (b: { name: string; instructions: string }) => {
    const name = (b.name || nameFrom(b.instructions)).slice(0, 80);
    if (name.length < 2) throw new AppError('validation_error', 'Give the skill a name.');
    return name;
  };
  r.post('/agent/skills', (req, res) => {
    const b = parseBody(SkillBody, req.body);
    const name = skillName(b);
    // creating never overwrites: a skill with that name already exists -> say so instead of replacing it
    const same = st.listSkills(owner(req)).find((k) => k.name.toLowerCase() === name.toLowerCase());
    if (same) throw new AppError('validation_error', `You already have a skill called "${same.name}". Pick another name, or edit that one.`);
    res.status(201).json({ skill: st.upsertSkill(owner(req), { ...b, name }) });
  });
  r.post('/agent/skills/:id', (req, res) => {
    const b = parseBody(SkillBody, req.body);
    if (!st.getSkill(owner(req), idParam(req))) throw new AppError('not_found', 'Skill not found.');
    const name = skillName(b);
    const same = st.listSkills(owner(req)).find((k) => k.id !== idParam(req) && k.name.toLowerCase() === name.toLowerCase());
    if (same) throw new AppError('validation_error', `You already have a skill called "${same.name}". Pick another name.`);
    res.json({ skill: st.upsertSkill(owner(req), { ...b, name, id: idParam(req) }) });
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
  /** each schedule with its timing in words (what the edit form's "When to run" shows) */
  const withWhen = <S extends { cron: string | null; intervalSec: number | null; nextRunAt: number; timezone: string }>(s: S) => ({ ...s, whenText: whenTextFor(s) });
  const readWhen = (text: string, timezone: string): WhenResult => {
    try {
      return parseWhen(text, timezone, Date.now(), deps.config.agent.scheduleMinIntervalSec);
    } catch (e) {
      if (e instanceof WhenError) throw new AppError('validation_error', e.message);
      throw e;
    }
  };
  r.get('/agent/schedules', (req, res) => res.json({ schedules: st.listSchedules(owner(req)).map(withWhen) }));
  // live read-back under "When to run" while the user types (nothing is saved)
  r.post('/agent/schedules/preview-when', (req, res) => {
    const b = parseBody(z.object({ when: z.string().max(200), timezone: z.string().max(60).default('UTC') }), req.body);
    if (!isValidTimezone(b.timezone)) throw new AppError('validation_error', 'Unknown timezone.');
    try {
      const w = parseWhen(b.when, b.timezone, Date.now(), deps.config.agent.scheduleMinIntervalSec);
      const nextRunAt = computeNextRun({ cron: w.kind === 'cron' ? w.cron : null, intervalSec: w.kind === 'interval' ? w.intervalSec : null, timezone: b.timezone, runAt: w.kind === 'once' ? w.runAt : null }, Date.now());
      res.json({ ok: true, kind: w.kind, summary: w.summary, repeats: w.kind !== 'once', nextRunAt });
    } catch (e) {
      res.json({ ok: false, error: (e as Error).message });
    }
  });
  r.post('/agent/schedules', (req, res) => {
    const b = parseBody(ScheduleBody, req.body);
    if (!isValidTimezone(b.timezone)) throw new AppError('validation_error', 'Unknown timezone.');
    if (b.skillId && !st.getSkill(owner(req), b.skillId)) throw new AppError('not_found', 'Skill not found.');
    const w = b.when ? readWhen(b.when, b.timezone) : null;
    const cron = w ? (w.kind === 'cron' ? w.cron : null) : (b.cron ?? null);
    const rawInterval = w ? (w.kind === 'interval' ? w.intervalSec : null) : (b.intervalSec ?? null);
    const runAt = w ? (w.kind === 'once' ? w.runAt : null) : (b.runAt ?? null);
    const intervalSec = rawInterval ? Math.max(rawInterval, deps.config.agent.scheduleMinIntervalSec) : null;
    let next: number;
    try {
      next = computeNextRun({ cron, intervalSec, timezone: b.timezone, runAt }, Date.now());
    } catch (e) {
      throw new AppError('validation_error', (e as Error).message);
    }
    const skill = b.skillId ? st.getSkill(owner(req), b.skillId) : null;
    const title = (b.title || (b.prompt ? nameFrom(b.prompt, 60) : skill?.name) || 'Schedule').slice(0, 120);
    const s = st.createSchedule(owner(req), { title, prompt: b.prompt, skillId: b.skillId ?? null, cron, intervalSec, timezone: b.timezone, enabled: b.enabled, nextRunAt: next });
    res.status(201).json({ schedule: withWhen(s) });
  });
  r.post('/agent/schedules/:id', (req, res) => {
    const b = parseBody(SchedulePatch, req.body);
    const cur = st.getSchedule(owner(req), idParam(req));
    if (!cur) throw new AppError('not_found', 'Schedule not found.');
    if (b.when !== undefined) {
      // "When to run" changed in the edit form: it replaces the timing whatever it was (once <-> repeating)
      const tzone = b.timezone ?? cur.timezone;
      if (!isValidTimezone(tzone)) throw new AppError('validation_error', 'Unknown timezone.');
      const w = readWhen(b.when, tzone);
      delete (b as { when?: unknown }).when;
      if (w.kind === 'once') Object.assign(b, { runAt: w.runAt, cron: undefined, intervalSec: undefined });
      else Object.assign(b, { runAt: undefined, cron: w.kind === 'cron' ? w.cron : null, intervalSec: w.kind === 'interval' ? w.intervalSec : null, timezone: tzone });
    }
    if (b.title !== undefined && !b.title) b.title = b.prompt ? nameFrom(b.prompt, 60) : cur.title;
    if (b.prompt !== undefined && !b.prompt.trim() && !cur.skillId) throw new AppError('validation_error', 'Add what it should do when it runs.');
    const patch: Parameters<typeof st.updateSchedule>[2] = { ...b };
    delete (patch as { when?: unknown }).when;
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
    res.json({ schedule: withWhen(st.updateSchedule(owner(req), cur.id, patch)!) });
  });
  r.delete('/agent/schedules/:id', (req, res) => {
    if (!st.deleteSchedule(owner(req), idParam(req))) throw new AppError('not_found', 'Schedule not found.');
    res.json({ ok: true });
  });

  // ---- connectors
  // the app calls /v1/agent/connectors/..., older clients and the docs /v1/connectors/...: both work
  for (const base of ['/connectors', '/agent/connectors']) {
    r.get(`${base}`, (req, res) => res.json({ connectors: listConnectors(agent.services, st, owner(req)) }));
    // Google sign-in (Gmail, Calendar and Drive share one Google grant)
    const googleStart = (req: Request, res: Response) => {
      if (!googleConfigured(agent.services)) throw new AppError('provider_not_configured', 'Google is not set up on the server. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET.');
      res.json({ url: googleAuthUrl(agent.services, owner(req), requestBaseUrl(req)) });
    };
    r.post(`${base}/google/start`, googleStart);
    r.post(`${base}/drive/start`, googleStart);
    // token apps (GitHub, Notion, Slack): the token is checked with the provider, then saved encrypted
    r.post(`${base}/:id/token`, async (req, res) => {
      const id = String(req.params.id);
      if (!tokenApp(id)) throw new AppError('not_found', 'That app does not connect with a token.');
      const token = (req.body as { token?: unknown } | undefined)?.token;
      if (typeof token !== 'string' || token.trim().length < 8 || token.length > 500 || /\s/.test(token.trim())) throw new AppError('validation_error', 'Paste the whole token (no spaces).');
      let account: string;
      try {
        account = await connectTokenApp(agent.services, owner(req), id as TokenAppId, token);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        throw new AppError('validation_error', `${tokenApp(id)!.name} did not accept that token. ${msg.includes('abort') ? 'It took too long to answer; try again.' : msg}`.trim());
      }
      res.json({ ok: true, id, account });
    });
    r.delete(`${base}/:id`, (req, res) => {
      const id = String(req.params.id);
      // Drive rides the Google grant: disconnecting it signs Google out (Gmail and Calendar too)
      const provider = id === 'drive' ? 'google' : id;
      if (provider !== 'google' && !tokenApp(provider)) throw new AppError('not_found', 'No such app.');
      st.deleteConnection(owner(req), provider);
      res.json({ ok: true });
    });
  }

  return r;
}
