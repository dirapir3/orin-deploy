import { AppError, providerHttpError } from '../../errors.js';
import type { FetchLike } from '../http.js';
import { keyId, sharedKeyHealth } from '../keyHealth.js';
import type { SpeechRequest, TranscribeRequest, VoiceInfo, VoiceProvider } from '../types.js';

/**
 * Speech on the user's own Gemini keys: speech-to-text with a Flash model (audio in, text out)
 * and text-to-speech with the Gemini TTS models (30 prebuilt voices, 24 kHz PCM, wrapped as WAV).
 * Keys rotate in order: a key that is rate limited or out of quota is skipped for a while.
 */
export const GEMINI_VOICES: VoiceInfo[] = [
  { id: 'Sulafat', name: 'Sulafat · warm' },
  { id: 'Laomedeia', name: 'Laomedeia · upbeat' },
  { id: 'Gacrux', name: 'Gacrux · mature' },
  { id: 'Orus', name: 'Orus · firm' },
  { id: 'Puck', name: 'Puck · upbeat' },
  { id: 'Kore', name: 'Kore · firm' },
  { id: 'Charon', name: 'Charon · informative' },
  { id: 'Aoede', name: 'Aoede · breezy' },
  { id: 'Zephyr', name: 'Zephyr · bright' },
  { id: 'Fenrir', name: 'Fenrir · excitable' },
  { id: 'Leda', name: 'Leda · youthful' },
  { id: 'Achird', name: 'Achird · friendly' },
  { id: 'Vindemiatrix', name: 'Vindemiatrix · gentle' },
  { id: 'Enceladus', name: 'Enceladus · breathy' },
  { id: 'Algieba', name: 'Algieba · smooth' },
  { id: 'Despina', name: 'Despina · smooth' },
  { id: 'Iapetus', name: 'Iapetus · clear' },
  { id: 'Schedar', name: 'Schedar · even' },
];

/**
 * Each character's own fixed voice: two female, two male. Only the spoken words go to the voice
 * model; no speaking directions are sent (they used to be pasted in front of the text and were
 * sometimes read out loud).
 */
export const CHARACTER_VOICES: Record<string, { voice: string; gender: 'female' | 'male' }> = {
  orin: { voice: 'Sulafat', gender: 'female' },
  nova: { voice: 'Laomedeia', gender: 'female' },
  sage: { voice: 'Algieba', gender: 'male' },
  max: { voice: 'Orus', gender: 'male' },
};

export function characterVoice(character?: string | null): { voice: string; gender: 'female' | 'male' } {
  return CHARACTER_VOICES[character ?? ''] ?? CHARACTER_VOICES.orin!;
}

/**
 * Removes stage directions before text is spoken: "(softly)", "[laughs]", "*smiles*", and a
 * leading "Speaking warmly:" / "Speak calmly and slowly, ...:" line. Real words are kept.
 */
