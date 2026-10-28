import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.js';
import { assertPublicUrl } from '../agent/net.js';
import { getSetting, setSetting } from '../agent/sandbox/connections.js';
import type { AgentStore, VaultRow } from '../agent/store.js';
import { decrypt, encrypt, revealLogin } from '../agent/vault.js';
import { logger } from '../logger.js';
import { GeminiVoiceProvider } from './providers/geminiVoice.js';
import { OpenAICompatibleVoiceProvider } from './providers/openaiCompatible.js';
import { DeepgramVoiceProvider, ElevenLabsVoiceProvider } from './providers/voiceExtra.js';
import type { SpeechRequest, TranscribeRequest, VoiceInfo, VoiceProvider } from './types.js';
import type { SpeechStream } from './providers/geminiVoice.js';

type SpeakRequest = SpeechRequest;
type SpeakResult = { audio: Buffer; mimeType: string };
type TranscribeResult = { text: string; durationSec?: number };
import { aiVault } from './userKeys.js';

/**
 * Voice setups (AI setup > Voice in the app): speech-to-text and text-to-speech services the user
 * adds with their own key, or with one of their saved AI keys (an OpenAI, Groq or Gemini AI key can
 * run that provider's voice too, so it is not stored twice). Each kind of service has an adapter;
 * "Custom" is any server that speaks the OpenAI audio API (/audio/transcriptions, /audio/speech).
 *
 * Storage: like AI keys and sandbox keys, a setup is a Secure Vault row (password = the key, empty
 * when it uses an AI key; notes = { kind: 'orin-voice', ... }). Which setup listens and which speaks
 * (or the phone's own voice) and the last result of each live in setup_settings ('voice').
 *
 * Effect on calls: routes/voice.ts asks resolveVoice() for every /transcribe, /speech, /speech/start
 * and /voices; this module answers with the chosen setup, or null to keep the server's default.
 * When a chosen setup fails on a call, that one call falls back to the server's default voice (so the
 * call keeps going) and the failure is recorded, so Settings shows it instead of hiding it.
 */

export type VoiceServiceId = 'openai' | 'groq' | 'gemini' | 'elevenlabs' | 'deepgram' | 'custom';

export interface VoiceServiceDef {
  id: VoiceServiceId;
  label: string;
  stt: boolean;
  tts: boolean;
  /** AI key providers whose key also works here */
  aiKeyProviders: string[];
  /** the user enters the server address (Custom) */
  needsBaseUrl: boolean;
  baseUrl: string;
  sttModels: string[];
  ttsModels: string[];
  voices: VoiceInfo[];
  /** the full voice list comes from the user's account */
  voicesFromAccount: boolean;
  /** speech starts playing before the whole reply is generated (lowest delay) */
  streaming: boolean;
  keyUrl?: string;
  hint: string;
}

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'].map((id) => ({ id, name: id[0]!.toUpperCase() + id.slice(1) }));
const GEMINI_VOICES = ['Sulafat', 'Kore', 'Puck', 'Charon', 'Aoede', 'Leda', 'Orus', 'Zephyr', 'Fenrir', 'Achird', 'Gacrux', 'Vindemiatrix'].map((id) => ({ id, name: id }));
const DEEPGRAM_VOICES = ['aura-2-thalia-en', 'aura-2-andromeda-en', 'aura-2-helena-en', 'aura-2-apollo-en', 'aura-2-arcas-en', 'aura-2-aries-en'].map((id) => ({ id, name: id.replace(/^aura-2-|-en$/g, '').replace(/^./, (c) => c.toUpperCase()) }));

