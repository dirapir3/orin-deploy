import { createHash, randomUUID } from 'node:crypto';
import { PRESETS, type AppConfig, type ChainEntry, type ProviderId } from '../config.js';
import { AppError } from '../errors.js';
import { assertPublicUrl } from '../agent/net.js';
import { decrypt, encrypt, revealLogin } from '../agent/vault.js';
import type { AgentStore, VaultRow } from '../agent/store.js';
import { FallbackChatProvider } from './fallback.js';
import type { FetchLike } from './http.js';
import { entryProvider } from './registry.js';
import type { ChatProvider } from './types.js';

/**
 * The user's own AI keys (Profile > AI keys in the app).
 *
 * Keys live in the Secure Vault, encrypted with VAULT_KEY: the vault row's password is the key and
 * its notes hold the settings (provider, base URL, model, protocol). The app never keeps the key
 * itself. It keeps a "sealed" copy: the same settings + key encrypted with VAULT_KEY, which only this
 * server can open. The app sends that sealed copy with each chat (X-Orin-AI header) so the server can
 * put the vault row back after a restart that wiped its disk (Render's free plan does that); the key
 * used for the chat is always the one read from the vault.
 */

export type Protocol = 'openai' | 'anthropic' | 'gemini';

export interface UserProviderDef {
  id: string;
  label: string;
  /** fixed protocol, or 'configurable' (the user picks, or the server detects it) */
  protocol: Protocol | 'configurable';
  baseUrl: string;
  /** the user must enter the base URL (self-hosted gateways, custom endpoints) */
  needsBaseUrl: boolean;
  defaultModel: string;
  /** a few model names to pick from; the app can also ask the provider for its full list */
  models: string[];
  hint: string;
  keyUrl?: string;
  /** not offered in the app yet (still being set up) */
  deferred?: boolean;
}

const preset = (p: ProviderId) => PRESETS[p];
const uniq = (a: (string | undefined)[]) => a.filter((v, i): v is string => !!v && a.indexOf(v) === i);

export const USER_PROVIDERS: UserProviderDef[] = [
  { id: 'gemini', label: 'Google Gemini', protocol: 'gemini', baseUrl: preset('gemini').baseUrl, needsBaseUrl: false, defaultModel: preset('gemini').model, models: uniq([preset('gemini').model, 'gemini-flash-latest', preset('gemini').fastModel, 'gemini-pro-latest']), hint: 'Key from Google AI Studio. Tap Load models to see every model your key can use.', keyUrl: 'https://aistudio.google.com/apikey' },
  { id: 'openai', label: 'OpenAI', protocol: 'openai', baseUrl: preset('openai').baseUrl, needsBaseUrl: false, defaultModel: preset('openai').model, models: uniq([preset('openai').model, preset('openai').fastModel]), hint: 'Key from platform.openai.com. Tap Load models to see every model your key can use.', keyUrl: 'https://platform.openai.com/api-keys' },
  { id: 'anthropic', label: 'Anthropic (Claude)', protocol: 'anthropic', baseUrl: preset('anthropic').baseUrl, needsBaseUrl: false, defaultModel: preset('anthropic').model, models: uniq([preset('anthropic').model, preset('anthropic').fastModel]), hint: 'Key from console.anthropic.com. Tap Load models to see every model your key can use.', keyUrl: 'https://console.anthropic.com/settings/keys' },
  { id: 'openrouter', label: 'OpenRouter', protocol: 'openai', baseUrl: preset('openrouter').baseUrl, needsBaseUrl: false, defaultModel: preset('openrouter').model, models: [preset('openrouter').model], hint: 'One key for hundreds of models.', keyUrl: 'https://openrouter.ai/keys' },
  { id: 'groq', label: 'Groq', protocol: 'openai', baseUrl: preset('groq').baseUrl, needsBaseUrl: false, defaultModel: preset('groq').model, models: [preset('groq').model, preset('groq').fastModel].filter((v, i, a) => v && a.indexOf(v) === i), hint: 'Very fast open models.', keyUrl: 'https://console.groq.com/keys' },
  { id: 'deepseek', label: 'DeepSeek', protocol: 'openai', baseUrl: preset('deepseek').baseUrl, needsBaseUrl: false, defaultModel: preset('deepseek').model, models: uniq([preset('deepseek').model, preset('deepseek').fastModel]), hint: 'Key from platform.deepseek.com.', keyUrl: 'https://platform.deepseek.com/api_keys' },
  { id: 'mistral', label: 'Mistral', protocol: 'openai', baseUrl: preset('mistral').baseUrl, needsBaseUrl: false, defaultModel: preset('mistral').model, models: [preset('mistral').model], hint: 'Key from console.mistral.ai.', keyUrl: 'https://console.mistral.ai/api-keys' },
  { id: 'xai', label: 'xAI (Grok)', protocol: 'openai', baseUrl: preset('xai').baseUrl, needsBaseUrl: false, defaultModel: preset('xai').model, models: [preset('xai').model], hint: 'Key from console.x.ai.', keyUrl: 'https://console.x.ai' },
  { id: 'together', label: 'Together AI', protocol: 'openai', baseUrl: preset('together').baseUrl, needsBaseUrl: false, defaultModel: preset('together').model, models: [preset('together').model], hint: 'Key from api.together.ai.' },
  {
    id: 'omniroute',
    label: 'OmniRoute',
    protocol: 'openai',
    baseUrl: '',
    needsBaseUrl: true,
    defaultModel: '',
    models: [],
    hint: 'OmniRoute speaks the OpenAI format. Use its public URL ending in /v1 (a localhost address only works on your own computer, not on Orin\'s server).',
  },
  { id: 'custom', label: 'Custom (OpenAI-compatible)', protocol: 'configurable', baseUrl: '', needsBaseUrl: true, defaultModel: '', models: [], hint: 'Any other gateway or server: base URL, key and model.' },
  {
    id: 'dotroute',
    label: '.route',
    deferred: true,
    protocol: 'configurable',
    baseUrl: '',
    needsBaseUrl: true,
    defaultModel: '',
    models: [],
    hint: "Your .route gateway. Enter its API base URL and model; Orin can detect whether it speaks the OpenAI, Anthropic or Gemini format.",
  },
];

