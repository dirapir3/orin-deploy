import { AppError } from '../../errors.js';
import { withTimeout, type FetchLike } from '../http.js';
import type { SpeechRequest, TranscribeRequest, VoiceInfo, VoiceProvider } from '../types.js';
import type { SpeechStream } from './geminiVoice.js';

/**
 * HeyGen Voice (developers.heygen.com/docs/voices/heygen-voice-speech), speaking only.
 * - POST /v3/models/audio/tts/stream with output_format pcm answers raw PCM16 bytes as they are made, so
 *   calls start playing at the first audio (speakStream). The same endpoint with mp3 is used for whole clips.
 * - GET /v3/models/audio/voices?type=public|private lists the voices (with a preview_audio_url WAV).
 * - Auth: X-Api-Key. Errors before the first audio use { error: { code, message, param } }.
 * - heygen-voice-1-turbo-free is free (public + instant voices); heygen-voice-1(-turbo) are charged.
 * HeyGen has no speech-to-text, so listening stays with the default voice.
 */
export const HEYGEN_DEFAULT_VOICE = '83548de556df48ba8c09c42a57c51d85'; // Nadine, the public voice HeyGen's docs use
export const HEYGEN_MODELS = ['heygen-voice-1-turbo-free', 'heygen-voice-1-turbo', 'heygen-voice-1'];
const SAMPLE_RATE = 24_000;
const VOICE_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const LIST_TTL_MS = 10 * 60_000;

export interface HeyGenVoiceInfo extends VoiceInfo {
  previewUrl?: string;
  language?: string;
  note?: string;
  mode?: 'instant' | 'professional';
}

interface Options {
  apiKey: string;
  voiceId?: string;
  ttsModel?: string;
  baseUrl?: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
  now?: () => number;
}

/** Text HeyGen can read: no SSML-like tags (instant voices refuse <break>), no [1] citation marks, max 5,000 chars. */
export function heygenText(text: string): string {
  return text
    .replace(/<[^>]{1,200}>/g, ' ')
    .replace(/\[\d{1,3}\]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 5000);
}

export class HeyGenVoiceProvider implements VoiceProvider {
  readonly id = 'heygen';
  readonly sttModel = '';
  readonly ttsModel: string;
  readonly supportsTts = true;
  lastTrace?: string[];
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private list: HeyGenVoiceInfo[] = [];
  private listAt = 0;
  /** After a 429 with Retry-After, fail fast (so the default voice speaks at once) instead of asking again. */
  private coolUntil = 0;

  constructor(private readonly o: Options) {
    this.ttsModel = o.ttsModel?.trim() || HEYGEN_MODELS[0]!;
    this.base = (o.baseUrl || 'https://api.heygen.com').replace(/\/+$/, '');
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.now = o.now ?? Date.now;
  }

  defaultVoice(): string {
    return this.o.voiceId && VOICE_ID_RE.test(this.o.voiceId) ? this.o.voiceId : HEYGEN_DEFAULT_VOICE;
  }

  voices(): HeyGenVoiceInfo[] {
    if (this.list.length) return this.list;
    return [{ id: HEYGEN_DEFAULT_VOICE, name: 'Nadine', note: 'Public' }];
  }