export const VOICE_SERVICES: VoiceServiceDef[] = [
  { id: 'gemini', label: 'Google Gemini', stt: true, tts: true, aiKeyProviders: ['gemini'], needsBaseUrl: false, baseUrl: '', sttModels: ['gemini-flash-lite-latest', 'gemini-flash-latest'], ttsModels: ['gemini-2.5-flash-preview-tts', 'gemini-2.5-pro-preview-tts'], voices: GEMINI_VOICES, voicesFromAccount: false, streaming: true, keyUrl: 'https://aistudio.google.com/apikey', hint: 'Listens and speaks. Speech streams, so replies start fastest.' },
  { id: 'openai', label: 'OpenAI', stt: true, tts: true, aiKeyProviders: ['openai'], needsBaseUrl: false, baseUrl: 'https://api.openai.com/v1', sttModels: ['gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-1'], ttsModels: ['gpt-4o-mini-tts', 'tts-1', 'tts-1-hd'], voices: OPENAI_VOICES, voicesFromAccount: false, streaming: false, keyUrl: 'https://platform.openai.com/api-keys', hint: 'Listens and speaks.' },
  { id: 'groq', label: 'Groq', stt: true, tts: false, aiKeyProviders: ['groq'], needsBaseUrl: false, baseUrl: 'https://api.groq.com/openai/v1', sttModels: ['whisper-large-v3-turbo', 'whisper-large-v3'], ttsModels: [], voices: [], voicesFromAccount: false, streaming: false, keyUrl: 'https://console.groq.com/keys', hint: 'Very fast listening (Whisper). Pick another service to speak.' },
  { id: 'elevenlabs', label: 'ElevenLabs', stt: true, tts: true, aiKeyProviders: [], needsBaseUrl: false, baseUrl: 'https://api.elevenlabs.io', sttModels: ['scribe_v2', 'scribe_v1'], ttsModels: ['eleven_flash_v2_5', 'eleven_turbo_v2_5', 'eleven_multilingual_v2'], voices: [], voicesFromAccount: true, streaming: false, keyUrl: 'https://elevenlabs.io/app/settings/api-keys', hint: 'Natural voices, including your own cloned ones. Tap Load voices after saving.' },
  { id: 'deepgram', label: 'Deepgram', stt: true, tts: true, aiKeyProviders: [], needsBaseUrl: false, baseUrl: 'https://api.deepgram.com', sttModels: ['nova-3', 'nova-2'], ttsModels: [], voices: DEEPGRAM_VOICES, voicesFromAccount: false, streaming: false, keyUrl: 'https://console.deepgram.com', hint: 'Fast listening and Aura voices.' },
  { id: 'custom', label: 'Custom (OpenAI audio API)', stt: true, tts: true, aiKeyProviders: ['custom', 'omniroute', 'openai', 'groq', 'together', 'openrouter'], needsBaseUrl: true, baseUrl: '', sttModels: [], ttsModels: [], voices: [], voicesFromAccount: false, streaming: false, hint: 'Any server with /audio/transcriptions and /audio/speech in the OpenAI format (LocalAI, Speaches, Kokoro-FastAPI, many gateways). Public https address only.' },
];

/** Asked about, but a different protocol: needs an adapter before a key can work. */
export const VOICE_NEEDS_ADAPTER = ['Azure Speech', 'Google Cloud Speech', 'AWS Polly / Transcribe', 'AssemblyAI', 'Cartesia', 'PlayHT'];

const MARK = 'orin-voice';
export const DEVICE_VOICE = 'device';
const MODEL_RE = /^[\w.:/@+-]{1,100}$/;

export interface VoiceHealth {
  state: 'untested' | 'ok' | 'failed';
  checkedAt?: number;
  error?: string;
  /** what the last test heard (speech-to-text) */
  heard?: string;
}

export interface VoiceSetupPublic {
  ref: string;
  service: VoiceServiceId;
  serviceLabel: string;
  label: string;
  baseUrl?: string;
  sttModel?: string;
  ttsModel?: string;
  voice?: string;
  /** "…abcd" of its own key, '' when it uses an AI key or has none */
  last4: string;
  /** the AI key it uses (ref and label), when it does */
  aiKey?: { ref: string; label: string; missing: boolean };
  canListen: boolean;
  canSpeak: boolean;
  health: { stt: VoiceHealth; tts: VoiceHealth };
  createdAt: number;
}

export interface VoiceSelection {
  /** setup ref that listens, or null = the server's default */
  stt: string | null;
  /** setup ref that speaks, 'device' = the phone's own voice, null = the server's default */
  tts: string | null;
}

interface Notes {
  kind: typeof MARK;
  ref: string;
  service: VoiceServiceId;
  label: string;
  baseUrl?: string;
  sttModel?: string;
  ttsModel?: string;
  voice?: string;
  aiKeyRef?: string;
  createdAt: number;
}

interface VoiceSettings {
  stt?: string | null;
  tts?: string | null;
  health: Record<string, { stt?: VoiceHealth; tts?: VoiceHealth }>;
}

