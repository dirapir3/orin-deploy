import type { AppConfig } from '../config.js';
import { keyId, sharedKeyHealth } from '../ai/keyHealth.js';
import { AppError } from '../errors.js';
import type { FetchLike } from '../ai/http.js';
import { entryProvider } from '../ai/registry.js';
import { completeText } from '../ai/types.js';
import type { AdminCard } from './fields.js';
import { last4, splitKeys } from './envFile.js';

export interface TestResult {
  state: 'ok' | 'error';
  message: string;
  at: number;
}

const T = 25_000;

function short(e: unknown): string {
  const msg = e instanceof AppError ? e.message : (e as Error)?.message || String(e);
  return msg.replace(/\s+/g, ' ').slice(0, 220);
}

async function httpCheck(fetchImpl: FetchLike, url: string, init: RequestInit, name: string): Promise<Response> {
  const res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(T) });
  if (!res.ok) {
    let body = '';
    try {
      body = (await res.text()).slice(0, 160);
    } catch {
      /* ignore */
    }
    const hint = res.status === 401 || res.status === 403 ? 'key rejected' : res.status === 429 ? 'rate limited / out of quota' : `HTTP ${res.status}`;
    throw new Error(`${name}: ${hint}${body ? ` (${body.replace(/\s+/g, ' ')})` : ''}`);
  }
  return res;
}

/** Runs each key in a pool; "ok" only if every key works. */
async function perKey(keys: string[], fn: (key: string) => Promise<string>): Promise<TestResult> {
  if (keys.length === 0) return { state: 'error', message: 'No key saved yet.', at: Date.now() };
  const results = await Promise.all(
    keys.map(async (k, i) => {
      const tag = keys.length > 1 ? `Key ${i + 1} (••••${last4(k)}): ` : '';
      const id = keyId(k);
      try {
        const text = tag + (await fn(k));
        if (id) {
          sharedKeyHealth.recordOk(id, Date.now());
          sharedKeyHealth.cooling.delete(id);
        }
        return { ok: true, text };
      } catch (e) {
        const msg = short(e);
        if (id) {
          const code = e instanceof AppError ? e.code : /key rejected/.test(msg) ? 'invalid_api_key' : /rate limited|quota/i.test(msg) ? 'provider_rate_limited' : 'error';
          sharedKeyHealth.recordFail(id, Date.now(), code, msg);
          if (code === 'provider_rate_limited') sharedKeyHealth.cooling.set(id, Date.now() + (/per day|daily/i.test(msg) ? 60 : 5) * 60_000);
        }
        return { ok: false, text: tag + msg };
      }
    }),
  );
  const ok = results.every((r) => r.ok);
  return { state: ok ? 'ok' : 'error', message: results.map((r) => r.text).join(' · '), at: Date.now() };
}

async function testChat(config: AppConfig, providerId: string, fetchImpl: FetchLike): Promise<TestResult> {
  const entry = config.chat.available.find((e) => e.provider === providerId);
  if (!entry) return { state: 'error', message: 'Not set up yet: save the key (and endpoint/model if asked) first.', at: Date.now() };
  const keys = entry.keys.length ? entry.keys : [''];
  return perKey(keys, async (k) => {
    const p = entryProvider(entry, k, false, fetchImpl);
    const started = Date.now();
    const text = await completeText(p, {
      messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      model: entry.model,
      maxOutputTokens: 64,
      signal: AbortSignal.timeout(T),
    });
    return `Working · ${entry.model} replied "${text.trim().slice(0, 30) || '(empty)'}" in ${((Date.now() - started) / 1000).toFixed(1)}s`;
  });
}

