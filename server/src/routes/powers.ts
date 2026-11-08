import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { agentOwnerKey } from '../middleware/auth.js';
import { parseBody } from './util.js';
import { isValidTimezone } from '../agent/cron.js';
import { CHECKIN_HOURS, createGoal, deleteGoal, getProactive, goalsOverview, listGoals, setGoalCheckIns, setProactive, updateGoal } from '../agent/powers.js';

const owner = (req: Request) => agentOwnerKey(req);
const idParam = (req: Request) => String(req.params.id ?? '');
const Every = z.enum(['off', 'daily', 'weekdays', 'weekly']);
const Tz = z.string().max(60).optional();

/** Goals (plan + progress + check-ins) and proactive mode (morning brief, quiet check-ins). */
export function powersRouter(deps: Deps): Router {
  const r = Router();
  const agent = deps.agent!;
  const st = agent.store;
  const worker = deps.config.agent.worker;
  const tzOf = (tz: string | undefined) => (tz && isValidTimezone(tz) ? tz : 'UTC');
  const needWorker = () => {
    if (!worker) throw new AppError('provider_not_configured', 'Check-ins need the background worker, which is off on this server.');
  };

  r.get('/agent/goals', (req, res) => res.json({ goals: goalsOverview(st, owner(req)) }));

  r.post('/agent/goals', (req, res) => {
    const b = parseBody(z.object({ title: z.string().trim().min(2).max(120), why: z.string().max(600).optional(), steps: z.array(z.string().trim().min(1).max(240)).max(25).optional(), checkIns: Every.optional(), timezone: Tz }), req.body);
    let g;
    try {
      g = createGoal(st, owner(req), b);
    } catch (e) {
      throw new AppError('validation_error', (e as Error).message);
    }
    if (b.checkIns && b.checkIns !== 'off') {
      needWorker();
      setGoalCheckIns(st, owner(req), g.id, b.checkIns, tzOf(b.timezone));
    }
    res.status(201).json({ goal: goalsOverview(st, owner(req)).find((x) => x.id === g.id) });
  });

  r.post('/agent/goals/:id', (req, res) => {
    const b = parseBody(
      z.object({
        title: z.string().trim().min(2).max(120).optional(),
        why: z.string().max(600).optional(),
        status: z.enum(['active', 'paused', 'done']).optional(),
        addSteps: z.array(z.string().trim().min(1).max(240)).max(25).optional(),
        completeSteps: z.array(z.string().max(80)).max(25).optional(),
        reopenSteps: z.array(z.string().max(80)).max(25).optional(),
        removeSteps: z.array(z.string().max(80)).max(25).optional(),
        note: z.string().max(400).optional(),
        checkIns: Every.optional(),
        timezone: Tz,
      }),
      req.body,
    );
    if (!listGoals(st, owner(req)).some((g) => g.id === idParam(req))) throw new AppError('not_found', 'Goal not found.');
    updateGoal(st, owner(req), idParam(req), b);
    if (b.checkIns) {
      if (b.checkIns !== 'off') needWorker();
      setGoalCheckIns(st, owner(req), idParam(req), b.checkIns, tzOf(b.timezone));
    }
    res.json({ goal: goalsOverview(st, owner(req)).find((x) => x.id === idParam(req)) });
  });

  /** "Work on it now": a background task that does the next safe step and reports back. */
  r.post('/agent/goals/:id/work', (req, res) => {
    if (!agent.enabled) throw new AppError('provider_not_configured', 'No tool-capable AI model is configured on the server.');
    needWorker();
    const g = listGoals(st, owner(req)).find((x) => x.id === idParam(req));
    if (!g) throw new AppError('not_found', 'Goal not found.');
    const tz = typeof req.body?.timezone === 'string' ? (req.body.timezone as string) : undefined;
    const prompt = `Work on the goal "${g.title}" (goal id ${g.id}) now. Call list_goals to read its plan and progress. If it has no plan yet, write one with update_goal add_steps. Then do the next step yourself when it is safe and you have the tools; ask before anything that sends, buys, posts, books or deletes. Record what you did with update_goal, then tell the user what moved and what is next.`;
    const t = st.createTask(owner(req), 'agent', `Goal: ${g.title}`.slice(0, 120), { prompt, timezone: tz, saveAsNote: false });
    agent.kick();
    res.status(201).json({ task: t });
  });

  r.delete('/agent/goals/:id', (req, res) => {
    if (!deleteGoal(st, owner(req), idParam(req))) throw new AppError('not_found', 'Goal not found.');
    res.json({ ok: true });
  });

  r.get('/agent/proactive', (req, res) => res.json({ proactive: getProactive(st, owner(req)), workerOn: worker, checkinHours: CHECKIN_HOURS }));

  r.post('/agent/proactive', (req, res) => {
    const b = parseBody(
      z.object({
        brief: z.object({ on: z.boolean().optional(), hour: z.number().int().min(0).max(23).optional() }).optional(),
        checkins: z.object({ on: z.boolean().optional(), everyHours: z.number().int().optional() }).optional(),
        timezone: Tz,
      }),
      req.body,
    );
    if (b.brief?.on || b.checkins?.on) needWorker();
    if (b.checkins?.everyHours !== undefined && !(CHECKIN_HOURS as readonly number[]).includes(b.checkins.everyHours)) throw new AppError('validation_error', `Check-ins run every ${CHECKIN_HOURS.join(', ')} hours.`);
    if (b.timezone && !isValidTimezone(b.timezone)) throw new AppError('validation_error', 'Unknown timezone.');
    res.json({ proactive: setProactive(st, owner(req), b), workerOn: worker, checkinHours: CHECKIN_HOURS });
  });

  return r;
}