export function voiceServiceDef(id: string): VoiceServiceDef {
  const d = VOICE_SERVICES.find((s) => s.id === id);
  if (!d) throw new AppError('validation_error', `${VOICE_NEEDS_ADAPTER.find((n) => n.toLowerCase().startsWith(String(id).toLowerCase())) ?? 'That voice service'} has no adapter in Orin yet. Supported now: ${VOICE_SERVICES.map((s) => s.label).join(', ')}.`);
  return d;
}

function readNotes(row: VaultRow): Notes | null {
  if (!row.notesEnc) return null;
  try {
    const n = JSON.parse(decrypt(row.notesEnc)) as Partial<Notes>;
    if (n.kind !== MARK || !n.ref || !n.service || !VOICE_SERVICES.some((s) => s.id === n.service)) return null;
    return { ...(n as Notes), label: n.label || n.service, createdAt: n.createdAt || row.createdAt };
  } catch {
    return null;
  }
}

const cleanModel = (v: string | undefined, what: string) => {
  const s = (v ?? '').trim();
  if (!s) return undefined;
  if (!MODEL_RE.test(s)) throw new AppError('validation_error', `The ${what} name has characters a model or voice name can't have.`);
  return s;
};

export async function cleanVoiceBaseUrl(raw: string, lookup?: Parameters<typeof assertPublicUrl>[1]): Promise<string> {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  if (!v) throw new AppError('validation_error', 'Enter the server address, for example https://my-voice-server.com/v1');
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new AppError('validation_error', 'The server address is not a valid web address.');
  }
  if (u.protocol !== 'https:') throw new AppError('validation_error', 'The server address must start with https:// (the key and your audio are sent there).');
  if (u.username || u.password) throw new AppError('validation_error', 'Leave the user name and password out of the address; put the key in the key field.');
  if (u.search || u.hash) throw new AppError('validation_error', 'Leave ?… and #… out of the server address.');
  try {
    await assertPublicUrl(v, lookup);
  } catch (e) {
    if (e instanceof AppError && e.code === 'forbidden') throw new AppError('validation_error', `${u.hostname} is a local or private address. Orin's server can only reach public https servers (use a tunnel such as ngrok for one on your phone or computer).`);
    if (e instanceof AppError && e.code === 'provider_unavailable') throw new AppError('validation_error', `Can't find ${u.hostname}. Check the address.`);
    throw e;
  }
  return v;
}

/** Audio a speak call returned must really be audio, and not empty. */
export function checkAudio(r: SpeakResult): string | null {
  if (!r?.audio || r.audio.length < 100) return 'The service answered without any audio.';
  if (!/^audio\//i.test(r.mimeType || '')) return `The service sent "${r.mimeType || 'no type'}" instead of audio. Check the address: it should be the API root (ending in /v1 for most servers).`;
  return null;
}

function friendly(svc: string, e: unknown): string {
  const msg = String((e as Error)?.message ?? e).slice(0, 220);
  const label = VOICE_SERVICES.find((s) => s.id === svc)?.label ?? svc;
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid.*key|api key/i.test(msg)) return `${label} rejected the key. Check it or paste a new one.`;
  if (/\b402\b|\b429\b|quota|credit|exceeded/i.test(msg)) return `${label} says the account is out of credit or over its limit: ${msg}`;
  if (/\b404\b/.test(msg)) return `${label} says that address or model does not exist (404). Check the model name${svc === 'custom' ? ' and that the address ends at the API root, usually /v1' : ''}.`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|timeout|timed out/i.test(msg)) return `Couldn't reach ${label} just now (${msg}).`;
  return msg;
}

/** Wraps a user's setup: uses its voice, records failures, and falls back to the default for one call. */
class UserVoice implements VoiceProvider {
  readonly id: string;
  readonly supportsTts: boolean;
  readonly sttModel: string;
  readonly ttsModel: string;
  constructor(
    private readonly inner: VoiceProvider,
    private readonly voice: string | undefined,
    private readonly fallback: VoiceProvider | null,
    private readonly report: (ok: boolean, error?: string) => void,
    readonly speakEnabled: boolean,
    private readonly svc: VoiceServiceId,
  ) {
    this.id = inner.id;
    this.supportsTts = speakEnabled && inner.supportsTts;
    this.sttModel = inner.sttModel;
    this.ttsModel = inner.ttsModel;
    if (this.supportsTts && inner.speakStream) {
      const stream = inner.speakStream.bind(inner);
      this.speakStream = (req: SpeakRequest) => this.wrapStream(stream, req);
    }
    if (inner.restingUntil) this.restingUntil = inner.restingUntil.bind(inner);
  }
  speakStream?: (req: SpeechRequest) => Promise<SpeechStream>;
  restingUntil?: (kind: 'tts' | 'stt') => number;
  get lastTrace() {
    return this.inner.lastTrace;
  }

