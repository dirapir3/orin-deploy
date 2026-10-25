import { AppError } from '../../errors.js';
import { providerFetch, withTimeout, type FetchLike } from '../http.js';
import type { SpeechRequest, TranscribeRequest, VoiceInfo, VoiceProvider } from '../types.js';

interface Base {
  apiKey: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

/**
 * ElevenLabs: speech-to-text (Scribe) and text-to-speech.
 * Models per the ElevenLabs docs (Oct 2026): scribe_v2 (STT), eleven_flash_v2_5 (low-latency TTS).
 * Voices are loaded from GET /v1/voices, since the premade set differs per account.
 */
export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly id = 'elevenlabs';
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly supportsTts = true;
  private readonly fetchImpl: FetchLike;
  private list: VoiceInfo[] = [];
  private loading: Promise<void> | null = null;

  constructor(private readonly o: Base & { sttModel?: string; ttsModel?: string; voiceId?: string; baseUrl?: string }) {
    this.sttModel = o.sttModel || 'scribe_v2';
    this.ttsModel = o.ttsModel || 'eleven_flash_v2_5';
    this.fetchImpl = o.fetchImpl ?? fetch;
    if (o.voiceId) this.list = [{ id: o.voiceId, name: 'Default voice' }];
  }

  private get base() {
    return (this.o.baseUrl || 'https://api.elevenlabs.io').replace(/\/+$/, '');
  }

  /** Fetches the account's voices in the background (never throws). */
  loadVoices(): Promise<void> {
    this.loading ??= (async () => {
      try {
        const res = await this.fetchImpl(`${this.base}/v1/voices`, { headers: { 'xi-api-key': this.o.apiKey }, signal: AbortSignal.timeout(10_000) });
        if (!res.ok) return;
        const json = (await res.json()) as { voices?: { voice_id: string; name: string }[] };
        const found = (json.voices ?? []).map((v) => ({ id: v.voice_id, name: v.name }));
        if (found.length) {
          const preferred = this.o.voiceId ? found.filter((v) => v.id === this.o.voiceId) : [];
          this.list = [...preferred, ...found.filter((v) => v.id !== this.o.voiceId)].slice(0, 30);
        }
      } catch {
        /* keep the configured voice */
      }
    })();
    return this.loading;
  }

  voices(): VoiceInfo[] {
    return this.list;
  }

  defaultVoice(): string {
    return this.o.voiceId || this.list[0]?.id || '';
  }

