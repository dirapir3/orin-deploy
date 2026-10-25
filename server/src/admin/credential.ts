import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { readEnvFile, updateEnvFile } from './envFile.js';

/**
 * Owner (admin) credential.
 *
 * Preferred: ADMIN_PASSWORD_HASH in .env, a salted scrypt hash of a password the owner chose.
 * It is read from the file at request time, so a password change takes effect without a restart,
 * and the plain password is never stored, logged or returned.
 *
 * Legacy: ADMIN_PASSWORD (plain text). Still accepted until a hash is set, so the owner is never
 * locked out by an upgrade; setting a hash removes the plain value.
 *
 * One-time setup link: ADMIN_SETUP_TOKEN=<sha256 hex>:<expiry ms>. The token itself is only
 * printed by the owner's command-line tool (see cli.ts); it opens a page to choose a new password.
 */

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export const MIN_PASSWORD = 12;
export const MAX_PASSWORD = 200;

const sha = (s: string) => createHash('sha256').update(s).digest();

export function hashPassword(pw: string): string {
  const salt = randomBytes(16);
  const dk = scryptSync(pw, salt, SCRYPT.keylen, { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p });
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64url'), dk.toString('base64url')].join('.');
}

export function verifyHash(pw: string, stored: string): boolean {
  const parts = stored.split('.');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, salt, hash] = parts as [string, string, string, string, string, string];
  const expected = Buffer.from(hash, 'base64url');
  if (expected.length < 16) return false;
  try {
    const dk = scryptSync(pw, Buffer.from(salt, 'base64url'), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 });
    return timingSafeEqual(dk, expected);
  } catch {
    return false;
  }
}

/** Password rules for a new owner password. Returns an error message or null. */
export function passwordProblem(pw: string): string | null {
  if (pw.length < MIN_PASSWORD) return `Use at least ${MIN_PASSWORD} characters.`;
  if (pw.length > MAX_PASSWORD) return 'That password is too long.';
  if (/[\r\n]/.test(pw)) return 'The password cannot contain line breaks.';
  if (new Set(pw).size < 5) return 'That password is too simple.';
  return null;
}

export class AdminCredential {
  private cache: { mtime: number; vals: Record<string, string> } | null = null;

  constructor(
    private readonly envFile: string,
    /** legacy plain password (process env); used only while no hash is set */
    private readonly legacy: () => string = () => '',
  ) {}

  private file(): Record<string, string> {
    try {
      if (!existsSync(this.envFile)) return {};
      const mtime = statSync(this.envFile).mtimeMs;
      if (!this.cache || this.cache.mtime !== mtime) this.cache = { mtime, vals: readEnvFile(this.envFile) };
      return this.cache.vals;
    } catch {
      return {};
    }
  }

  /** 'hash' = owner-chosen hashed password, 'legacy' = old plain ADMIN_PASSWORD, 'none' = nothing set. */
  mode(): 'hash' | 'legacy' | 'none' {
    if ((this.file().ADMIN_PASSWORD_HASH ?? '').startsWith('scrypt.')) return 'hash';
    return this.legacy().trim() ? 'legacy' : 'none';
  }

  check(given: unknown): boolean {
    const pw = String(given ?? '');
    if (!pw || pw.length > MAX_PASSWORD) return false;
    const hash = this.file().ADMIN_PASSWORD_HASH ?? '';
    if (hash.startsWith('scrypt.')) {
      // Exact match; only stray spaces a phone keyboard adds at the ends are ignored.
      return verifyHash(pw.trim(), hash) || (pw !== pw.trim() && verifyHash(pw, hash));
    }
    const legacy = this.legacy().trim().toLowerCase();
    if (!legacy) return false;
    return timingSafeEqual(sha(pw.trim().toLowerCase()), sha(legacy));
  }

  /** Saves a new owner password (hashed), removes the legacy plain one and any setup link. */
  set(pw: string): void {
    updateEnvFile(this.envFile, { ADMIN_PASSWORD_HASH: hashPassword(pw.trim()), ADMIN_PASSWORD: null, ADMIN_SETUP_TOKEN: null });
    this.cache = null;
  }

  /** Creates a one-time setup token (valid `minutes`), stores only its hash, returns the token. */
  createSetupToken(minutes = 30): string {
    const token = randomBytes(24).toString('base64url');
    updateEnvFile(this.envFile, { ADMIN_SETUP_TOKEN: `${sha(token).toString('hex')}:${Date.now() + minutes * 60_000}` });
    this.cache = null;
    return token;
  }

  checkSetupToken(token: unknown): boolean {
    const t = String(token ?? '');
    const raw = this.file().ADMIN_SETUP_TOKEN ?? '';
    const [hex, exp] = raw.split(':');
    if (!t || !hex || !exp || Number(exp) < Date.now()) return false;
    const want = Buffer.from(hex, 'hex');
    const got = sha(t);
    return want.length === got.length && timingSafeEqual(want, got);
  }
}
