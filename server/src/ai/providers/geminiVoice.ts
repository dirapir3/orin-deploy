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

/** Each character's own voice and speaking style. */
export const CHARACTER_VOICES: Record<string, { voice: string; style: string }> = {
  orin: { voice: 'Sulafat', style: 'Speak warmly and naturally, like a thoughtful friend' },
  nova: { voice: 'Laomedeia', style: 'Speak with bright, playful energy and a smile in your voice' },
  sage: { voice: 'Gacrux', style: 'Speak calmly and slowly, with a gentle, unhurried pace' },
  max: { voice: 'Orus', style: 'Speak briskly and directly, with dry confidence' },
};

export function characterVoice(character?: string | null): { voice: string; style: string } {
  return CHARACTER_VOICES[character ?? ''] ?? CHARACTER_VOICES.orin!;
}

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
    this.ttsModels = o.ttsModels?.length ? o.ttsModels : ['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview', 'gemini-3.8-flash-tts'];
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

  /** Tries each model x key until one answers; skips keys/models that just failed with a limit. */
  private async generate(models: string[], body: unknown, signal: AbortSignal | undefined, what: string): Promise<GenResponse> {
    const keys = this.o.keys.filter(Boolean);
    if (!keys.length) throw new AppError('voice_not_configured', 'No Gemini key is set for voice.');
    const now = Date.now();
    const orderedModels = [...models].sort((a, b) => Number((this.modelCooling.get(a) ?? 0) > now) - Number((this.modelCooling.get(b) ?? 0) > now));
    const orderedKeys = [...keys].sort((a, b) => Number((sharedKeyHealth.cooling.get(keyId(a)) ?? 0) > now) - Number((sharedKeyHealth.cooling.get(keyId(b)) ?? 0) > now));
    let last: AppError | null = null;
    for (const model of orderedModels) {
      for (const key of orderedKeys) {
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
          if (signal?.aborted) throw new AppError('cancelled', 'The request was cancelled.');
          last = new AppError(e?.name === 'TimeoutError' ? 'timeout' : 'provider_unavailable', `Gemini ${what} did not answer.`);
          continue;
        }
        if (res.ok) {
          sharedKeyHealth.recordOk(keyId(key), Date.now());
          return (await res.json()) as GenResponse;
        }
        const snippet = (await res.text().catch(() => '')).slice(0, 500);
        let err: AppError;
        if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(snippet)) err = new AppError('invalid_api_key', 'Google Gemini rejected a key.');
        else if (res.status === 429) err = new AppError('provider_rate_limited', `Gemini ${what} limit reached. Try again shortly.`);
        else err = providerHttpError(res.status, `Google Gemini ${what}`, snippet);
        sharedKeyHealth.recordFail(keyId(key), Date.now(), err.code, err.message);
        last = err;
        if (res.status === 404 || res.status === 503) {
          // the model is missing or overloaded for everyone: move to the next model
          this.modelCooling.set(model, Date.now() + 60_000);
          break;
        }
        if (!RETRYABLE.has(err.code)) throw err;
      }
    }
    throw last ?? new AppError('provider_unavailable', `Gemini ${what} is unavailable.`);
  }

  async transcribe(req: TranscribeRequest): Promise<{ text: string }> {
    const mime = req.mimeType === 'audio/x-m4a' || req.mimeType === 'audio/m4a' ? 'audio/mp4' : req.mimeType || 'audio/mp4';
    const lang = req.language ? ` The speaker is most likely using language code "${req.language}".` : '';
    const json = await this.generate(
      this.sttModels,
      {
        systemInstruction: {
          parts: [{ text: `You are a speech-to-text engine. Transcribe exactly what is said in the audio, in the language spoken, with normal punctuation.${lang} Output only the transcript. If there is no intelligible speech, output nothing at all.` }],
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

  async speak(req: SpeechRequest & { style?: string }): Promise<{ audio: Buffer; mimeType: string }> {
    if (!this.supportsTts) throw new AppError('voice_not_configured', 'Server voices are off on this server; the app speaks with the device voice.');
    const voice = GEMINI_VOICES.some((v) => v.id === req.voice) ? req.voice! : this.defaultVoice();
    const style = req.style ? `${req.style}: ` : '';
    const json = await this.generate(
      this.ttsModels,
      {
        contents: [{ role: 'user', parts: [{ text: `${style}${req.text}` }] }],
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
}
