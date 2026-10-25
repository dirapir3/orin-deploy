import { Router, type Request } from 'express';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { requesterKey } from '../middleware/auth.js';
import { parseBody } from './util.js';
import { completeText } from '../ai/types.js';
import { aiVault, cleanSettings, detectProtocol, listModels, normalizeBaseUrl, providerDef, USER_PROVIDERS, userKeyError, userProviders, type Protocol } from '../ai/userKeys.js';

/**
 * Profile > AI keys: the user's own AI keys, kept in the Secure Vault (see ai/userKeys.ts).
 * Keys go in once and never come back out: responses carry only the last 4 characters and the
 * sealed copy the app keeps (readable by this server only).
 */
const Settings = z.object({
  provider: z.string().min(1).max(40),
  label: z.string().max(60).optional(),
  baseUrl: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  protocol: z.enum(['openai', 'anthropic', 'gemini']).optional(),
});
const AddBody = Settings.extend({ apiKey: z.string().min(1).max(1000) });
const EditBody = Settings.extend({ apiKey: z.string().max(1000).optional(), sealed: z.string().max(8000).optional() });
const Sealed = z.object({ sealed: z.string().min(1).max(8000) });
const RestoreBody = z.object({ sealed: z.array(z.string().max(8000)).max(30) });
const ProbeBody = z.object({
  provider: z.string().min(1).max(40),
  baseUrl: z.string().max(500).optional(),
  protocol: z.enum(['openai', 'anthropic', 'gemini']).optional(),
  apiKey: z.string().max(1000).optional(),
  sealed: z.string().max(8000).optional(),
});

export function aiKeysRouter(deps: Deps) {
  const r = Router();
  const account = (req: Request) => requesterKey(req);
  const vault = () => {
    if (!deps.agent) throw new AppError('provider_not_configured', 'The Secure Vault is not available on this server.');
    return aiVault(deps.agent.store);
  };
  const fetchImpl = deps.fetchImpl;

  r.get('/providers', (_req, res) => {
    res.json({ providers: USER_PROVIDERS, serverDefault: { provider: deps.config.chat.provider, model: deps.config.chat.model, ready: Boolean(deps.providers.chat && !deps.providers.chat.isDemo) } });
  });

  r.get('/keys', (req, res) => res.json({ keys: vault().list(account(req)) }));

  r.post('/keys', async (req, res) => {
    const b = parseBody(AddBody, req.body);
    const s = await cleanSettings(b);
    res.status(201).json(vault().add(account(req), s, b.apiKey));
  });

  r.post('/keys/:ref', async (req, res) => {
    const b = parseBody(EditBody, req.body);
    const s = await cleanSettings(b);
    res.json(vault().update(account(req), String(req.params.ref), s, b.apiKey, b.sealed));
  });

  r.delete('/keys/:ref', (req, res) => {
    vault().remove(account(req), String(req.params.ref));
    res.json({ ok: true });
  });

  /** Puts keys back in the vault from the app's sealed copies (after a server restart wiped it). */
  r.post('/restore', (req, res) => {
    const b = parseBody(RestoreBody, req.body);
    const problems: string[] = [];
    for (const s of b.sealed) {
      try {
        vault().resolve(account(req), s);
      } catch (e) {
        problems.push((e as Error).message);
      }
    }
    res.json({ keys: vault().list(account(req)), problems });
  });

  /** One tiny real request through the key alone (no backup), so the user sees whether it works. */
  r.post('/test', async (req, res) => {
    const b = parseBody(Sealed, req.body);
    const ai = vault().resolve(account(req), b.sealed);
    const up = userProviders(ai, deps.config, { chat: null, agent: null }, fetchImpl);
    const started = Date.now();
    try {
      const reply = await completeText(up.direct.chat, {
        model: ai.model,
        maxOutputTokens: 400,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply with only the word: ready' }],
        signal: AbortSignal.timeout(60_000),
      });
      res.json({ ok: true, reply: reply.trim().slice(0, 200), model: ai.model, provider: ai.provider, ms: Date.now() - started });
    } catch (e) {
      throw userKeyError(e, ai.label);
    }
  });

  async function probeInput(req: Request) {
    const b = parseBody(ProbeBody, req.body);
    const def = providerDef(b.provider);
    let key = (b.apiKey ?? '').trim();
    let baseUrl = normalizeBaseUrl(b.baseUrl || def.baseUrl);
    let protocol = (def.protocol === 'configurable' ? b.protocol : def.protocol) as Protocol | undefined;
    if (!key && b.sealed) {
      const ai = vault().resolve(account(req), b.sealed);
      key = ai.key;
      if (!b.baseUrl) baseUrl = ai.baseUrl;
      protocol ??= ai.protocol;
    }
    if (!key) throw new AppError('validation_error', 'Paste the API key first.');
    // same URL checks as saving (no local or private addresses)
    const s = await cleanSettings({ provider: def.id, baseUrl, model: 'probe', protocol });
    return { def, key, baseUrl: s.baseUrl, protocol };
  }

  r.post('/models', async (req, res) => {
    const p = await probeInput(req);
    const models = await listModels({ provider: p.def.id, baseUrl: p.baseUrl, key: p.key, protocol: p.protocol ?? 'openai' }, fetchImpl);
    res.json({ models });
  });

  /** For .route and custom gateways: works out which API format the base URL speaks. */
  r.post('/detect', async (req, res) => {
    const p = await probeInput(req);
    res.json(await detectProtocol(p.baseUrl, p.key, p.def.id, fetchImpl));
  });

  return r;
}