  voices(): VoiceInfo[] {
    const v = this.inner.voices();
    if (this.voice && !v.some((x) => x.id === this.voice)) return [{ id: this.voice, name: this.voice }, ...v];
    return v;
  }
  defaultVoice(): string {
    return this.voice || this.inner.defaultVoice();
  }
  private req<T extends SpeakRequest>(r: T): T {
    // the voice chosen in Settings wins over the character's built-in voice
    return this.voice ? { ...r, voice: this.voice } : r;
  }
  private fail(e: unknown) {
    const m = friendly(this.svc, e);
    this.report(false, m);
    logger.warn('user voice failed; using the default for this call', { service: this.svc, err: m });
  }

  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    try {
      const r = await this.inner.transcribe(req);
      this.report(true);
      return r;
    } catch (e) {
      if (req.signal?.aborted || !this.fallback) throw e;
      this.fail(e);
      return this.fallback.transcribe(req);
    }
  }

  async speak(req: SpeakRequest): Promise<SpeakResult> {
    try {
      const r = await this.inner.speak(this.req(req));
      const bad = checkAudio(r);
      if (bad) throw new Error(bad);
      this.report(true);
      return r;
    } catch (e) {
      if (req.signal?.aborted || !this.fallback?.supportsTts) throw e;
      this.fail(e);
      return this.fallback.speak(req);
    }
  }

  private async wrapStream(stream: (r: SpeechRequest) => Promise<SpeechStream>, req: SpeakRequest): Promise<SpeechStream> {
    // resolves at the first audio; a failure before that can still use the default voice
    try {
      const s = await stream(this.req(req));
      this.report(true);
      return s;
    } catch (e) {
      if (req.signal?.aborted || !this.fallback?.supportsTts || !this.fallback.speakStream) throw e;
      this.fail(e);
      return this.fallback.speakStream(req);
    }
  }
}

/** The phone speaks: the server says it has no voice, so the app uses the device's own. */
class DeviceSpeaks implements VoiceProvider {
  readonly supportsTts = false;
  readonly id: string;
  readonly sttModel: string;
  readonly ttsModel = '';
  constructor(private readonly listen: VoiceProvider | null) {
    this.id = listen?.id ?? 'device';
    this.sttModel = listen?.sttModel ?? '';
  }
  voices(): VoiceInfo[] {
    return [];
  }
  defaultVoice(): string {
    return '';
  }
  async transcribe(req: TranscribeRequest): Promise<TranscribeResult> {
    if (!this.listen) throw new AppError('voice_not_configured', 'Speech-to-text is not set up.');
    return this.listen.transcribe(req);
  }
  async speak(): Promise<SpeakResult> {
    throw new AppError('voice_not_configured', "Your phone's own voice is selected for speaking in AI setup > Voice.");
  }
}

type Lookup = Parameters<typeof assertPublicUrl>[1];

export class VoiceSetups {
  private readonly cache = new Map<string, VoiceProvider>();
  constructor(
    private readonly st: AgentStore,
    private readonly o: { timeoutMs?: number; lookup?: Lookup; now?: () => number; make?: (n: Notes, key: string, baseUrl: string) => VoiceProvider } = {},
  ) {}
  private now() {
    return (this.o.now ?? Date.now)();
  }
  private settings(account: string): VoiceSettings {
    return getSetting<VoiceSettings>(this.st, account, 'voice', { health: {} });
  }
  private save(account: string, s: VoiceSettings) {
    setSetting(this.st, account, 'voice', s);
  }
  private rows(account: string) {
    const out: { row: VaultRow; n: Notes }[] = [];
    for (const row of this.st.listVault(account)) {
      const n = readNotes(row);
      if (n) out.push({ row, n });
    }
    return out.sort((a, b) => a.n.createdAt - b.n.createdAt);
  }
  private find(account: string, ref: string) {
    const f = this.rows(account).find((x) => x.n.ref === ref);
    if (!f) throw new AppError('not_found', 'That voice setup is not there any more.');
    return f;
  }
  private aiKey(account: string, ref: string): { label: string; provider: string; baseUrl: string; key: string } | null {
    const k = aiVault(this.st)
      .list(account)
      .find((x) => x.ref === ref);
    if (!k) return null;
    const row = this.st.getVault(account, k.vaultId);
    return row ? { label: k.label, provider: k.provider, baseUrl: k.baseUrl, key: revealLogin(row).password } : null;
  }