export function providerDef(id: string): UserProviderDef {
  const d = USER_PROVIDERS.find((p) => p.id === id);
  if (!d) throw new AppError('validation_error', `Unknown AI provider "${id}".`);
  return d;
}

/** Settings for one saved key (what the vault notes hold, minus the key). */
export interface AiKeySettings {
  ref: string;
  provider: string;
  label: string;
  baseUrl: string;
  model: string;
  protocol: Protocol;
}

export interface AiKeyPublic extends AiKeySettings {
  vaultId: string;
  /** last 4 characters only, so the user can tell keys apart */
  last4: string;
  updatedAt: number;
}

export interface UserAi extends AiKeySettings {
  key: string;
}

const MARK = 'orin-ai-key';

export function normalizeBaseUrl(u: string): string {
  return u.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '').replace(/\/messages$/, '');
}

function protocolFor(def: UserProviderDef, requested?: string): Protocol {
  if (def.protocol !== 'configurable') return def.protocol;
  return requested === 'anthropic' || requested === 'gemini' ? requested : 'openai';
}

/** Checks and fills in settings for a new/edited key. Throws a user-readable error. */
export async function cleanSettings(
  input: { provider: string; label?: string; baseUrl?: string; model?: string; protocol?: string },
  opts: { allowPrivate?: boolean } = {},
): Promise<Omit<AiKeySettings, 'ref'>> {
  const def = providerDef(input.provider);
  const baseUrl = normalizeBaseUrl(def.needsBaseUrl ? input.baseUrl ?? '' : input.baseUrl?.trim() || def.baseUrl);
  if (!baseUrl) throw new AppError('validation_error', `Enter the API base URL for ${def.label}.`);
  if (def.needsBaseUrl || baseUrl !== def.baseUrl) await checkUrl(baseUrl, opts.allowPrivate);
  const model = (input.model ?? '').trim() || def.defaultModel;
  if (!model) throw new AppError('validation_error', `Enter the model name to use with ${def.label}.`);
  if (model.length > 200) throw new AppError('validation_error', 'That model name is too long.');
  const label = (input.label ?? '').trim().slice(0, 60) || def.label;
  return { provider: def.id, label, baseUrl, model, protocol: protocolFor(def, input.protocol) };
}