async function testSearch(cardId: string, keys: string[], fetchImpl: FetchLike): Promise<TestResult> {
  return perKey(keys, async (k) => {
    let n = 0;
    if (cardId === 'tavily') {
      const r = await httpCheck(fetchImpl, 'https://api.tavily.com/search', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${k}` }, body: JSON.stringify({ query: 'Orin test', max_results: 1 }) }, 'Tavily');
      n = ((await r.json()) as { results?: unknown[] }).results?.length ?? 0;
    } else if (cardId === 'brave') {
      const r = await httpCheck(fetchImpl, 'https://api.search.brave.com/res/v1/web/search?q=Orin%20test&count=1', { headers: { Accept: 'application/json', 'X-Subscription-Token': k } }, 'Brave');
      n = ((await r.json()) as { web?: { results?: unknown[] } }).web?.results?.length ?? 0;
    } else if (cardId === 'serper') {
      const r = await httpCheck(fetchImpl, 'https://google.serper.dev/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-API-KEY': k }, body: JSON.stringify({ q: 'Orin test', num: 1 }) }, 'Serper');
      n = ((await r.json()) as { organic?: unknown[] }).organic?.length ?? 0;
    } else if (cardId === 'exa') {
      const r = await httpCheck(fetchImpl, 'https://api.exa.ai/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': k }, body: JSON.stringify({ query: 'Orin test', numResults: 1 }) }, 'Exa');
      n = ((await r.json()) as { results?: unknown[] }).results?.length ?? 0;
    }
    return `Working · ${n} result${n === 1 ? '' : 's'}`;
  });
}

export async function runCardTest(card: AdminCard, config: AppConfig, env: Record<string, string | undefined>, fetchImpl: FetchLike = fetch): Promise<TestResult> {
  const keysOf = (name: string) => splitKeys(env[name]);
  try {
    switch (card.test) {
      case 'chat':
        return await testChat(config, card.id, fetchImpl);
      case 'ollama':
        return await testChat(config, 'ollama', fetchImpl);
      case 'search':
        return await testSearch(card.id, keysOf(card.fields[0]!.env), fetchImpl);
      case 'elevenlabs':
        return await perKey(keysOf('ELEVENLABS_API_KEY'), async (k) => {
          const r = await httpCheck(fetchImpl, 'https://api.elevenlabs.io/v1/voices', { headers: { 'xi-api-key': k } }, 'ElevenLabs');
          const n = ((await r.json()) as { voices?: unknown[] }).voices?.length ?? 0;
          return `Working · ${n} voices`;
        });
      case 'deepgram':
        return await perKey(keysOf('DEEPGRAM_API_KEY'), async (k) => {
          await httpCheck(fetchImpl, 'https://api.deepgram.com/v1/projects', { headers: { Authorization: `Token ${k}` } }, 'Deepgram');
          return 'Working';
        });
      case 'e2b':
        return await perKey(keysOf('E2B_API_KEY'), async (k) => {
          await httpCheck(fetchImpl, 'https://api.e2b.dev/sandboxes', { headers: { 'X-API-Key': k } }, 'E2B');
          return 'Working · code sandbox enabled';
        });
      case 'google': {
        const id = (env.GOOGLE_CLIENT_ID ?? '').trim();
        const secret = (env.GOOGLE_CLIENT_SECRET ?? '').trim();
        if (!id || !secret) return { state: 'error', message: 'Save both the client ID and the secret first.', at: Date.now() };
        // A token request with a dummy code: Google answers invalid_grant when the client is right, invalid_client when not.
        const res = await fetchImpl('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code: 'orin-test', client_id: id, client_secret: secret, redirect_uri: 'http://localhost' }),
          signal: AbortSignal.timeout(T),
        });
        const json = (await res.json().catch(() => ({}))) as { error?: string };
        if (json.error === 'invalid_client' || json.error === 'unauthorized_client') return { state: 'error', message: 'Google rejected this client ID / secret.', at: Date.now() };
        return { state: 'ok', message: 'Working · Google accepted the client (connect your account from the app).', at: Date.now() };
      }
      default:
        return { state: 'error', message: 'Nothing to test here.', at: Date.now() };
    }
  } catch (e) {
    return { state: 'error', message: short(e), at: Date.now() };
  }
}
