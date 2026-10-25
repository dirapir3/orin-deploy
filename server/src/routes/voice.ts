import { Router } from 'express';
import multer from 'multer';
import { voiceInstructions } from '../ai/prompt.js';
import { CHARACTER_VOICES, characterVoice } from '../ai/providers/geminiVoice.js';
import type { Deps } from '../app.js';
import { AppError, toAppError } from '../errors.js';
import { SpeechRequestSchema } from '../schemas.js';
import { parseBody } from './util.js';

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

  r.get('/voices', (_req, res, next) => {
    try {
      const v = requireVoice();
      const geminiTts = v.supportsTts && v.voices().some((x) => x.id === 'Sulafat');
      res.json({
        voices: v.voices(),
        defaultVoice: v.supportsTts ? v.defaultVoice() : null,
        ttsModel: v.supportsTts ? v.ttsModel : null,
        stt: true,
        tts: v.supportsTts,
        characterVoices: geminiTts ? Object.fromEntries(Object.entries(CHARACTER_VOICES).map(([k, x]) => [k, x.voice])) : null,
      });
    } catch (err) {
      next(err);
    }
  });

  r.post('/transcribe', upload.single('audio'), async (req, res, next) => {
    const started = Date.now();
    let voice;
    try {
      voice = requireVoice();
      const file = req.file;
      if (!file || file.size === 0) throw new AppError('validation_error', 'No audio was received.');
      const mime = (file.mimetype || '').toLowerCase();
      if (!AUDIO_TYPES.has(mime)) throw new AppError('unsupported_file', `Unsupported audio type: ${mime || 'unknown'}.`);
      const language = typeof req.body?.language === 'string' && /^[a-z]{2}$/.test(req.body.language) ? req.body.language : undefined;
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const result = await voice.transcribe({
        audio: file.buffer,
        mimeType: mime === 'video/mp4' ? 'audio/mp4' : mime,
        filename: `speech.${EXT[mime] ?? 'm4a'}`,
        language,
        signal: controller.signal,
      });
      usage.record(req.auth, { kind: 'stt', provider: voice.id, model: voice.sttModel, status: 'ok', units: file.size, durationMs: Date.now() - started });
      res.json({ text: result.text });
    } catch (err) {
      if (voice) {
        usage.record(req.auth, { kind: 'stt', provider: voice.id, model: voice.sttModel, status: 'error', durationMs: Date.now() - started, errorCode: toAppError(err).code });
      }
      next(err);
    }
  });

  r.post('/speech', async (req, res, next) => {
    const started = Date.now();
    let voice;
    try {
      voice = requireVoice();
      const body = parseBody(SpeechRequestSchema, req.body);
      const voices = voice.voices();
      const ch = body.character ? characterVoice(body.character) : null;
      const chosen =
        body.voice && voices.some((v) => v.id === body.voice)
          ? body.voice
          : ch && voices.some((v) => v.id === ch.voice)
            ? ch.voice
            : voice.defaultVoice();
      const controller = new AbortController();
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });
      const out = await voice.speak({
        text: body.text,
        voice: chosen,
        instructions: voiceInstructions(body.preferences),
        signal: controller.signal,
        ...(ch ? { style: ch.style } : {}),
      } as Parameters<typeof voice.speak>[0]);
      usage.record(req.auth, { kind: 'tts', provider: voice.id, model: voice.ttsModel, status: 'ok', units: body.text.length, durationMs: Date.now() - started });
      res.setHeader('Content-Type', out.mimeType);
      res.setHeader('Content-Length', String(out.audio.length));
      res.setHeader('Cache-Control', 'no-store');
      res.end(out.audio);
    } catch (err) {
      if (voice) {
        usage.record(req.auth, { kind: 'tts', provider: voice.id, model: voice.ttsModel, status: 'error', durationMs: Date.now() - started, errorCode: toAppError(err).code });
      }
      next(err);
    }
  });

  return r;
}