async function checkUrl(baseUrl: string, allowPrivate = false) {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new AppError('validation_error', 'The base URL is not a valid web address (it should start with https://).');
  }
  if (allowPrivate || process.env.ORIN_ALLOW_PRIVATE_AI_URLS === '1') return;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new AppError('validation_error', 'The base URL must start with https://.');
  try {
    await assertPublicUrl(baseUrl);
  } catch (e) {
    if (e instanceof AppError && e.code === 'forbidden') {
      throw new AppError('validation_error', `${url.hostname} is a local address, so Orin's server can't reach it. Use the gateway's public URL (for example through a tunnel or a hosted server).`);
    }
    if (e instanceof AppError && e.code === 'provider_unavailable') throw new AppError('validation_error', `Can't find ${url.hostname}. Check the base URL.`);
    throw e;
  }
}

function hostOf(u: string): string {
  try {
    return new URL(u).hostname;
  } catch {
    return 'ai-key';
  }
}

function readNotes(row: VaultRow): AiKeySettings | null {
  if (!row.notesEnc) return null;
  try {
    const n = JSON.parse(decrypt(row.notesEnc)) as Partial<AiKeySettings> & { kind?: string };
    if (n.kind !== MARK || !n.ref || !n.provider || !n.baseUrl || !n.model) return null;
    return { ref: n.ref, provider: n.provider, label: n.label || n.provider, baseUrl: n.baseUrl, model: n.model, protocol: (n.protocol as Protocol) || 'openai' };
  } catch {
    return null;
  }
}

function vaultFields(s: AiKeySettings) {
  const def = USER_PROVIDERS.find((p) => p.id === s.provider);
  return {
    name: `${s.label} API key`,
    domain: hostOf(s.baseUrl),
    username: `AI key · ${def?.label ?? s.provider} · ${s.model}`,
    notes: JSON.stringify({ kind: MARK, ...s }),
  };
}

const last4 = (k: string) => (k.length > 8 ? k.slice(-4) : '');

function toPublic(row: VaultRow, s: AiKeySettings): AiKeyPublic {
  return { ...s, vaultId: row.id, last4: last4(revealLogin(row).password), updatedAt: row.updatedAt };
}

export function seal(owner: string, ai: UserAi): string {
  return encrypt(JSON.stringify({ v: 1, o: owner, ...ai }));
}

function unseal(owner: string, sealed: string): UserAi {
  let p: UserAi & { v?: number; o?: string };
  try {
    p = JSON.parse(decrypt(sealed.trim())) as UserAi & { v?: number; o?: string };
  } catch {
    throw new AppError('validation_error', 'This saved AI key can no longer be read by the server. Open Profile > AI keys and add it again.');
  }
  if (p.o !== owner) throw new AppError('forbidden', 'This AI key belongs to another account.');
  if (!p.ref || !p.key || !p.baseUrl || !p.model) throw new AppError('validation_error', 'This saved AI key is incomplete. Add it again in Profile > AI keys.');
  return { ref: p.ref, provider: p.provider, label: p.label, baseUrl: p.baseUrl, model: p.model, protocol: p.protocol, key: p.key };
}

export class AiKeyVault {
  private rowByRef = new Map<string, string>();

  constructor(private readonly st: AgentStore) {}

  list(owner: string): AiKeyPublic[] {
    const out: AiKeyPublic[] = [];
    for (const row of this.st.listVault(owner)) {
      const s = readNotes(row);
      if (s) {
        this.rowByRef.set(`${owner}|${s.ref}`, row.id);
        out.push(toPublic(row, s));
      }
    }
    return out;
  }

  private findRow(owner: string, ref: string): { row: VaultRow; s: AiKeySettings } | null {
    const cached = this.rowByRef.get(`${owner}|${ref}`);
    if (cached) {
      const row = this.st.getVault(owner, cached);
      const s = row && readNotes(row);
      if (row && s && s.ref === ref) return { row, s };
    }
    for (const row of this.st.listVault(owner)) {
      const s = readNotes(row);
      if (s?.ref === ref) {
        this.rowByRef.set(`${owner}|${ref}`, row.id);
        return { row, s };
      }
    }
    return null;
  }