  /** Loads your own voices (clones) first, then HeyGen's public voices. Only ACTIVE ones can speak. */
  async loadVoices(force = false): Promise<HeyGenVoiceInfo[]> {
    if (!force && this.list.length && this.now() - this.listAt < LIST_TTL_MS) return this.list;
    const fetchPage = async (type: 'private' | 'public', token?: string) => {
      const q = new URLSearchParams({ type, limit: '100', ...(token ? { token } : {}) });
      const res = await this.call(`/v3/models/audio/voices?${q}`, { method: 'GET', signal: AbortSignal.timeout(15_000) });
      const j = (await res.json().catch(() => ({}))) as { data?: Array<Record<string, unknown>>; has_more?: boolean; next_token?: string | null };
      return j;
    };
    const out: HeyGenVoiceInfo[] = [];
    const seen = new Set<string>();
    const add = (rows: Array<Record<string, unknown>> | undefined, type: 'private' | 'public') => {
      for (const v of rows ?? []) {
        const id = String(v.voice_id ?? '');
        if (!id || seen.has(id) || (v.status && v.status !== 'ACTIVE')) continue;
        seen.add(id);
        const mode = v.mode === 'professional' ? 'professional' : 'instant';
        out.push({
          id,
          name: String(v.name ?? id).slice(0, 80),
          ...(typeof v.language === 'string' && v.language ? { language: v.language } : {}),
          ...(typeof v.preview_audio_url === 'string' && /^https:\/\//.test(v.preview_audio_url) ? { previewUrl: v.preview_audio_url } : {}),
          note: type === 'private' ? (mode === 'professional' ? 'Your professional clone' : 'Your voice') : 'Public',
          mode,
        });
      }
    };
    const mine = await fetchPage('private');
    add(mine.data, 'private');
    let token: string | undefined;
    for (let page = 0; page < 3; page++) {
      const pub = await fetchPage('public', token);
      add(pub.data, 'public');
      if (!pub.has_more || !pub.next_token) break;
      token = pub.next_token;
    }
    if (!out.length) throw new AppError('provider_bad_request', 'HeyGen returned no voices that are ready to use.', { retryable: false });
    this.list = out;
    this.listAt = this.now();
    return out;
  }

  async transcribe(_req: TranscribeRequest): Promise<{ text: string }> {
    throw new AppError('voice_not_configured', "HeyGen can't listen; Orin's default voice does the listening.");
  }

  private body(req: SpeechRequest, encoding: 'pcm' | 'mp3'): string {
    const text = heygenText(req.text);
    if (!text) throw new AppError('validation_error', 'Nothing to say.');
    const voice = req.voice && VOICE_ID_RE.test(req.voice) ? req.voice : this.defaultVoice();
    const pro = this.list.find((v) => v.id === voice)?.mode === 'professional';
    if (pro && this.ttsModel !== 'heygen-voice-1') {
      throw new AppError('provider_bad_request', 'HeyGen: that voice is a professional clone, and only the heygen-voice-1 model (charged) can speak it. Pick another voice, or set Speaking model to heygen-voice-1.', { retryable: false });
    }
    return JSON.stringify({
      model: this.ttsModel,
      voice_id: voice,
      text,
      output_format: { encoding, sample_rate_hertz: encoding === 'pcm' ? SAMPLE_RATE : 44_100 },
    });
  }

  /** Whole clip (tests, voice replies outside a call): the stream endpoint's raw MP3, in one request. */
  async speak(req: SpeechRequest): Promise<{ audio: Buffer; mimeType: string }> {
    const t0 = this.now();
    const res = await this.call('/v3/models/audio/tts/stream', { method: 'POST', body: this.body(req, 'mp3'), signal: withTimeout(req.signal, this.o.timeoutMs) });
    const audio = Buffer.from(await res.arrayBuffer());
    this.lastTrace = [`heygen-${this.ttsModel};200;${this.now() - t0}`];
    if (audio.length < 200) throw new AppError('provider_unavailable', 'HeyGen stopped before any audio was made.');
    return { audio, mimeType: 'audio/mpeg' };
  }

  /** Call voice: resolves at the first PCM16 audio (24 kHz mono), the rest arrives as it is made. */
  async speakStream(req: SpeechRequest): Promise<SpeechStream> {
    const t0 = this.now();
    const res = await this.call('/v3/models/audio/tts/stream', { method: 'POST', body: this.body(req, 'pcm'), signal: withTimeout(req.signal, this.o.timeoutMs) });
    const rate = Number(res.headers.get('x-audio-sample-rate')) || SAMPLE_RATE;
    if (!res.body) throw new AppError('provider_unavailable', 'HeyGen sent no audio.');
    const reader = res.body.getReader();
    let carry: Buffer = Buffer.alloc(0);
    // Whole samples only (2 bytes each), so the call player never gets half a sample.
    const take = (chunk: Uint8Array | undefined): Buffer | null => {
      const all = chunk ? Buffer.concat([carry, Buffer.from(chunk)]) : carry;
      const even = all.length - (all.length % 2);
      carry = all.subarray(even);
      return even ? all.subarray(0, even) : null;
    };
    let first: Buffer | null = null;
    while (!first) {
      const { done, value } = await reader.read().catch((e: unknown) => {
        throw new AppError((e as Error)?.name === 'TimeoutError' ? 'timeout' : 'provider_unavailable', `HeyGen stopped before any audio (${(e as Error)?.message ?? e}).`);
      });
      if (done) throw new AppError('provider_unavailable', 'HeyGen stopped before any audio was made.');
      first = take(value);
    }
    this.lastTrace = [`heygen-${this.ttsModel};200;${this.now() - t0}`];
    async function* rest(): AsyncIterable<Buffer> {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          const b = take(value);
          if (b) yield b;
        }
      } catch {
        // HeyGen closes the connection when synthesis fails after audio started: end with what we have.
      } finally {
        reader.releaseLock?.();
      }
    }
    return { sampleRate: rate, model: `heygen:${this.ttsModel}`, first, rest: rest() };
  }

  private async call(path: string, init: RequestInit): Promise<Response> {
    if (this.coolUntil > this.now()) {
      throw new AppError('provider_rate_limited', `HeyGen is over its request limit for about ${Math.ceil((this.coolUntil - this.now()) / 1000)} more seconds.`);
    }
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: { 'X-Api-Key': this.o.apiKey, accept: init.method === 'GET' ? 'application/json' : '*/*', ...(init.body ? { 'content-type': 'application/json' } : {}) },
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === 'TimeoutError') throw new AppError('timeout', 'HeyGen took too long to respond.');
      if (e?.name === 'AbortError') throw new AppError('cancelled', 'The request was cancelled.');
      throw new AppError('provider_unavailable', "Couldn't reach HeyGen just now.");
    }
    if (res.ok) return res;
    let code = '';
    let message = '';
    let param = '';
    try {
      const j = (await res.json()) as { error?: { code?: string; message?: string; param?: string } };
      code = j.error?.code ?? '';
      message = (j.error?.message ?? '').slice(0, 200);
      param = j.error?.param ?? '';
    } catch {
      /* not JSON */
    }
    throw heygenError(res.status, code, message, param, res.headers.get('retry-after'), (ms) => (this.coolUntil = this.now() + ms));
  }
}