  /** key and address a setup really uses */
  private creds(account: string, row: VaultRow, n: Notes): { key: string; baseUrl: string } | null {
    const def = voiceServiceDef(n.service);
    if (n.aiKeyRef) {
      const k = this.aiKey(account, n.aiKeyRef);
      if (!k) return null;
      return { key: k.key, baseUrl: n.baseUrl || (def.needsBaseUrl ? k.baseUrl : def.baseUrl) };
    }
    return { key: revealLogin(row).password, baseUrl: n.baseUrl || def.baseUrl };
  }

  private pub(account: string, row: VaultRow, n: Notes, s: VoiceSettings): VoiceSetupPublic {
    const def = voiceServiceDef(n.service);
    const own = n.aiKeyRef ? '' : revealLogin(row).password;
    const ai = n.aiKeyRef ? aiVault(this.st).list(account).find((x) => x.ref === n.aiKeyRef) : undefined;
    const h = s.health[n.ref] ?? {};
    return {
      ref: n.ref,
      service: n.service,
      serviceLabel: def.label,
      label: n.label,
      ...(n.baseUrl ? { baseUrl: n.baseUrl } : {}),
      ...(n.sttModel ? { sttModel: n.sttModel } : {}),
      ...(n.ttsModel ? { ttsModel: n.ttsModel } : {}),
      ...(n.voice ? { voice: n.voice } : {}),
      last4: own.length > 8 ? own.slice(-4) : '',
      ...(n.aiKeyRef ? { aiKey: { ref: n.aiKeyRef, label: ai?.label ?? 'AI key (deleted)', missing: !ai } } : {}),
      canListen: def.stt,
      canSpeak: def.tts,
      health: { stt: h.stt ?? { state: 'untested' }, tts: h.tts ?? { state: 'untested' } },
      createdAt: n.createdAt,
    };
  }

  list(account: string): { setups: VoiceSetupPublic[]; selection: VoiceSelection } {
    const s = this.settings(account);
    const rows = this.rows(account);
    const has = (ref: string | null | undefined) => Boolean(ref && rows.some((r) => r.n.ref === ref));
    return {
      setups: rows.map(({ row, n }) => this.pub(account, row, n, s)),
      selection: { stt: has(s.stt) ? s.stt! : null, tts: s.tts === DEVICE_VOICE ? DEVICE_VOICE : has(s.tts) ? s.tts! : null },
    };
  }

  private async validate(account: string, def: VoiceServiceDef, input: { key?: string; aiKeyRef?: string; baseUrl?: string; sttModel?: string; ttsModel?: string; voice?: string }, prev?: Notes) {
    let aiKeyRef = input.aiKeyRef === undefined ? prev?.aiKeyRef : input.aiKeyRef || undefined;
    const key = (input.key ?? '').trim();
    if (key) aiKeyRef = undefined;
    if (key && (key.length > 2000 || /\s/.test(key))) throw new AppError('validation_error', 'That does not look like an API key (it has spaces or is too long).');
    if (aiKeyRef) {
      const k = this.aiKey(account, aiKeyRef);
      if (!k) throw new AppError('validation_error', 'That AI key is not saved any more.');
      if (!def.aiKeyProviders.includes(k.provider)) throw new AppError('validation_error', `A ${k.provider} AI key can't run ${def.label} voice. Paste a ${def.label} key instead.`);
    }
    let baseUrl = input.baseUrl === undefined ? prev?.baseUrl : input.baseUrl.trim() || undefined;
    if (def.needsBaseUrl) {
      const fromKey = aiKeyRef ? this.aiKey(account, aiKeyRef)?.baseUrl : '';
      baseUrl = await cleanVoiceBaseUrl(baseUrl || fromKey || '', this.o.lookup);
    } else if (baseUrl) {
      throw new AppError('validation_error', `${def.label} uses its own address; leave the address empty.`);
    }
    return {
      key,
      aiKeyRef,
      baseUrl,
      sttModel: input.sttModel === undefined ? prev?.sttModel : cleanModel(input.sttModel, 'speech-to-text model'),
      ttsModel: input.ttsModel === undefined ? prev?.ttsModel : cleanModel(input.ttsModel, 'voice model'),
      voice: input.voice === undefined ? prev?.voice : cleanModel(input.voice, 'voice'),
    };
  }