  /** Saves a new key in the vault. Returns its public info and the sealed copy for the app. */
  add(owner: string, settings: Omit<AiKeySettings, 'ref'>, key: string): { key: AiKeyPublic; sealed: string } {
    const k = cleanKey(key);
    if (this.st.listVault(owner).length >= 100) throw new AppError('validation_error', 'The vault holds up to 100 entries. Delete some first.');
    const s: AiKeySettings = { ...settings, ref: randomUUID() };
    const f = vaultFields(s);
    const row = this.st.insertVault(owner, { name: f.name, domain: f.domain, usernameEnc: encrypt(f.username), passwordEnc: encrypt(k), notesEnc: encrypt(f.notes) });
    this.rowByRef.set(`${owner}|${s.ref}`, row.id);
    return { key: toPublic(row, s), sealed: seal(owner, { ...s, key: k }) };
  }

  /** Changes settings and/or the key (an empty key keeps the current one). */
  update(owner: string, ref: string, settings: Omit<AiKeySettings, 'ref'>, key: string | undefined, sealed?: string): { key: AiKeyPublic; sealed: string } {
    let found = this.findRow(owner, ref);
    if (!found && sealed) {
      this.resolve(owner, sealed);
      found = this.findRow(owner, ref);
    }
    if (!found) throw new AppError('not_found', 'That AI key is not in the vault any more. Add it again.');
    const newKey = key?.trim() ? cleanKey(key) : revealLogin(found.row).password;
    const s: AiKeySettings = { ...settings, ref };
    const f = vaultFields(s);
    const row = this.st.updateVault(owner, found.row.id, { name: f.name, domain: f.domain, usernameEnc: encrypt(f.username), passwordEnc: encrypt(newKey), notesEnc: encrypt(f.notes) });
    if (!row) throw new AppError('not_found', 'That AI key is not in the vault any more. Add it again.');
    return { key: toPublic(row, s), sealed: seal(owner, { ...s, key: newKey }) };
  }

  remove(owner: string, ref: string): boolean {
    const found = this.findRow(owner, ref);
    this.rowByRef.delete(`${owner}|${ref}`);
    return found ? this.st.deleteVault(owner, found.row.id) : false;
  }

  /**
   * The key + settings to use for a request, read from the vault. When the vault no longer has it
   * (the server's disk was wiped), it is put back from the sealed copy first.
   */
  resolve(owner: string, sealed: string): UserAi {
    const sealedAi = unseal(owner, sealed);
    let found = this.findRow(owner, sealedAi.ref);
    if (!found) {
      const f = vaultFields(sealedAi);
      const row = this.st.insertVault(owner, { name: f.name, domain: f.domain, usernameEnc: encrypt(f.username), passwordEnc: encrypt(sealedAi.key), notesEnc: encrypt(f.notes) });
      this.rowByRef.set(`${owner}|${sealedAi.ref}`, row.id);
      found = { row, s: { ref: sealedAi.ref, provider: sealedAi.provider, label: sealedAi.label, baseUrl: sealedAi.baseUrl, model: sealedAi.model, protocol: sealedAi.protocol } };
    }
    const key = revealLogin(found.row).password;
    if (!key) throw new AppError('validation_error', `The vault entry for ${found.s.label} has no key. Add the key again in Profile > AI keys.`);
    return { ...found.s, key };
  }
}

function cleanKey(key: string): string {
  const k = (key ?? '').trim();
  if (!k) throw new AppError('validation_error', 'Paste the API key.');
  if (k.length > 1000 || /\s/.test(k)) throw new AppError('validation_error', 'That does not look like an API key (it has spaces or is too long).');
  return k;
}

// ---- providers built from a user key

function providerIdFor(ai: AiKeySettings): ProviderId {
  if (ai.protocol === 'gemini') return 'gemini';
  if (ai.protocol === 'anthropic') return 'anthropic';
  const known: Record<string, ProviderId> = { openai: 'openai', openrouter: 'openrouter', groq: 'groq', deepseek: 'deepseek', mistral: 'mistral', xai: 'xai', together: 'together' };
  return known[ai.provider] ?? 'openai_compatible';
}

export function userEntry(ai: UserAi, config: AppConfig): ChainEntry {
  const pid = providerIdFor(ai);
  const p = PRESETS[pid];
  return {
    provider: pid,
    displayName: ai.label,
    keys: [ai.key],
    baseUrl: ai.baseUrl,
    model: ai.model,
    fastModel: ai.model,
    visionModel: ai.model,
    supportsVision: true,
    caps: { ...p.caps, tools: true, vision: true },
    maxTokensParam: pid === 'openai' ? 'max_completion_tokens' : 'max_tokens',
    timeoutMs: Math.max(config.chat.timeoutMs, 90_000),
    thinkingBudget: pid === 'gemini' ? config.chat.thinkingBudget ?? null : null,
  };
}

