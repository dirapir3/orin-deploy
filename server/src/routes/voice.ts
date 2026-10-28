import { Router } from 'express';
import multer from 'multer';
import { voiceInstructions } from '../ai/prompt.js';
import { CHARACTER_VOICES, characterVoice, cleanSpokenText } from '../ai/providers/geminiVoice.js';
import type { Deps } from '../app.js';
import { AppError, toAppError } from '../errors.js';
import { SpeechRequestSchema } from '../schemas.js';
import { parseBody } from './util.js';
import { ttsStreams } from '../ai/ttsStream.js';

const AUDIO_TYPES = new Set([
  'audio/mp4',
  'audio/m4a',
  'audio/x-m4a',
  'audio/aac',
  'audio/mpeg',
  'audio/mp3',
  'audio/wav',
  'audio/x-wav',
  'audio/wave',
  'audio/webm',
  'audio/ogg',
  'audio/3gpp',
  'video/mp4', // some Android recorders label m4a as video/mp4
]);

const EXT: Record<string, string> = {
  'audio/mp4': 'm4a',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'video/mp4': 'm4a',
  'audio/aac': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/webm': 'webm',
  'audio/ogg': 'ogg',
  'audio/3gpp': 'm4a',
};

export function voiceRouter(deps: Deps) {
  const r = Router();
  const { providers, usage, config } = deps;
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.access.maxAudioBytes, files: 1 } });

  const requireVoice = () => {
    if (!providers.voice) {
      throw new AppError(
        'voice_not_configured',
        'Server speech-to-text is not set up. Voice input in Expo Go needs it: add a free GROQ_API_KEY (Whisper) or an OpenAI key to server/.env and restart. Development builds can use the phone\'s own recognizer instead.',
      );
    }
    return providers.voice;
  };

  /**
   * THE single seam for per-account voice routing (AI setup hub, task ab4a33ca): return the
   * account's own STT/TTS provider here, else the server default. Every voice route (transcribe,
   * speech, speech/start, voices) goes through it, so a setting changes real calls. A provider
   * without speakStream/restingUntil simply makes the app use the whole-clip /speech path.
   */
  const resolveVoice = async (_req: import('express').Request, _kind: 'stt' | 'tts'): Promise<NonNullable<typeof providers.voice>> => {
    return requireVoice();
  };

  /** Which provider attempts a voice call made (Server-Timing) and when to retry after a limit. */
  const voiceHeaders = (res: import('express').Response, v: { lastTrace?: string[] } | undefined, err?: unknown) => {
    const trace = v?.lastTrace ?? [];
    if (trace.length && !res.headersSent) {
      res.setHeader('Server-Timing', trace.map((t, i) => {
        const [model, status, ms] = t.split(';');
        const dur = /(\d+)$/.exec(ms ?? '')?.[1] ?? '0';
        return `a${i};desc="${model} ${status}";dur=${dur}`;
      }).join(', '));
    }
    const e = err ? toAppError(err) : null;
    const wait = (e?.details as { retryAfterMs?: number } | undefined)?.retryAfterMs;
    if (e?.code === 'provider_rate_limited' && wait && !res.headersSent) res.setHeader('Retry-After', String(Math.ceil(wait / 1000)));
  };

  const pickVoice = (v: NonNullable<typeof providers.voice>, character?: string, picked?: string) => {
    const voices = v.voices();
    const ch = character ? characterVoice(character) : null;
    return ch && voices.some((x) => x.id === ch.voice) ? ch.voice : picked && voices.some((x) => x.id === picked) ? picked : v.defaultVoice();
  };

  r.get('/voices', async (req, res, next) => {
    try {
      const v = await resolveVoice(req, 'tts');
      const geminiTts = v.supportsTts && v.voices().some((x) => x.id === 'Sulafat');
      res.json({
        voices: v.voices(),
        defaultVoice: v.supportsTts ? v.defaultVoice() : null,
        ttsModel: v.supportsTts ? v.ttsModel : null,
        stt: true,
        tts: v.supportsTts,
        characterVoices: geminiTts ? Object.fromEntries(Object.entries(CHARACTER_VOICES).map(([k, x]) => [k, x.voice])) : null,
        // the app goes straight to the phone voice while every server voice model is out of quota
        ttsRestingUntil: v.supportsTts && v.restingUntil ? v.restingUntil('tts') || null : null,
        streaming: Boolean(v.supportsTts && v.speakStream),
      });
    } catch (err) {
      next(err);
    }
  });

  r.post('/transcribe', upload.single('audio'), async (req, res, next) => {
    const started = Date.now();
    let voice;
    try {
      voice = await resolveVoice(req, 'stt');
      const file = req.file;
      if (!file || file.size === 0) throw new AppError('validation_error', 'No audio was received.');
      const mime = (file.mimetype || '').toLowerCase();
      if (!AUDIO_TYPES.has(mime)) throw new AppError('unsupported_file', `Unsupported audio type: ${mime || 'unknown'}.`);
      const language = typeof req.body?.language === 'string' && /^[a-z]{2}$/.test(req.body.language) ? req.body.language : undefined;
      const ignore = typeof req.body?.ignore === 'string' && req.body.ignore.trim() ? req.body.ignore.trim().slice(-2000) : undefined;
      const at = Number(req.body?.speechAt);
      const speechAt = Number.isFinite(at) && at > 0 && at < 600 ? at : undefined;
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const result = await voice.transcribe({
        audio: file.buffer,
        mimeType: mime === 'video/mp4' ? 'audio/mp4' : mime,
        filename: `speech.${EXT[mime] ?? 'm4a'}`,
        language,
        ignore,
        speechAt,
        signal: controller.signal,
      });
      usage.record(req.auth, { kind: 'stt', provider: voice.id, model: voice.sttModel, status: 'ok', units: file.size, durationMs: Date.now() - started });
      voiceHeaders(res, voice);
      res.json({ text: result.text });
    } catch (err) {
      if (voice) {
        usage.record(req.auth, { kind: 'stt', provider: voice.id, model: voice.sttModel, status: 'error', durationMs: Date.now() - started, errorCode: toAppError(err).code });
      }
      voiceHeaders(res, voice, err);
      next(err);
    }
  });

  r.post('/speech', async (req, res, next) => {
    const started = Date.now();
    let voice;
    try {
      voice = await resolveVoice(req, 'tts');
      const body = parseBody(SpeechRequestSchema, req.body);
      const voices = voice.voices();
      const ch = body.character ? characterVoice(body.character) : null;
      // each character always speaks in its own fixed voice; a picked voice only applies without one
      const chosen =
        ch && voices.some((v) => v.id === ch.voice)
          ? ch.voice
          : body.voice && voices.some((v) => v.id === body.voice)
            ? body.voice
            : voice.defaultVoice();
      const words = cleanSpokenText(body.text);
      if (!words) throw new AppError('validation_error', 'Nothing to say.');
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const out = await voice.speak({
        text: words,
        voice: chosen,
        instructions: voiceInstructions(body.preferences),
        signal: controller.signal,
      });
      usage.record(req.auth, { kind: 'tts', provider: voice.id, model: voice.ttsModel, status: 'ok', units: body.text.length, durationMs: Date.now() - started });
      voiceHeaders(res, voice);
      res.setHeader('Content-Type', out.mimeType);
      res.setHeader('Content-Length', String(out.audio.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(out.audio);
    } catch (err) {
      if (voice) {
        usage.record(req.auth, { kind: 'tts', provider: voice.id, model: voice.ttsModel, status: 'error', durationMs: Date.now() - started, errorCode: toAppError(err).code });
      }
      voiceHeaders(res, voice, err);
      next(err);
    }
  });

  /**
   * Streaming voice for calls: starts Gemini TTS and answers once the first audio exists, with
   * the URL of a WAV that keeps growing while the rest is made (see ai/ttsStream.ts).
   */
  r.post('/speech/start', async (req, res, next) => {
    const started = Date.now();
    let voice;
    try {
      voice = await resolveVoice(req, 'tts');
      if (!voice.supportsTts || !voice.speakStream) throw new AppError('not_found', 'Streaming voice is not available on this server.');
      const body = parseBody(SpeechRequestSchema, req.body);
      const words = cleanSpokenText(body.text);
      if (!words) throw new AppError('validation_error', 'Nothing to say.');
      const abort = new AbortController();
      let answered = false;
      res.on('close', () => {
        if (!answered) abort.abort();
      });
      const stream = await voice.speakStream({ text: words, voice: pickVoice(voice, body.character, body.voice), instructions: voiceInstructions(body.preferences), signal: abort.signal });
      const id = ttsStreams.add(stream, abort);
      answered = true;
      usage.record(req.auth, { kind: 'tts', provider: voice.id, model: stream.model, status: 'ok', units: body.text.length, durationMs: Date.now() - started });
      voiceHeaders(res, voice);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ id, path: `/v1/voice/speech/stream/${id}`, mimeType: 'audio/wav', firstAudioMs: Date.now() - started });
    } catch (err) {
      if (voice) {
        usage.record(req.auth, { kind: 'tts', provider: voice.id, model: voice.ttsModel, status: 'error', durationMs: Date.now() - started, errorCode: toAppError(err).code });
      }
      voiceHeaders(res, voice, err);
      next(err);
    }
  });

  return r;
}