  async add(account: string, input: { service: string; label?: string; key?: string; aiKeyRef?: string; baseUrl?: string; sttModel?: string; ttsModel?: string; voice?: string }): Promise<VoiceSetupPublic> {
    const def = voiceServiceDef(input.service);
    const v = await this.validate(account, def, input);
    if (!v.key && !v.aiKeyRef && def.id !== 'custom') throw new AppError('validation_error', `Paste a ${def.label} API key${def.aiKeyProviders.length ? ' or pick one of your AI keys' : ''}.`);
    if (this.st.listVault(account).length >= 100) throw new AppError('validation_error', 'The vault holds up to 100 entries. Delete some first.');
    const n: Notes = {
      kind: MARK,
      ref: randomUUID(),
      service: def.id,
      label: (input.label ?? '').trim().slice(0, 60) || def.label,
      ...(v.baseUrl ? { baseUrl: v.baseUrl } : {}),
      ...(v.sttModel ? { sttModel: v.sttModel } : {}),
      ...(v.ttsModel ? { ttsModel: v.ttsModel } : {}),
      ...(v.voice ? { voice: v.voice } : {}),
      ...(v.aiKeyRef ? { aiKeyRef: v.aiKeyRef } : {}),
      createdAt: this.now(),
    };
    this.st.insertVault(account, { name: `${n.label} voice key`, domain: v.baseUrl ? new URL(v.baseUrl).hostname : new URL(def.baseUrl || 'https://aistudio.google.com').hostname, usernameEnc: encrypt(`Voice · ${def.label}`), passwordEnc: encrypt(v.key), notesEnc: encrypt(JSON.stringify(n)) });
    const { row } = this.find(account, n.ref);
    return this.pub(account, row, n, this.settings(account));
  }

  async update(account: string, ref: string, input: { label?: string; key?: string; aiKeyRef?: string; baseUrl?: string; sttModel?: string; ttsModel?: string; voice?: string }): Promise<VoiceSetupPublic> {
    const { row, n } = this.find(account, ref);
    const def = voiceServiceDef(n.service);
    const v = await this.validate(account, def, input, n);
    const next: Notes = { kind: MARK, ref, service: n.service, label: input.label?.trim().slice(0, 60) || n.label, createdAt: n.createdAt };
    if (v.baseUrl) next.baseUrl = v.baseUrl;
    if (v.sttModel) next.sttModel = v.sttModel;
    if (v.ttsModel) next.ttsModel = v.ttsModel;
    if (v.voice) next.voice = v.voice;
    if (v.aiKeyRef) next.aiKeyRef = v.aiKeyRef;
    const keyChange = v.key ? { passwordEnc: encrypt(v.key) } : v.aiKeyRef && !n.aiKeyRef ? { passwordEnc: encrypt('') } : {};
    this.st.updateVault(account, row.id, { name: `${next.label} voice key`, notesEnc: encrypt(JSON.stringify(next)), ...keyChange });
    const s = this.settings(account);
    delete s.health[ref]; // changed settings have not been tested
    this.save(account, s);
    const f = this.find(account, ref);
    return this.pub(account, f.row, f.n, s);
  }

  remove(account: string, ref: string): boolean {
    const { row } = this.find(account, ref);
    const ok = this.st.deleteVault(account, row.id);
    const s = this.settings(account);
    delete s.health[ref];
    if (s.stt === ref) s.stt = null;
    if (s.tts === ref) s.tts = null;
    this.save(account, s);
    return ok;
  }

  select(account: string, input: { stt?: string | null; tts?: string | null }): VoiceSelection {
    const s = this.settings(account);
    if (input.stt !== undefined) {
      if (input.stt) {
        const { n } = this.find(account, input.stt);
        if (!voiceServiceDef(n.service).stt) throw new AppError('validation_error', `${n.label} can't listen (no speech-to-text).`);
      }
      s.stt = input.stt || null;
    }
    if (input.tts !== undefined) {
      if (input.tts && input.tts !== DEVICE_VOICE) {
        const { n } = this.find(account, input.tts);
        if (!voiceServiceDef(n.service).tts) throw new AppError('validation_error', `${n.label} can't speak (no text-to-speech).`);
      }
      s.tts = input.tts || null;
    }
    this.save(account, s);
    return this.list(account).selection;
  }