export interface UserProviders {
  ai: UserAi;
  /** the user's key only (Test button) */
  direct: { chat: ChatProvider; agent: ChatProvider };
  /** the user's key first, the server's own keys as backup */
  chat: ChatProvider;
  agent: ChatProvider | null;
}

const caches = new WeakMap<object, Map<string, UserProviders>>();
const defaultFetchKey = {};

export function userProviders(ai: UserAi, config: AppConfig, server: { chat: ChatProvider | null; agent: ChatProvider | null }, fetchImpl?: FetchLike): UserProviders {
  const id = createHash('sha256').update(JSON.stringify([ai.key, ai.baseUrl, ai.model, ai.protocol, ai.provider, ai.label, Boolean(server.chat), Boolean(server.agent)])).digest('hex');
  const ck = (fetchImpl as object | undefined) ?? defaultFetchKey;
  let cache = caches.get(ck);
  if (!cache) {
    cache = new Map();
    caches.set(ck, cache);
  }
  const hit = cache.get(id);
  if (hit) return hit;
  const entry = userEntry(ai, config);
  // Callers ask for the server's model names (config.chat.model, fastModel...): always use the user's.
  const chatP = pinModel(entryProvider(entry, ai.key, false, fetchImpl), ai.model);
  const agentP = pinModel(entryProvider(entry, ai.key, true, fetchImpl), ai.model);
  // in the chain, any failure of the user's key (bad model name too) lets the server's keys answer
  const soft = (p: ChatProvider): ChatProvider => ({
    ...p,
    streamChat: async function* (req) {
      try {
        yield* p.streamChat(req);
      } catch (e) {
        if (e instanceof AppError && e.code === 'provider_bad_request') throw new AppError('provider_unavailable', e.message);
        throw e;
      }
    },
  });
  const cand = (provider: ChatProvider) => ({ provider, group: `user:${ai.provider}`, label: `${ai.label} (your key)`, model: ai.model, fastModel: ai.model, visionModel: ai.model, supportsVision: true });
  const backup = (provider: ChatProvider | null) =>
    provider && !provider.isDemo
      ? [{ provider, group: 'server', label: 'server keys', model: config.chat.model, fastModel: config.chat.fastModel, visionModel: config.chat.visionModel, supportsVision: provider.supportsVision }]
      : [];
  const quiet = { onFallback: (ev: { label: string; code: string }) => console.warn(`[ai] ${ev.label} failed (${ev.code}); trying the server's keys`) };
  // the chain reports the model it was asked for; when the user's key answered, report the user's model
  const label = (p: ChatProvider): ChatProvider => ({
    id: p.id,
    displayName: p.displayName,
    isDemo: false,
    supportsVision: p.supportsVision,
    supportsTools: p.supportsTools,
    streamChat: async function* (req) {
      for await (const c of p.streamChat(req)) {
        yield c.type === 'served' && c.provider === `user:${ai.provider}` ? { ...c, model: ai.model } : c;
      }
    },
  });
  const out: UserProviders = {
    ai,
    direct: { chat: chatP, agent: agentP },
    chat: label(new FallbackChatProvider([cand(soft(chatP)), ...backup(server.chat)], quiet)),
    agent: label(new FallbackChatProvider([cand(soft(agentP)), ...backup(server.agent)], quiet)),
  };
  if (cache.size > 50) cache.delete(cache.keys().next().value as string);
  cache.set(id, out);
  return out;
}

function pinModel(p: ChatProvider, model: string): ChatProvider {
  return {
    id: p.id,
    displayName: p.displayName,
    isDemo: false,
    supportsVision: p.supportsVision,
    supportsTools: p.supportsTools,
    streamChat: (req) => p.streamChat({ ...req, model }),
  };
}

/**
 * Several of the user's keys in rotation ("Rotate through my keys" in the app). Requests take turns
 * across the keys (round robin), a key that hits a rate limit or fails rests while the others carry
 * on, and the server's keys are the last backup. One instance per account + key set, so the turn
 * order and the resting keys carry over from message to message.
 */
const ROTATION_GROUP = 'user:rotation';
const rotations = new Map<string, UserProviders>();

