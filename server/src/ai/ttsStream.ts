import { randomBytes } from 'node:crypto';
import type { Request, Response } from 'express';
import type { SpeechStream } from './providers/geminiVoice.js';

/**
 * Streaming voice for calls. POST /v1/voice/speech/start begins Gemini TTS at once and answers as
 * soon as the first audio exists (errors still come back as JSON there); the app then plays
 * GET /v1/voice/speech/stream/<id>, a WAV that grows while the rest of the sentence is made, so
 * playback starts after the first chunk instead of after the whole sentence.
 *
 * The id is a 128-bit random capability (the player cannot send auth headers on the web), lives
 * two minutes and is dropped once read to the end or never read.
 */
interface Ticket {
  id: string;
  sampleRate: number;
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  waiters: Set<() => void>;
  createdAt: number;
  abort: AbortController;
  reads: number;
}

const TTL_MS = 120_000;
const MAX_TICKETS = 200;
/** data size written in the header while the length is not known yet (players read to the end) */
const STREAM_DATA_SIZE = 0x7fff_f000;

export class TtsStreams {
  private readonly tickets = new Map<string, Ticket>();
  private readonly timer: NodeJS.Timeout;

  constructor(private readonly now: () => number = Date.now) {
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref?.();
  }

  get size() {
    return this.tickets.size;
  }

  /** Keeps a started stream under a fresh id and pumps the rest of it in the background. */
  add(stream: SpeechStream, abort: AbortController): string {
    this.sweep();
    while (this.tickets.size >= MAX_TICKETS) {
      const oldest = this.tickets.keys().next().value as string | undefined;
      if (!oldest) break;
      this.drop(oldest);
    }
    const id = randomBytes(16).toString('base64url');
    const t: Ticket = { id, sampleRate: stream.sampleRate, chunks: [stream.first], bytes: stream.first.length, done: false, waiters: new Set(), createdAt: this.now(), abort, reads: 0 };
    this.tickets.set(id, t);
    void (async () => {
      try {
        for await (const chunk of stream.rest) {
          if (!this.tickets.has(id)) return;
          t.chunks.push(chunk);
          t.bytes += chunk.length;
          this.wake(t);
        }
      } finally {
        t.done = true;
        this.wake(t);
      }
    })();
    return id;
  }

  /** Waits until the stream has finished (tests and probes). */
  async whenDone(id: string): Promise<Buffer | null> {
    const t = this.tickets.get(id);
    if (!t) return null;
    while (!t.done) await new Promise<void>((r) => t.waiters.add(r));
    return Buffer.concat(t.chunks);
  }

  /** GET handler: the WAV, exact length when finished, else a growing stream. */
  serve(req: Request, res: Response): void {
    const id = String(req.params.id ?? '');
    const t = this.tickets.get(id);
    if (!t) {
      res.status(404).json({ error: { code: 'not_found', message: 'This voice clip has expired.', retryable: false } });
      return;
    }
    t.reads++;
    res.setHeader('Content-Type', 'audio/wav');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (t.done) {
      const pcm = Buffer.concat(t.chunks);
      const wav = Buffer.concat([wavHeader(pcm.length, t.sampleRate), pcm]);
      res.setHeader('Content-Length', String(wav.length));
      res.end(wav);
      return;
    }
    res.setHeader('Transfer-Encoding', 'chunked');
    res.flushHeaders?.();
    res.write(wavHeader(STREAM_DATA_SIZE, t.sampleRate));
    let sent = 0;
    let closed = false;
    const pushNew = () => {
      while (sent < t.chunks.length) res.write(t.chunks[sent++]);
      if (t.done) {
        t.waiters.delete(pushNew);
        res.end();
      }
    };
    res.on('close', () => {
      closed = true;
      t.waiters.delete(pushNew);
    });
    t.waiters.add(pushNew);
    if (!closed) pushNew();
  }

  private wake(t: Ticket) {
    for (const w of [...t.waiters]) w();
  }

  private drop(id: string) {
    const t = this.tickets.get(id);
    if (!t) return;
    this.tickets.delete(id);
    if (!t.done) t.abort.abort();
    t.done = true;
    this.wake(t);
  }

  private sweep() {
    const now = this.now();
    for (const [id, t] of this.tickets) if (now - t.createdAt > TTL_MS) this.drop(id);
  }

  close() {
    clearInterval(this.timer);
    for (const id of [...this.tickets.keys()]) this.drop(id);
  }
}

export function wavHeader(dataBytes: number, sampleRate = 24_000, channels = 1, bits = 16): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(Math.min(0xffff_ffff, 36 + dataBytes), 4);
  h.write('WAVE', 8);
  h.write('fmt ', 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE((sampleRate * channels * bits) / 8, 28);
  h.writeUInt16LE((channels * bits) / 8, 32);
  h.writeUInt16LE(bits, 34);
  h.write('data', 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** one store per process */
export const ttsStreams = new TtsStreams();