  private record(account: string, ref: string, kind: 'stt' | 'tts', h: VoiceHealth) {
    const s = this.settings(account);
    const prev = s.health[ref]?.[kind];
    // calls report every success; write only when something changes
    if (h.state === 'ok' && prev?.state === 'ok' && !h.heard && prev.checkedAt && this.now() - prev.checkedAt < 10 * 60_000) return;
    s.health[ref] = { ...(s.health[ref] ?? {}), [kind]: h };
    this.save(account, s);
  }

  /** Builds the adapter for a setup (cached until its vault row changes). */
  private build(account: string, ref: string): { p: VoiceProvider; n: Notes } | null {
    const f = this.rows(account).find((x) => x.n.ref === ref);
    if (!f) return null;
    const c = this.creds(account, f.row, f.n);
    if (!c) return null;
    const cacheKey = `${account}|${ref}|${f.row.updatedAt}|${c.key.slice(-6)}`;
    let p = this.cache.get(cacheKey);
    if (!p) {
      p = this.make(f.n, c.key, c.baseUrl);
      this.cache.set(cacheKey, p);
      if (this.cache.size > 200) this.cache.delete(this.cache.keys().next().value!);
    }
    return { p, n: f.n };
  }

  private make(n: Notes, key: string, baseUrl: string): VoiceProvider {
    if (this.o.make) return this.o.make(n, key, baseUrl);
    const def = voiceServiceDef(n.service);
    const timeoutMs = this.o.timeoutMs ?? 60_000;
    switch (n.service) {
      case 'gemini':
        return new GeminiVoiceProvider({ keys: [key], sttModels: [n.sttModel ?? def.sttModels[0]!, ...def.sttModels].filter((v, i, a) => a.indexOf(v) === i), ttsModels: [n.ttsModel ?? def.ttsModels[0]!, ...def.ttsModels].filter((v, i, a) => a.indexOf(v) === i), timeoutMs, tts: true });
      case 'elevenlabs':
        return new ElevenLabsVoiceProvider({ apiKey: key, voiceId: n.voice, sttModel: n.sttModel, ttsModel: n.ttsModel, timeoutMs });
      case 'deepgram':
        return new DeepgramVoiceProvider({ apiKey: key, sttModel: n.sttModel, ttsVoice: n.voice || n.ttsModel, timeoutMs });
      default:
        return new OpenAICompatibleVoiceProvider({
          id: n.service === 'custom' ? 'custom' : n.service,
          baseUrl,
          apiKey: key,
          sttModel: n.sttModel ?? def.sttModels[0] ?? 'whisper-1',
          ttsModel: def.tts ? (n.ttsModel ?? def.ttsModels[0] ?? 'tts-1') : '',
          voices: def.voices.length ? def.voices.map((v) => v.id) : [n.voice || 'alloy'],
          defaultVoice: n.voice ?? def.voices[0]?.id ?? 'alloy',
          timeoutMs,
        });
    }
  }

  /**
   * The voice to use for this account and direction, or null for the server's default. Never
   * throws: a broken setup is skipped (and recorded) rather than breaking calls.
   */
  resolve(account: string, kind: 'stt' | 'tts', serverDefault: VoiceProvider | null): VoiceProvider | null {
    let s: VoiceSettings;
    try {
      s = this.settings(account);
    } catch {
      return null;
    }
    const pick = kind === 'stt' ? s.stt : s.tts;
    if (kind === 'tts' && pick === DEVICE_VOICE) {
      const listen = s.stt ? this.resolve(account, 'stt', serverDefault) : serverDefault;
      return new DeviceSpeaks(listen);
    }
    if (!pick) return null;
    try {
      const b = this.build(account, pick);
      if (!b) {
        this.record(account, pick, kind, { state: 'failed', checkedAt: this.now(), error: 'Its key is missing (the AI key it used was deleted?). Using the default voice.' });
        return null;
      }
      return new UserVoice(b.p, kind === 'tts' ? b.n.voice : undefined, serverDefault, (ok, error) => this.record(account, pick, kind, ok ? { state: 'ok', checkedAt: this.now() } : { state: 'failed', checkedAt: this.now(), error }), kind === 'tts', b.n.service);
    } catch (e) {
      logger.warn('user voice setup unusable', { err: String(e) });
      return null;
    }
  }