function heygenError(status: number, code: string, message: string, param: string, retryAfter: string | null, cool: (ms: number) => void): AppError {
  if (status === 401 || status === 403 || /api_key|unauthori[sz]ed|authentication/i.test(code)) {
    return new AppError('invalid_api_key', 'HeyGen rejected the key. Check it, or create a new one at platform.heygen.com/api-keys.', { retryable: false });
  }
  if (status === 402 || code === 'insufficient_credit') {
    return new AppError('provider_rate_limited', 'HeyGen says the API credit balance is empty. Use the free model heygen-voice-1-turbo-free, or add API credit in HeyGen.', { retryable: false });
  }
  if (status === 429) {
    const secs = Math.min(600, Math.max(0, Number(retryAfter) || 0));
    if (secs > 0) cool(secs * 1000);
    return new AppError('provider_rate_limited', `HeyGen is over its request limit right now${secs ? ` (try again in ${secs} seconds)` : ''}. Free voice capacity is shared, so this can happen even under your own limit.`);
  }
  if (status === 400 || status === 404 || status === 422) {
    if (param === 'voice_id' || /voice/i.test(code)) return new AppError('provider_bad_request', `HeyGen can't use that voice${message ? `: ${message}` : ''}. Pick another voice.`, { retryable: false });
    if (param === 'model') return new AppError('provider_bad_request', `HeyGen refused the speaking model${message ? `: ${message}` : ''}. Leave Speaking model empty to use the free Turbo model.`, { retryable: false });
    if (param === 'language') return new AppError('provider_bad_request', "HeyGen can't speak the language of that reply.", { retryable: false });
    return new AppError('provider_bad_request', `HeyGen refused the request${message ? `: ${message}` : ` (HTTP ${status})`}.`, { retryable: false });
  }
  if (status === 408 || status === 504) return new AppError('timeout', 'HeyGen timed out.');
  return new AppError('provider_unavailable', `HeyGen is unavailable right now (HTTP ${status}).`);
}
