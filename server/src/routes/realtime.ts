import { Router } from 'express';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { providerFetch } from '../ai/http.js';

/**
 * EXPERIMENTAL, NOT USED BY THE APP YET, NOT TESTED AGAINST THE LIVE API.
 * Mints a short-lived OpenAI Realtime client secret so a future WebRTC client can talk to the
 * Realtime API without ever seeing the server's API key.
 */
export function realtimeRouter(deps: Deps) {
  const r = Router();
  r.post('/session', async (req, res, next) => {
    try {
      const { realtime } = deps.config;
      if (!realtime.enabled || !realtime.apiKey) {
        throw new AppError('voice_not_configured', 'Realtime voice is not enabled on this server.');
      }
      const body = (req.body ?? {}) as { voice?: string };
      const upstream = await providerFetch(deps.fetchImpl ?? fetch, 'OpenAI Realtime', 'https://api.openai.com/v1/realtime/client_secrets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${realtime.apiKey}` },
        body: JSON.stringify({
          session: {
            type: 'realtime',
            model: realtime.model,
            ...(typeof body.voice === 'string' && /^[a-z]{2,20}$/.test(body.voice) ? { audio: { output: { voice: body.voice } } } : {}),
          },
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const json = (await upstream.json()) as { value?: string; expires_at?: number };
      if (!json.value) throw new AppError('provider_unavailable', 'Realtime session could not be created.');
      res.json({ clientSecret: json.value, expiresAt: json.expires_at, model: realtime.model });
    } catch (err) {
      next(err);
    }
  });
  return r;
}
