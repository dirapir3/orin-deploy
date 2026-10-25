import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Encryption at rest for API keys saved from the admin page / app (AES-256-GCM).
 * Values in .env look like `enc:v1:<iv>:<tag>:<data>`. The master key lives in a separate
 * owner-only file next to .env (`.orin-master-key`) or in ORIN_MASTER_KEY, so a copied or
 * leaked .env alone does not reveal the keys.
 */
const PREFIX = 'enc:v1:';
let keyFile = resolve(process.env.ORIN_MASTER_KEY_FILE || resolve(dirname(resolve(process.env.ADMIN_ENV_FILE || '.env')), '.orin-master-key'));
let cached: Buffer | null = null;

export function setMasterKeyFile(path: string): void {
  keyFile = resolve(path);
  cached = null;
}

function masterKey(): Buffer {
  if (cached) return cached;
  const fromEnv = (process.env.ORIN_MASTER_KEY ?? '').trim();
  if (fromEnv) {
    cached = Buffer.from(fromEnv, 'base64url');
  } else if (existsSync(keyFile)) {
    cached = Buffer.from(readFileSync(keyFile, 'utf8').trim(), 'base64url');
  } else if ((process.env.VAULT_KEY ?? '').trim()) {
    // Hosts with a wiped disk (Render free plan): derive a stable key from VAULT_KEY, which lives
    // in the host's environment, so keys saved on the admin page still open after a restart.
    cached = createHash('sha256').update(`orin-master-key:${process.env.VAULT_KEY!.trim()}`).digest();
  } else {
    cached = randomBytes(32);
    try {
      writeFileSync(keyFile, cached.toString('base64url') + '\n', { mode: 0o600 });
      chmodSync(keyFile, 0o600);
    } catch {
      // read-only disk (tests): the key lives for this process only
    }
  }
  if (cached.length !== 32) throw new Error('The Orin master key must be 32 bytes (base64url).');
  return cached;
}

export function isSealed(v: string | undefined | null): boolean {
  return typeof v === 'string' && v.startsWith(PREFIX);
}

export function seal(plain: string): string {
  if (!plain || isSealed(plain)) return plain;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', masterKey(), iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return `${PREFIX}${iv.toString('base64url')}:${c.getAuthTag().toString('base64url')}:${ct.toString('base64url')}`;
}

/** Decrypts a sealed value; plain values pass through. Unreadable values become '' (never the blob). */
export function open(v: string | undefined | null): string {
  if (!v) return '';
  if (!isSealed(v)) return v;
  try {
    const [iv, tag, ct] = v.slice(PREFIX.length).split(':');
    const d = createDecipheriv('aes-256-gcm', masterKey(), Buffer.from(iv ?? '', 'base64url'));
    d.setAuthTag(Buffer.from(tag ?? '', 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct ?? '', 'base64url')), d.final()]).toString('utf8');
  } catch {
    console.warn('[keys] a saved key could not be decrypted (master key changed?)');
    return '';
  }
}

/** A copy of env with every sealed value decrypted. */
export function openEnv<T extends Record<string, string | undefined>>(env: T): T {
  let out: Record<string, string | undefined> | null = null;
  for (const [k, v] of Object.entries(env)) {
    if (isSealed(v)) {
      out ??= { ...env };
      out[k] = open(v);
    }
  }
  return (out ?? env) as T;
}