  async transcribe(req: TranscribeRequest): Promise<{ text: string }> {
    const form = new FormData();
    form.append('model_id', this.sttModel);
    form.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mimeType }), req.filename);
    if (req.language) form.append('language_code', req.language);
    const res = await providerFetch(this.fetchImpl, 'ElevenLabs', `${this.base}/v1/speech-to-text`, {
      method: 'POST',
      headers: { 'xi-api-key': this.o.apiKey },
      body: form,
      signal: withTimeout(req.signal, this.o.timeoutMs),
    });
    const json = (await res.json()) as { text?: string };
    return { text: (json.text ?? '').trim() };
  }

  async speak(req: SpeechRequest): Promise<{ audio: Buffer; mimeType: string }> {
    if (!this.list.length && !this.o.voiceId) await this.loadVoices();
    const known = this.list.some((v) => v.id === req.voice);
    const voice = known ? req.voice : this.defaultVoice();
    if (!voice) throw new AppError('voice_not_configured', 'No ElevenLabs voice found. Set ELEVENLABS_VOICE_ID in the admin page.');
    const res = await providerFetch(this.fetchImpl, 'ElevenLabs', `${this.base}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'xi-api-key': this.o.apiKey, Accept: 'audio/mpeg' },
      body: JSON.stringify({ text: req.text, model_id: this.ttsModel }),
      signal: withTimeout(req.signal, this.o.timeoutMs),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new AppError('provider_unavailable', 'ElevenLabs returned no audio.');
    return { audio, mimeType: 'audio/mpeg' };
  }
}

/** Deepgram voices for Aura-2 (model = voice). aura-2-thalia-en is the documented example; others needs-verify. */
const DEEPGRAM_VOICES = ['aura-2-thalia-en', 'aura-2-asteria-en', 'aura-2-luna-en', 'aura-2-helena-en', 'aura-2-apollo-en', 'aura-2-arcas-en'];

/** Deepgram: speech-to-text (nova-3) and text-to-speech (Aura-2). */
export class DeepgramVoiceProvider implements VoiceProvider {
  readonly id = 'deepgram';
  readonly sttModel: string;
  readonly ttsModel: string;
  readonly supportsTts = true;
  private readonly fetchImpl: FetchLike;

  constructor(private readonly o: Base & { sttModel?: string; ttsVoice?: string; baseUrl?: string }) {
    this.sttModel = o.sttModel || 'nova-3';
    this.ttsModel = o.ttsVoice || 'aura-2-thalia-en';
    this.fetchImpl = o.fetchImpl ?? fetch;
  }

  private get base() {
    return (this.o.baseUrl || 'https://api.deepgram.com').replace(/\/+$/, '');
  }

  voices(): VoiceInfo[] {
    const ids = [this.ttsModel, ...DEEPGRAM_VOICES.filter((v) => v !== this.ttsModel)];
    return ids.map((id) => ({ id, name: (id.split('-')[2] ?? id).replace(/^./, (c) => c.toUpperCase()) }));
  }

  defaultVoice(): string {
    return this.ttsModel;
  }

  async transcribe(req: TranscribeRequest): Promise<{ text: string }> {
    const q = new URLSearchParams({ model: this.sttModel, smart_format: 'true' });
    if (req.language) q.set('language', req.language);
    else q.set('detect_language', 'true');
    const res = await providerFetch(this.fetchImpl, 'Deepgram', `${this.base}/v1/listen?${q}`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.o.apiKey}`, 'Content-Type': req.mimeType || 'application/octet-stream' },
      body: new Uint8Array(req.audio),
      signal: withTimeout(req.signal, this.o.timeoutMs),
    });
    const json = (await res.json()) as { results?: { channels?: { alternatives?: { transcript?: string }[] }[] } };
    return { text: (json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '').trim() };
  }

  async speak(req: SpeechRequest): Promise<{ audio: Buffer; mimeType: string }> {
    const voice = req.voice?.startsWith('aura') ? req.voice : this.ttsModel;
    const res = await providerFetch(this.fetchImpl, 'Deepgram', `${this.base}/v1/speak?model=${encodeURIComponent(voice)}&encoding=mp3`, {
      method: 'POST',
      headers: { Authorization: `Token ${this.o.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: req.text }),
      signal: withTimeout(req.signal, this.o.timeoutMs),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new AppError('provider_unavailable', 'Deepgram returned no audio.');
    return { audio, mimeType: 'audio/mpeg' };
  }
}

/** Speech-to-text from one provider, text-to-speech from another (e.g. Groq Whisper + ElevenLabs voices). */
export class SplitVoiceProvider implements VoiceProvider {
  readonly id: string;
  constructor(
    private readonly stt: VoiceProvider,
    private readonly tts: VoiceProvider,
  ) {
    this.id = stt.id === tts.id ? stt.id : `${stt.id}+${tts.id}`;
  }
  get sttModel() {
    return this.stt.sttModel;
  }
  get ttsModel() {
    return this.tts.ttsModel;
  }
  get supportsTts() {
    return this.tts.supportsTts;
  }
  voices() {
    return this.tts.voices();
  }
  defaultVoice() {
    return this.tts.defaultVoice();
  }
  transcribe(req: TranscribeRequest) {
    return this.stt.transcribe(req);
  }
  speak(req: SpeechRequest) {
    return this.tts.speak(req);
  }
}