  /** Voices to pick from: the service's list, or the account's own (ElevenLabs). */
  async voices(account: string, ref: string): Promise<VoiceInfo[]> {
    const b = this.build(account, ref);
    if (!b) throw new AppError('not_found', 'That voice setup or its key is not there any more.');
    const def = voiceServiceDef(b.n.service);
    if (!def.tts) return [];
    if (b.p instanceof ElevenLabsVoiceProvider) {
      try {
        await b.p.loadVoices();
      } catch (e) {
        throw new AppError('provider_unavailable', friendly(b.n.service, e));
      }
    }
    return b.p.voices();
  }

  /**
   * Live test. Speaking: synthesise a short line and check it is real audio. Listening: make a short
   * clip (with this setup's voice, else the server's) and check the setup hears the words.
   */
  async test(account: string, ref: string, kind: 'stt' | 'tts', serverDefault: VoiceProvider | null): Promise<{ health: VoiceHealth; audio?: { mimeType: string; base64: string } }> {
    const b = this.build(account, ref);
    if (!b) throw new AppError('not_found', 'That voice setup or its key is not there any more.');
    const def = voiceServiceDef(b.n.service);
    const t0 = this.now();
    const line = 'Testing Orin voice, one two three.';
    let health: VoiceHealth;
    let audio: { mimeType: string; base64: string } | undefined;
    try {
      if (kind === 'tts') {
        if (!def.tts) throw new AppError('validation_error', `${def.label} can't speak.`);
        const r = await b.p.speak({ text: line, voice: b.n.voice || b.p.defaultVoice(), signal: AbortSignal.timeout(45_000) });
        const bad = checkAudio(r);
        if (bad) throw new Error(bad);
        audio = r.audio.length <= 1_500_000 ? { mimeType: r.mimeType, base64: Buffer.from(r.audio).toString('base64') } : undefined;
        health = { state: 'ok', checkedAt: this.now() };
      } else {
        if (!def.stt) throw new AppError('validation_error', `${def.label} can't listen.`);
        const speaker = def.tts ? b.p : serverDefault?.supportsTts ? serverDefault : null;
        if (!speaker) throw new AppError('voice_not_configured', 'There is no voice to make a test clip with. Save a setup that can speak, then test again.');
        const clip = await speaker.speak({ text: line, voice: speaker === b.p ? b.n.voice || speaker.defaultVoice() : speaker.defaultVoice(), signal: AbortSignal.timeout(45_000) });
        const bad = checkAudio(clip);
        if (bad) throw new Error(`Couldn't make the test clip: ${bad}`);
        const r = await b.p.transcribe({ audio: clip.audio, mimeType: clip.mimeType, filename: `test.${/wav/.test(clip.mimeType) ? 'wav' : /mpeg|mp3/.test(clip.mimeType) ? 'mp3' : /ogg/.test(clip.mimeType) ? 'ogg' : 'audio'}`, signal: AbortSignal.timeout(45_000) });
        const heard = (r.text ?? '').trim();
        if (!heard) throw new Error('It returned no words for a clear test clip.');
        const ok = /test|orin|one|two|three/i.test(heard);
        health = ok ? { state: 'ok', checkedAt: this.now(), heard: heard.slice(0, 120) } : { state: 'failed', checkedAt: this.now(), heard: heard.slice(0, 120), error: `It heard "${heard.slice(0, 80)}" instead of the test words.` };
      }
    } catch (e) {
      if (e instanceof AppError && e.code === 'validation_error') throw e;
      health = { state: 'failed', checkedAt: this.now(), error: friendly(b.n.service, e) };
    }
    this.record(account, ref, kind, health);
    logger.info('voice setup tested', { service: b.n.service, kind, ok: health.state === 'ok', ms: this.now() - t0 });
    return { health, ...(audio ? { audio } : {}) };
  }
}

const instances = new WeakMap<AgentStore, VoiceSetups>();
export function voiceSetups(st: AgentStore, o?: ConstructorParameters<typeof VoiceSetups>[1]): VoiceSetups {
  let v = instances.get(st);
  if (!v) {
    v = new VoiceSetups(st, o);
    instances.set(st, v);
  }
  return v;
}
