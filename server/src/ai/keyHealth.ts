import { createHash } from 'node:crypto';

/** Per-key health shared by every provider instance (plain chat and the agent use the same keys). */
export interface KeyStat {
  ok: number;
  fail: number;
  lastOkAt: number;
  lastErrorAt: number;
  lastError: string;
  lastCode: string;
}

export class KeyHealth {
  readonly cooling = new Map<string, number>();
  readonly stats = new Map<string, KeyStat>();

  stat(id: string): KeyStat {
    let s = this.stats.get(id);
    if (!s) {
      s = { ok: 0, fail: 0, lastOkAt: 0, lastErrorAt: 0, lastError: '', lastCode: '' };
      this.stats.set(id, s);
    }
    return s;
  }

  recordOk(id: string, now: number): void {
    const s = this.stat(id);
    s.ok += 1;
    s.lastOkAt = now;
  }

  recordFail(id: string, now: number, code: string, message: string): void {
    const s = this.stat(id);
    s.fail += 1;
    s.lastErrorAt = now;
    s.lastCode = code;
    s.lastError = message.slice(0, 200);
  }

  /** Public status of one key: ready, cooling (rate limited / quota), failing (rejected key) or unused. */
  status(id: string, now = Date.now()): { state: 'ready' | 'cooling' | 'invalid' | 'unused'; coolingFor: number; ok: number; fail: number; lastOkAt: number; lastErrorAt: number; lastError: string; lastCode: string } {
    const s = this.stats.get(id) ?? { ok: 0, fail: 0, lastOkAt: 0, lastErrorAt: 0, lastError: '', lastCode: '' };
    const coolingFor = Math.max(0, (this.cooling.get(id) ?? 0) - now);
    const invalid = s.lastCode === 'invalid_api_key' && s.lastErrorAt > s.lastOkAt;
    const state = invalid ? 'invalid' : coolingFor > 0 ? 'cooling' : s.ok === 0 && s.fail === 0 ? 'unused' : 'ready';
    return { state, coolingFor, ...s };
  }
}

/** One instance for the whole server, so it survives settings reloads. */
export const sharedKeyHealth = new KeyHealth();

/** Short, non-reversible id for a key (to match admin rows to health without sending keys anywhere). */
export function keyId(key: string): string {
  return key ? createHash('sha256').update(`orin-key:${key}`).digest('hex').slice(0, 12) : '';
}