export function cleanSpokenText(text: string): string {
  let t = text;
  // *laughs*, _sighs_ (short, no sentence end inside): acting notes, not emphasis on real words
  t = t.replace(/(^|\s)[*_]{1,2}([a-z][a-z ,'-]{1,40})[*_]{1,2}(?=\s|[.,!?]|$)/gi, (m, pre: string, inner: string) =>
    ACTING_WORDS.test(inner) ? pre : m,
  );
  // (softly), [laughs], (in a warm voice)
  t = t.replace(/[([]\s*([a-z][a-z ,'-]{0,40})\s*[)\]]/gi, (m, inner: string) => (ACTING_WORDS.test(inner) ? ' ' : m));
  // a leading direction ending in a colon: "Speaking warmly:", "Speak calmly and slowly, like a friend:"
  t = t.replace(/^\s*(?:\(|\[)?\s*(?:speak(?:ing|s)?|say(?:ing|s)?|read(?:ing)?|in an? [a-z]+ (?:voice|tone))\b[^:.!?\n]{0,80}:\s*/i, '');
  return t.replace(/\s{2,}/g, ' ').replace(/\s+([.,!?])/g, '$1').trim();
}

const ACTING_WORDS =
  /^(?:\s*(?:softly|gently|warmly|quietly|calmly|slowly|briskly|brightly|cheerfully|playfully|excitedly|happily|sadly|seriously|thoughtfully|dryly|sighs?|sighing|laughs?|laughing|chuckles?|chuckling|giggles?|smiles?|smiling|grins?|grinning|pauses?|pausing|whispers?|whispering|clears throat|clearing throat|beat|in a [a-z ]+ (?:voice|tone)|with a [a-z ]+|warm(?:ly)? tone|upbeat|cheerful(?:ly)?|speaking [a-z ]+|said [a-z ]+)\s*[,.]?)+$/i;

/** 16-bit little-endian mono PCM -> WAV file. */
export function pcmToWav(pcm: Buffer, sampleRate = 24_000, channels = 1, bits = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = (sampleRate * channels * bits) / 8;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/**
 * How long a key+model rests after a 429. Gemini says which quota ran out and when to retry
 * (RetryInfo.retryDelay): a per-day quota rests until it resets, a per-minute one for its delay.
 */
export function quotaRestMs(body: string): number {
  const delay = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body);
  const perDay = /PerDay|per day|RequestsPerDay/i.test(body);
  if (delay) {
    const ms = Math.ceil(Number(delay[1]) * 1000);
    return Math.min(Math.max(ms, perDay ? 60_000 : 5_000), 24 * 3600_000);
  }
  return perDay ? 3600_000 : 30_000;
}

export function humanWait(ms: number): string {
  const min = Math.round(ms / 60_000);
  if (min < 1) return `${Math.max(1, Math.round(ms / 1000))} seconds`;
  if (min < 90) return `${min} minute${min === 1 ? '' : 's'}`;
  return `${Math.round(min / 60)} hours`;
}

/** Reads Gemini's SSE stream (one JSON object per `data:` line) and yields each parsed object. */
async function* sseObjects(body: ReadableStream<Uint8Array>): AsyncGenerator<GenResponse> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        try {
          yield JSON.parse(line.slice(5)) as GenResponse;
        } catch {
          // a keep-alive or a broken line: skip it
        }
      }
    }
    const tail = buf.trim();
    if (tail.startsWith('data:')) {
      try {
        yield JSON.parse(tail.slice(5)) as GenResponse;
      } catch {
        // ignore
      }
    }
  } finally {
    reader.releaseLock?.();
  }
}

function audioParts(obj: GenResponse): { data: string; mimeType?: string }[] {
  return (obj.candidates?.[0]?.content?.parts ?? []).filter((p) => p.inlineData?.data).map((p) => ({ data: p.inlineData!.data!, mimeType: p.inlineData!.mimeType }));
}

export interface SpeechStream {
  sampleRate: number;
  model: string;
  /** the first audio, already received (so a failure before any audio fell through to the next key/model) */
  first: Buffer;
  rest: AsyncIterable<Buffer>;
}

interface Options {
  keys: string[];
  baseUrl?: string;
  timeoutMs?: number;
  sttModels?: string[];
  ttsModels?: string[];
  fetchImpl?: FetchLike;
  /** false: speech-to-text only; the app speaks replies with the device voice (default true) */
  tts?: boolean;
}

interface GenResponse {
  candidates?: { content?: { parts?: { text?: string; thought?: boolean; inlineData?: { mimeType?: string; data?: string } }[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
}

const RETRYABLE = new Set<string>(['provider_rate_limited', 'provider_unavailable', 'timeout', 'invalid_api_key']);

export class GeminiVoiceProvider implements VoiceProvider {
  readonly id = 'gemini';
  readonly supportsTts: boolean;
  readonly sttModel: string;
  readonly ttsModel: string;
  private readonly fetchImpl: FetchLike;
  private readonly base: string;
  private readonly sttModels: string[];
  private readonly ttsModels: string[];
  /** model -> time until which it is skipped (busy / quota) */
  private readonly modelCooling = new Map<string, number>();

  constructor(private readonly o: Options) {
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.base = (o.baseUrl || 'https://generativelanguage.googleapis.com/v1beta').replace(/\/+$/, '');
    this.sttModels = o.sttModels?.length ? o.sttModels : ['gemini-3.5-flash-lite', 'gemini-flash-lite-latest', 'gemini-3.5-flash', 'gemini-3.8-flash'];
    this.ttsModels = o.ttsModels?.length ? o.ttsModels : ['gemini-3.1-flash-tts-preview', 'gemini-2.5-flash-preview-tts', 'gemini-3.8-flash-tts'];
    this.sttModel = this.sttModels[0]!;
    this.supportsTts = o.tts !== false;
    this.ttsModel = this.supportsTts ? this.ttsModels[0]! : '';
  }

  voices(): VoiceInfo[] {
    return GEMINI_VOICES;
  }

  defaultVoice(): string {
    return CHARACTER_VOICES.orin!.voice;
  }

  /** (key, model) -> time until which that pair is skipped: Gemini quotas are per model and per key. */
  private readonly pairCooling = new Map<string, number>();
  /** Last attempts made by generate()/speakStream(), for the Server-Timing header and latency probes. */
  lastTrace: string[] = [];

  private pairKey(key: string, model: string) {
    return `${keyId(key)}|${model}`;
  }

  /** Earliest time any of these models can answer again on any key (0 = now). */
  restingUntil(kind: 'tts' | 'stt'): number {
    const models = kind === 'tts' ? this.ttsModels : this.sttModels;
    const keys = this.o.keys.filter(Boolean);
    const now = Date.now();
    let soonest = Infinity;
    for (const m of models) {
      if ((this.modelCooling.get(m) ?? 0) > now) continue;
      for (const k of keys) soonest = Math.min(soonest, Math.max(now, this.pairCooling.get(this.pairKey(k, m)) ?? 0));
    }
    if (soonest === Infinity) {
      // every model cooling as a whole: the first to come back
      soonest = Math.min(...models.map((m) => this.modelCooling.get(m) ?? now));
    }
    return soonest <= now ? 0 : soonest;
  }

  /** The (model, key) pairs worth trying now, in order; throws at once when all of them are resting. */
  private candidates(models: string[], what: string): { model: string; key: string }[] {
    const keys = this.o.keys.filter(Boolean);
    if (!keys.length) throw new AppError('voice_not_configured', 'No Gemini key is set for voice.');
    const now = Date.now();
    const orderedModels = [...models].sort((a, b) => Number((this.modelCooling.get(a) ?? 0) > now) - Number((this.modelCooling.get(b) ?? 0) > now));
    const orderedKeys = [...keys].sort((a, b) => Number((sharedKeyHealth.cooling.get(keyId(a)) ?? 0) > now) - Number((sharedKeyHealth.cooling.get(keyId(b)) ?? 0) > now));
    const out: { model: string; key: string }[] = [];
    for (const model of orderedModels) for (const key of orderedKeys) if ((this.pairCooling.get(this.pairKey(key, model)) ?? 0) <= now) out.push({ model, key });
    if (!out.length) {
      const until = this.restingUntil(what === 'voice' ? 'tts' : 'stt');
      const retryAfterMs = Math.max(1000, until - now);
      throw new AppError('provider_rate_limited', `Gemini ${what} limit reached on every key. It comes back in about ${humanWait(retryAfterMs)}.`, { details: { retryAfterMs } });
    }
    return out;
  }

  /** Reads a non-OK Gemini answer: the error to report and, for a 429, how long this key+model rests. */
  private classify(status: number, body: string, what: string, key: string, model: string): { err: AppError; nextModel: boolean } {
    let err: AppError;
    if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(body)) err = new AppError('invalid_api_key', 'Google Gemini rejected a key.');
    else if (status === 429) {
      const rest = quotaRestMs(body);
      this.pairCooling.set(this.pairKey(key, model), Date.now() + rest);
      err = new AppError('provider_rate_limited', `Gemini ${what} limit reached. Try again shortly.`, { details: { retryAfterMs: rest } });
    } else err = providerHttpError(status, `Google Gemini ${what}`, body.slice(0, 500));
    sharedKeyHealth.recordFail(keyId(key), Date.now(), err.code, err.message);
    // a TTS model that tried to answer a short line instead of reading it: the next model reads it
    const wroteText = status === 400 && /tried to generate text|only be used for TTS/i.test(body);
    if (status === 404 || status === 503 || wroteText) {
      // the model is missing or overloaded for everyone: move to the next model
      if (!wroteText) this.modelCooling.set(model, Date.now() + 60_000);
      return { err, nextModel: true };
    }
    if (!RETRYABLE.has(err.code)) throw err;
    return { err, nextModel: false };
  }

  /** Tries each model x key until one answers; skips pairs that are resting after a limit. */
  private async generate(models: string[], body: unknown, signal: AbortSignal | undefined, what: string): Promise<GenResponse> {
    const trace: string[] = [];
    this.lastTrace = trace;
    let last: AppError | null = null;
    let skipModel = '';
    for (const { model, key } of this.candidates(models, what)) {
      if (model === skipModel) continue;
      const t0 = Date.now();
      const timeout = AbortSignal.timeout(this.o.timeoutMs ?? 45_000);
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/models/${encodeURIComponent(model)}:generateContent`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify(body),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
      } catch (err) {
        const e = err as Error;
        trace.push(`${model};err;${Date.now() - t0}`);
        if (signal?.aborted) throw new AppError('cancelled', 'The request was cancelled.');
        last = new AppError(e?.name === 'TimeoutError' ? 'timeout' : 'provider_unavailable', `Gemini ${what} did not answer.`);
        continue;
      }
      if (res.ok) {
        sharedKeyHealth.recordOk(keyId(key), Date.now());
        const json = (await res.json()) as GenResponse;
        trace.push(`${model};200;${Date.now() - t0}`);
        return json;
      }
      const text = await res.text().catch(() => '');
      trace.push(`${model};${res.status};${Date.now() - t0}`);
      const c = this.classify(res.status, text, what, key, model);
      last = c.err;
      if (c.nextModel) skipModel = model;
    }
    throw last ?? new AppError('provider_unavailable', `Gemini ${what} is unavailable.`);
  }

  async transcribe(req: TranscribeRequest): Promise<{ text: string }> {
    const mime = req.mimeType === 'audio/x-m4a' || req.mimeType === 'audio/m4a' ? 'audio/mp4' : req.mimeType || 'audio/mp4';
    const lang = req.language ? ` The speaker is most likely using language code "${req.language}".` : '';
    // Voice call barge-in: the assistant's own voice may be heard first; only the person counts.
    const echo = req.ignore
      ? ` The recording was made during a voice call while an AI assistant was talking through the phone speaker, so its voice may be heard${req.speechAt ? `, mostly before about ${req.speechAt.toFixed(1)} seconds in` : ''}. It was saying: "${req.ignore.replace(/"/g, "'")}". Leave the assistant's words out completely and write only what the person says.`
      : '';
    const json = await this.generate(
      this.sttModels,
      {
        systemInstruction: {
          parts: [{ text: `You are a speech-to-text engine. Transcribe exactly what is said in the audio, in the language spoken, with normal punctuation.${lang}${echo} Output only the transcript. If there is no intelligible speech, output nothing at all.` }],
        },
        contents: [{ role: 'user', parts: [{ inlineData: { mimeType: mime, data: req.audio.toString('base64') } }, { text: 'Transcribe this audio.' }] }],
        generationConfig: { temperature: 0, maxOutputTokens: 1024 },
      },
      req.signal,
      'speech-to-text',
    );
    const text = (json.candidates?.[0]?.content?.parts ?? [])
      .filter((p) => p.text && !p.thought)
      .map((p) => p.text)
      .join('')
      .trim();
    // Models sometimes describe silence instead of returning nothing.
    if (/^\(?\[?(no (intelligible )?speech|silence|inaudible)[^\w]*\]?\)?\.?$/i.test(text)) return { text: '' };
    return { text };
  }

  async speak(req: SpeechRequest): Promise<{ audio: Buffer; mimeType: string }> {
    if (!this.supportsTts) throw new AppError('voice_not_configured', 'Server voices are off on this server; the app speaks with the device voice.');
    const voice = GEMINI_VOICES.some((v) => v.id === req.voice) ? req.voice! : this.defaultVoice();
    // only the words to say: no speaking directions in front (they could be read out loud)
    const words = cleanSpokenText(req.text);
    if (!words) throw new AppError('validation_error', 'Nothing to say.');
    const json = await this.generate(
      this.ttsModels,
      {
        contents: [{ role: 'user', parts: [{ text: words }] }],
        generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      },
      req.signal,
      'voice',
    );
    const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part?.inlineData?.data) throw new AppError('provider_unavailable', 'Gemini returned no audio.');
    const pcm = Buffer.from(part.inlineData.data, 'base64');
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24_000);
    return { audio: pcmToWav(pcm, rate), mimeType: 'audio/wav' };
  }
  /**
   * The voice as it is made (streamGenerateContent over SSE). Resolves when the first audio has
   * arrived, usually well under a second, instead of after the whole sentence is synthesised.
   */
  async speakStream(req: SpeechRequest): Promise<SpeechStream> {
    if (!this.supportsTts) throw new AppError('voice_not_configured', 'Server voices are off on this server; the app speaks with the device voice.');
    const voice = GEMINI_VOICES.some((v) => v.id === req.voice) ? req.voice! : this.defaultVoice();
    const words = cleanSpokenText(req.text);
    if (!words) throw new AppError('validation_error', 'Nothing to say.');
    const body = JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: words }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    });
    const trace: string[] = [];
    this.lastTrace = trace;
    let last: AppError | null = null;
    let skipModel = '';
    for (const { model, key } of this.candidates(this.ttsModels, 'voice')) {
      if (model === skipModel) continue;
      const t0 = Date.now();
      // the whole stream may take longer than one request; the timeout covers it end to end
      const timeout = AbortSignal.timeout(Math.max(this.o.timeoutMs ?? 45_000, 90_000));
      const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
      let res: Response;
      try {
        res = await this.fetchImpl(`${this.base}/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
          body,
          signal,
        });
      } catch (err) {
        const e = err as Error;
        trace.push(`${model};err;${Date.now() - t0}`);
        if (req.signal?.aborted) throw new AppError('cancelled', 'The request was cancelled.');
        last = new AppError(e?.name === 'TimeoutError' ? 'timeout' : 'provider_unavailable', 'Gemini voice did not answer.');
        continue;
      }
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        trace.push(`${model};${res.status};${Date.now() - t0}`);
        const c = this.classify(res.status || 502, text, 'voice', key, model);
        last = c.err;
        if (c.nextModel) skipModel = model;
        continue;
      }
      const objects = sseObjects(res.body);
      let first: Buffer | null = null;
      let rate = 24_000;
      try {
        for (;;) {
          const n = await objects.next();
          if (n.done) break;
          const parts = audioParts(n.value);
          if (parts.length) {
            rate = Number(/rate=(\d+)/.exec(parts[0]!.mimeType ?? '')?.[1] ?? 24_000);
            first = Buffer.concat(parts.map((p) => Buffer.from(p.data, 'base64')));
            break;
          }
        }
      } catch (err) {
        if (req.signal?.aborted) throw new AppError('cancelled', 'The request was cancelled.');
        last = new AppError((err as Error)?.name === 'TimeoutError' ? 'timeout' : 'provider_unavailable', 'Gemini voice stopped before any audio.');
        trace.push(`${model};broken;${Date.now() - t0}`);
        continue;
      }
      if (!first) {
        // answered without audio (e.g. tried to write text): the next model reads it
        trace.push(`${model};noaudio;${Date.now() - t0}`);
        last = new AppError('provider_unavailable', 'Gemini returned no audio.');
        skipModel = model;
        continue;
      }
      sharedKeyHealth.recordOk(keyId(key), Date.now());
      trace.push(`${model};200;first=${Date.now() - t0}`);
      const rest = (async function* () {
        try {
          for (;;) {
            const n = await objects.next();
            if (n.done) return;
            for (const p of audioParts(n.value)) yield Buffer.from(p.data, 'base64');
          }
        } catch {
          // the stream broke off mid-sentence: what was already sent still plays
        }
      })();
      return { sampleRate: rate, model, first, rest };
    }
    throw last ?? new AppError('provider_unavailable', 'Gemini voice is unavailable.');
  }
}