export function userProvidersRotation(ais: UserAi[], config: AppConfig, server: { chat: ChatProvider | null; agent: ChatProvider | null }, fetchImpl?: FetchLike): UserProviders {
  if (ais.length === 1) return userProviders(ais[0]!, config, server, fetchImpl);
  const id = createHash('sha256').update(JSON.stringify([ais.map((a) => [a.key, a.baseUrl, a.model, a.protocol, a.provider, a.label]), Boolean(server.chat), Boolean(server.agent), Boolean(fetchImpl)])).digest('hex');
  const hit = rotations.get(id);
  if (hit) return hit;
  const soft = (p: ChatProvider): ChatProvider => ({
    ...p,
    streamChat: async function* (req) {
      try {
        yield* p.streamChat(req);
      } catch (e) {
        if (e instanceof AppError && e.code === 'provider_bad_request') throw new AppError('provider_unavailable', e.message);
        throw e;
      }
    },
  });
  const keyId = (ai: UserAi) => createHash('sha256').update(`user|${ai.key}`).digest('hex').slice(0, 16);
  const cands = (agent: boolean) =>
    ais.map((ai, i) => {
      const p = pinModel(entryProvider(userEntry(ai, config), ai.key, agent, fetchImpl), ai.model);
      return { provider: soft(p), group: ROTATION_GROUP, label: `${ai.label} (your key ${i + 1}/${ais.length})`, model: ai.model, fastModel: ai.model, visionModel: ai.model, supportsVision: true, keyId: keyId(ai) };
    });
  const backup = (provider: ChatProvider | null) =>
    provider && !provider.isDemo
      ? [{ provider, group: 'server', label: 'server keys', model: config.chat.model, fastModel: config.chat.fastModel, visionModel: config.chat.visionModel, supportsVision: provider.supportsVision }]
      : [];
  const quiet = { onFallback: (ev: { label: string; code: string }) => console.warn(`[ai] ${ev.label} failed (${ev.code}); trying the next of your keys`) };
  const byModel = new Map(ais.map((a) => [a.model, a]));
  const wrap = (fb: FallbackChatProvider): ChatProvider => ({
    id: fb.id,
    displayName: fb.displayName,
    isDemo: false,
    supportsVision: fb.supportsVision,
    supportsTools: fb.supportsTools,
    streamChat: async function* (req) {
      try {
        for await (const c of fb.streamChat(req)) yield c.type === 'served' && c.provider === ROTATION_GROUP ? { ...c, model: byModel.has(c.model) ? c.model : ais[0]!.model } : c;
      } finally {
        fb.rotate(ROTATION_GROUP);
      }
    },
  });
  const direct = userProviders(ais[0]!, config, server, fetchImpl).direct;
  const out: UserProviders = {
    ai: ais[0]!,
    direct,
    chat: wrap(new FallbackChatProvider([...cands(false), ...backup(server.chat)], quiet)),
    agent: wrap(new FallbackChatProvider([...cands(true), ...backup(server.agent)], quiet)),
  };
  if (rotations.size > 50) rotations.delete(rotations.keys().next().value as string);
  rotations.set(id, out);
  return out;
}

/** Asks the provider which models this key can use (best effort). */
export async function listModels(ai: Omit<UserAi, 'ref' | 'label' | 'model'>, fetchImpl: FetchLike = fetch as FetchLike): Promise<string[]> {
  const base = ai.baseUrl.replace(/\/+$/, '');
  let url = `${base}/models`;
  const headers: Record<string, string> = {};
  if (ai.protocol === 'gemini') {
    url = `${base}/models?pageSize=200`;
    headers['x-goog-api-key'] = ai.key;
  } else if (ai.protocol === 'anthropic') {
    headers['x-api-key'] = ai.key;
    headers['anthropic-version'] = '2023-06-01';
  } else {
    headers.Authorization = `Bearer ${ai.key}`;
  }
  const res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw httpProblem(/API[_ ]KEY[_ ]INVALID|API key not valid|invalid.{0,20}key|unauthori[sz]ed/i.test(text) ? 401 : res.status, ai.provider);
  }
  const j = (await res.json()) as { data?: { id?: string }[]; models?: { name?: string; supportedGenerationMethods?: string[] }[] };
  const ids = j.data?.map((m) => m.id ?? '') ?? j.models?.filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent')).map((m) => (m.name ?? '').replace(/^models\//, '')) ?? [];
  return [...new Set(ids.filter(Boolean))].slice(0, 300);
}

