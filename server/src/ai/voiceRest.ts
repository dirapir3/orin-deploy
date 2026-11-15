import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { decrypt, encrypt } from '../agent/vault.js';
import { logger } from '../logger.js';
import type { VoiceProvider } from './types.js';

/**
 * Remembers that the server's own voice (Gemini TTS) is out of its daily quota, across restarts.
 *
 * Without it every restart forgot the rest: the first call after a deploy walked all three out-of-quota
 * TTS models (about 4.7 s of silence on the live server) before the app fell back to the phone voice.
 * Two copies, because Render's disk is wiped by a deploy and Firestore is often over its free limit:
 *  - a small file in DATA_DIR (survives a crash or an in-place restart);
 *  - a token the app keeps (X-Orin-Voice-Rest), encrypted with VAULT_KEY so only this server can make
 *    one; the app sends it back and a fresh server puts the rest back at once.
 * A rest only applies while the server has the same keys and models (restScope), and never past 24 h.
 * Only rests of a minute or more are remembered: a per-minute limit is over before it matters.
 */

export const VOICE_REST_HEADER = 'x-orin-voice-rest';
const MIN_REST_MS = 60_000;
const MAX_REST_MS = 24 * 3600_000;

interface Saved {
  v: 1;
  k: 'tts-rest';
  scope: string;
  until: number;
}

let filePath: string | null = null;
let lastSaved = 0;

function valid(p: Partial<Saved> | null, v: VoiceProvider): p is Saved {
  const now = Date.now();
  return Boolean(p && p.v === 1 && p.k === 'tts-rest' && typeof p.until === 'number' && p.until > now + 5_000 && p.until <= now + MAX_REST_MS && p.scope && v.restScope && p.scope === v.restScope('tts'));
}

function seed(v: VoiceProvider, p: Saved, from: string): boolean {
  if (!v.seedRest || !v.restingUntil) return false;
  if ((v.restingUntil('tts') || 0) >= p.until) return false;
  v.seedRest('tts', p.until);
  lastSaved = Math.max(lastSaved, p.until);
  logger.info('server voice rest put back', { from, inMin: Math.round((p.until - Date.now()) / 60_000) });
  return true;
}

/** At startup: the rest written down before the restart, if the disk still has it. */
export function loadVoiceRest(dataDir: string, v: VoiceProvider | null): void {
  filePath = join(dataDir, 'voice-rest.json');
  if (!v?.seedRest) return;
  try {
    const p = JSON.parse(readFileSync(filePath, 'utf8')) as Partial<Saved>;
    if (valid(p, v)) seed(v, p, 'disk');
  } catch {
    // no file yet (first start or a fresh disk)
  }
}

/** Until when the server voice rests (0 = it does not, or only for a per-minute limit). */
export function serverVoiceRest(v: VoiceProvider | null): number {
  const until = v?.supportsTts && v.restingUntil ? v.restingUntil('tts') || 0 : 0;
  return until - Date.now() >= MIN_REST_MS ? Math.min(until, Date.now() + MAX_REST_MS) : 0;
}

/**
 * After a voice call: writes the rest down when there is a new one, and returns the token for the app
 * (null when the voice is not resting).
 */
export function noteVoiceRest(v: VoiceProvider | null): string | null {
  const until = serverVoiceRest(v);
  if (!until || !v?.restScope) return null;
  const p: Saved = { v: 1, k: 'tts-rest', scope: v.restScope('tts'), until };
  if (filePath && Math.abs(until - lastSaved) > 30_000) {
    lastSaved = until;
    try {
      mkdirSync(dirname(filePath), { recursive: true });
      writeFileSync(filePath, JSON.stringify(p));
    } catch (e) {
      logger.warn('could not write the voice rest', { err: String(e) });
    }
  }
  return encrypt(JSON.stringify(p));
}

/** A token the app kept from before the restart: puts the rest back. Never throws; a bad token is ignored. */
export function acceptVoiceRest(v: VoiceProvider | null, token: string | undefined): boolean {
  const raw = (token ?? '').trim();
  if (!raw || raw.length > 2000 || !v?.seedRest) return false;
  try {
    const p = JSON.parse(decrypt(raw)) as Partial<Saved>;
    return valid(p, v) ? seed(v, p, 'app') : false;
  } catch {
    return false;
  }
}

/** tests */
export function resetVoiceRestForTests(): void {
  filePath = null;
  lastSaved = 0;
}
