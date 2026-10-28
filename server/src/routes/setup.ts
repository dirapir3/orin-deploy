import { Router } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { agentOwners, requesterKey } from '../middleware/auth.js';
import { parseBody } from './util.js';
import { connectionsFor } from '../agent/sandbox/index.js';
import { SANDBOX_NEEDS_ADAPTER, SANDBOX_PROVIDERS } from '../agent/sandbox/connections.js';
import { DEVICE_VOICE, VOICE_NEEDS_ADAPTER, VOICE_SERVICES, voiceSetups } from '../ai/userVoice.js';
import { aiVault } from '../ai/userKeys.js';

/**
 * AI setup hub (/v1/setup): sandbox connections (many per account, health checks, failover) and
 * voice setups (speech-to-text / text-to-speech). AI model keys stay at /v1/ai (routes/aiKeys.ts);
 * the overview here only counts them. Keys come in once and never go back out (last 4 only).
 */
export function setupRouter(deps: Deps): Router {
  const r = Router();
  const agent = () => {
    if (!deps.agent) throw new AppError('provider_unavailable', 'The agent is not running on this server.');
    return deps.agent;
  };
  const conns = () => connectionsFor(agent().services);
  const voice = () => voiceSetups(agent().store);
  /** close computers on a connection that was removed or switched off (only this account's) */
  const retire = (account: string, id: string, why: string) => {
    const owners = new Set(agentOwners(account));
    return agent().services.sandboxes?.retireConnection(id, why, (o) => owners.has(o)) ?? 0;
  };
  const sandboxState = (account: string) => {
    const m = agent().services.sandboxes;
    const sessions = agentOwners(account)
      .map((o) => m?.status(o))
      .filter(Boolean);
    return {
      providers: SANDBOX_PROVIDERS,
      needsAdapter: SANDBOX_NEEDS_ADAPTER,
      connections: conns().list(account),
      running: sessions,
      interrupted: agentOwners(account).map((o) => m?.lastInterruption(o)).find(Boolean) ?? null,
    };
  };

  // ---- overview

  r.get('/', (req, res) => {
    const account = requesterKey(req);
    const ai = aiVault(agent().store).list(account);
    const sb = conns().list(account);
    const v = voice().list(account);
    const setupOf = (ref: string | null) => v.setups.find((s) => s.ref === ref);
    res.json({
      ai: { keys: ai.length },
      sandboxes: { total: sb.length, on: sb.filter((c) => c.enabled).length, healthy: sb.filter((c) => c.enabled && c.health.state === 'ok').length, failing: sb.filter((c) => c.enabled && c.health.state === 'failed').length, default: sb.find((c) => c.isDefault)?.label ?? null },
      voice: { setups: v.setups.length, listen: setupOf(v.selection.stt)?.label ?? null, speak: v.selection.tts === DEVICE_VOICE ? 'Phone voice' : (setupOf(v.selection.tts)?.label ?? null), serverDefault: deps.providers.voice ? { id: deps.providers.voice.id, tts: deps.providers.voice.supportsTts } : null },
    });
  });

  // ---- sandboxes

  r.get('/sandboxes', (req, res) => {
    res.json(sandboxState(requesterKey(req)));
  });

  const addSchema = z.object({ provider: z.string().min(1).max(40), label: z.string().max(60).optional(), key: z.string().min(1).max(1000), apiUrl: z.string().max(300).optional() });
  r.post('/sandboxes', async (req, res, next) => {
    try {
      const account = requesterKey(req);
      const body = parseBody(addSchema, req.body);
      const c = await conns().add(account, body);
      // check it straight away so the list says the truth (saved either way; a failed check is shown)
      const health = await conns().check(account, c.id);
      res.status(201).json({ connection: { ...c, health }, ...sandboxState(account) });
    } catch (e) {
      next(e);
    }
  });

  const patchSchema = z.object({ label: z.string().max(60).optional(), key: z.string().max(1000).optional(), apiUrl: z.string().max(300).optional(), enabled: z.boolean().optional() });
  r.patch('/sandboxes/:id', async (req, res, next) => {
    try {
      const account = requesterKey(req);
      const body = parseBody(patchSchema, req.body);
      const c = await conns().update(account, req.params.id!, body);
      let closing = 0;
      if (body.enabled === false) closing = retire(account, c.id, 'its sandbox connection was switched off');
      if (body.key?.trim()) {
        closing = retire(account, c.id, 'its key was replaced');
        await conns().check(account, c.id);
      }
      res.json({ closing, ...sandboxState(account) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/sandboxes/:id/default', (req, res, next) => {
    try {
      const account = requesterKey(req);
      conns().setDefault(account, req.params.id!);
      // computers already running stay where they are (their files and jobs are there); new ones use this
      res.json(sandboxState(account));
    } catch (e) {
      next(e);
    }
  });

  r.post('/sandboxes/:id/check', async (req, res, next) => {
    try {
      const account = requesterKey(req);
      const health = await conns().check(account, req.params.id!);
      res.json({ health, ...sandboxState(account) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/sandboxes/check-all', async (req, res, next) => {
    try {
      const account = requesterKey(req);
      await Promise.all(conns().list(account).filter((c) => c.enabled).map((c) => conns().check(account, c.id)));
      res.json(sandboxState(account));
    } catch (e) {
      next(e);
    }
  });

  r.delete('/sandboxes/:id', (req, res, next) => {
    try {
      const account = requesterKey(req);
      const closing = retire(account, req.params.id!, 'its sandbox connection was deleted');
      conns().remove(account, req.params.id!);
      res.json({ closing, ...sandboxState(account) });
    } catch (e) {
      next(e);
    }
  });

  // ---- voice

  const voiceState = (account: string) => {
    const sv = deps.providers.voice;
    return {
      services: VOICE_SERVICES,
      needsAdapter: VOICE_NEEDS_ADAPTER,
      serverDefault: sv ? { id: sv.id, stt: true, tts: sv.supportsTts, sttModel: sv.sttModel, ttsModel: sv.ttsModel } : null,
      aiKeys: aiVault(agent().store)
        .list(account)
        .map((k) => ({ ref: k.ref, label: k.label, provider: k.provider, baseUrl: k.baseUrl || undefined, usableFor: VOICE_SERVICES.filter((s) => s.aiKeyProviders.includes(k.provider)).map((s) => s.id) }))
        .filter((k) => k.usableFor.length),
      ...voice().list(account),
    };
  };

  r.get('/voice', (req, res) => {
    res.json(voiceState(requesterKey(req)));
  });

  const vAdd = z.object({ service: z.string().min(1).max(40), label: z.string().max(60).optional(), key: z.string().max(2000).optional(), aiKeyRef: z.string().max(80).optional(), baseUrl: z.string().max(300).optional(), sttModel: z.string().max(100).optional(), ttsModel: z.string().max(100).optional(), voice: z.string().max(100).optional() });
  r.post('/voice', async (req, res, next) => {
    try {
      const account = requesterKey(req);
      const setup = await voice().add(account, parseBody(vAdd, req.body));
      res.status(201).json({ setup, ...voiceState(account) });
    } catch (e) {
      next(e);
    }
  });

  r.patch('/voice/:ref', async (req, res, next) => {
    try {
      const account = requesterKey(req);
      await voice().update(account, req.params.ref!, parseBody(vAdd.omit({ service: true }), req.body));
      res.json(voiceState(account));
    } catch (e) {
      next(e);
    }
  });

  r.delete('/voice/:ref', (req, res, next) => {
    try {
      const account = requesterKey(req);
      voice().remove(account, req.params.ref!);
      res.json(voiceState(account));
    } catch (e) {
      next(e);
    }
  });

  const vSel = z.object({ stt: z.string().max(80).nullable().optional(), tts: z.string().max(80).nullable().optional() });
  r.post('/voice/select', (req, res, next) => {
    try {
      const account = requesterKey(req);
      voice().select(account, parseBody(vSel, req.body));
      res.json(voiceState(account));
    } catch (e) {
      next(e);
    }
  });

  r.get('/voice/:ref/voices', async (req, res, next) => {
    try {
      res.json({ voices: await voice().voices(requesterKey(req), req.params.ref!) });
    } catch (e) {
      next(e);
    }
  });

  const vTest = z.object({ kind: z.enum(['stt', 'tts']) });
  r.post('/voice/:ref/test', async (req, res, next) => {
    try {
      const account = requesterKey(req);
      const { kind } = parseBody(vTest, req.body);
      const out = await voice().test(account, req.params.ref!, kind, deps.providers.voice ?? null);
      res.json({ ...out, ...voiceState(account) });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