function httpProblem(status: number, provider: string): AppError {
  const name = USER_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  if (status === 401 || status === 403) return new AppError('validation_error', `${name} rejected this key (HTTP ${status}). Check that you copied the whole key.`);
  if (status === 404) return new AppError('validation_error', `${name} has no models list at this base URL (HTTP 404). Check the base URL, or type the model name yourself.`);
  return new AppError('validation_error', `${name} answered with HTTP ${status}.`);
}

/**
 * For gateways whose format is unknown (.route, custom): tries the OpenAI, Anthropic and Gemini
 * ways of listing models and reports the first that works.
 */
export async function detectProtocol(baseUrl: string, key: string, provider: string, fetchImpl: FetchLike = fetch as FetchLike): Promise<{ protocol: Protocol; models: string[] } | { protocol: null; tried: string[] }> {
  const tried: string[] = [];
  for (const protocol of ['openai', 'anthropic', 'gemini'] as Protocol[]) {
    try {
      const models = await listModels({ provider, baseUrl, key, protocol }, fetchImpl);
      return { protocol, models };
    } catch (e) {
      tried.push(`${protocol}: ${(e as Error).message}`);
    }
  }
  return { protocol: null, tried };
}

/** Turns a provider error into words about the user's own key (not the server's .env). */
export function userKeyError(e: unknown, label: string): AppError {
  if (e instanceof AppError) {
    switch (e.code) {
      case 'invalid_api_key':
        return new AppError('validation_error', `${label} rejected the key. Check that you copied the whole key and that it is still active.`);
      case 'provider_bad_request':
        if (/no longer available|not found|does not exist|unknown model|model_not_found/i.test(e.message)) {
          return new AppError('validation_error', `${label} doesn't offer this model to your key. Tap Load models and pick another.`);
        }
        return new AppError('validation_error', `${label} could not use this model or request (${e.message.replace(/.*\(HTTP (\d+)\).*/, 'HTTP $1')}). Check the model name and base URL.`);
      case 'provider_rate_limited':
        return new AppError('validation_error', `${label} says this key is out of quota or rate limited right now.`);
      case 'timeout':
        return new AppError('validation_error', `${label} took too long to answer.`);
      case 'provider_unavailable':
        return new AppError('validation_error', `${label} is unreachable or failed: ${e.message}`);
      default:
        return e;
    }
  }
  const msg = (e as Error)?.message ?? String(e);
  return new AppError('validation_error', `Couldn't reach ${label}: ${msg}`);
}

// ---- per-request use (chat routes)

const vaults = new WeakMap<AgentStore, AiKeyVault>();
export function aiVault(st: AgentStore): AiKeyVault {
  let v = vaults.get(st);
  if (!v) {
    v = new AiKeyVault(st);
    vaults.set(st, v);
  }
  return v;
}

export const AI_HEADER = 'x-orin-ai';

/**
 * The user's chosen key for this request (X-Orin-AI header = the sealed copy the app keeps), or null
 * when the app sent none. Also hands the key to background tasks started by this account.
 */
export function requestAi(
  deps: { config: AppConfig; providers: { chat: ChatProvider | null; agent: ChatProvider | null }; agent?: { store: AgentStore; setUserProvider?: (account: string, p: ChatProvider | null) => void }; fetchImpl?: FetchLike },
  account: string,
  header: string | undefined,
): UserProviders | null {
  const raw = (header ?? '').trim();
  if (!raw || !deps.agent) return null;
  // one sealed key, or several separated by commas ("Rotate through my keys")
  const list = raw.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 20);
  if (!list.length) return null;
  const vault = aiVault(deps.agent.store);
  let up: UserProviders;
  if (list.length === 1) {
    up = userProviders(vault.resolve(account, list[0]!), deps.config, deps.providers, deps.fetchImpl);
  } else {
    const ais: UserAi[] = [];
    let firstErr: unknown = null;
    for (const s of list) {
      try {
        ais.push(vault.resolve(account, s));
      } catch (e) {
        firstErr ??= e;
      }
    }
    if (!ais.length) throw firstErr;
    up = userProvidersRotation(ais, deps.config, deps.providers, deps.fetchImpl);
  }
  deps.agent.setUserProvider?.(account, up.agent);
  return up;
}
