import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { parse } from 'dotenv';

/** Reads KEY=value pairs from a .env file (missing file = empty). */
export function readEnvFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  return parse(readFileSync(path, 'utf8'));
}

const SAFE = /^[A-Za-z0-9_\-.,:/@+=~]*$/;

function quote(value: string): string {
  if (SAFE.test(value)) return value;
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function validEnvValue(v: string): boolean {
  return !/[\r\n\0]/.test(v) && v.length <= 8192;
}

/**
 * Sets (string) or removes (null) variables in a .env file, keeping comments and the order of
 * other lines. Writes atomically and leaves the file readable by its owner only (chmod 600).
 */
export function updateEnvFile(path: string, updates: Record<string, string | null>): void {
  for (const [k, v] of Object.entries(updates)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k)) throw new Error(`Bad variable name: ${k}`);
    if (v !== null && !validEnvValue(v)) throw new Error(`Bad value for ${k}`);
  }
  const lines = existsSync(path) ? readFileSync(path, 'utf8').split(/\r?\n/) : [];
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const done = new Set<string>();
  const out: string[] = [];
  for (const line of lines) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line);
    const key = m?.[1];
    if (key && key in updates) {
      if (done.has(key)) continue; // drop duplicates
      done.add(key);
      const v = updates[key];
      if (v === null || v === undefined) continue;
      out.push(`${key}=${quote(v)}`);
    } else {
      out.push(line);
    }
  }
  for (const [k, v] of Object.entries(updates)) {
    if (!done.has(k) && v !== null) out.push(`${k}=${quote(v)}`);
  }
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, out.join('\n') + '\n', { mode: 0o600 });
  renameSync(tmp, path);
  chmodSync(path, 0o600);
}

/**
 * Makes sure ADMIN_PASSWORD exists. When missing, generates a strong one, saves it to the .env
 * file and returns it so the caller can print it once.
 */
export function ensureAdminPassword(path: string, env: NodeJS.ProcessEnv = process.env): { password: string; generated: boolean } {
  const existing = (env.ADMIN_PASSWORD ?? '').trim() || (readEnvFile(path).ADMIN_PASSWORD ?? '').trim();
  if (existing) {
    env.ADMIN_PASSWORD = existing;
    return { password: existing, generated: false };
  }
  const password = randomBytes(18).toString('base64url');
  updateEnvFile(path, { ADMIN_PASSWORD: password });
  env.ADMIN_PASSWORD = password;
  return { password, generated: true };
}

/** Makes sure VAULT_KEY (Secure Vault encryption key) exists in the .env file; generated once and kept. */
export function ensureVaultKey(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const existing = (env.VAULT_KEY ?? '').trim() || (readEnvFile(path).VAULT_KEY ?? '').trim();
  if (existing) {
    env.VAULT_KEY = existing;
    return false;
  }
  const key = randomBytes(32).toString('base64url');
  updateEnvFile(path, { VAULT_KEY: key });
  env.VAULT_KEY = key;
  return true;
}

/** Splits a pasted key pool: commas, spaces or new lines. */
export function splitKeys(raw: string | undefined | null): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function last4(key: string): string {
  return key.length <= 8 ? '' : key.slice(-4);
}
