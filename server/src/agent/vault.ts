import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AgentStore, VaultRow } from './store.js';

/**
 * Secure Vault: saved logins encrypted at rest with AES-256-GCM. The key comes from VAULT_KEY
 * (generated into .env on first start). The API never returns a password, and the agent only ever
 * sees a login's name, site and username; the password is filled in server-side and redacted from
 * anything the model reads.
 */
let cachedKey: Buffer | null = null;
let cachedFrom = '';

export function vaultKey(): Buffer {
  const raw = process.env.VAULT_KEY || '';
  if (!cachedKey || cachedFrom !== raw) {
    // Without a configured key (tests), use a per-process random key: data is unreadable after a restart.
    cachedKey = raw ? createHash('sha256').update(`orin-vault:${raw}`).digest() : randomBytes(32);
    cachedFrom = raw;
  }
  return cachedKey;
}

export function encrypt(text: string): string {
  if (!text) return '';
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', vaultKey(), iv);
  const ct = Buffer.concat([c.update(text, 'utf8'), c.final()]);
  return `v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function decrypt(blob: string): string {
  if (!blob) return '';
  const [v, iv, tag, ct] = blob.split(':');
  if (v !== 'v1' || !iv || !tag || ct === undefined) throw new Error('Unreadable vault entry.');
  const d = createDecipheriv('aes-256-gcm', vaultKey(), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}

function safeDecrypt(blob: string): string {
  try {
    return decrypt(blob);
  } catch {
    return '';
  }
}

/** "*.example.com" or "example.com" matches example.com and its subdomains. */
export function domainMatches(pattern: string, host: string): boolean {
  const p = pattern.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^\*\./, '').replace(/^www\./, '');
  const h = host.toLowerCase().replace(/^www\./, '');
  if (!p) return false;
  return h === p || h.endsWith(`.${p}`);
}

export interface VaultPublic {
  id: string;
  name: string;
  domain: string;
  username: string;
  hasPassword: boolean;
  hasNotes: boolean;
  createdAt: number;
  updatedAt: number;
}

export function toPublic(r: VaultRow): VaultPublic {
  return { id: r.id, name: r.name, domain: r.domain, username: safeDecrypt(r.usernameEnc), hasPassword: Boolean(r.passwordEnc), hasNotes: Boolean(r.notesEnc), createdAt: r.createdAt, updatedAt: r.updatedAt };
}

export function saveLogin(store: AgentStore, owner: string, v: { name: string; domain: string; username: string; password: string; notes?: string }) {
  return store.insertVault(owner, { name: v.name.trim(), domain: v.domain.trim().toLowerCase(), usernameEnc: encrypt(v.username), passwordEnc: encrypt(v.password), notesEnc: encrypt(v.notes ?? '') });
}

export function updateLogin(store: AgentStore, owner: string, id: string, v: { name?: string; domain?: string; username?: string; password?: string; notes?: string }) {
  return store.updateVault(owner, id, {
    name: v.name?.trim(),
    domain: v.domain?.trim().toLowerCase(),
    usernameEnc: v.username === undefined ? undefined : encrypt(v.username),
    // an empty password in an edit means "keep the current one"
    passwordEnc: v.password ? encrypt(v.password) : undefined,
    notesEnc: v.notes === undefined ? undefined : encrypt(v.notes),
  });
}

/** Server-side only: the plaintext login for filling a form. Never return this to the model or the API. */
export function revealLogin(r: VaultRow): { username: string; password: string } {
  return { username: safeDecrypt(r.usernameEnc), password: safeDecrypt(r.passwordEnc) };
}

// ---- signed, expiring links (file downloads opened in the phone's browser)
export function signToken(payload: string, ttlSec = 3600): string {
  const body = Buffer.from(JSON.stringify({ p: payload, e: Date.now() + ttlSec * 1000 })).toString('base64url');
  const sig = createHmac('sha256', vaultKey()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

export function verifyToken(token: string): string | null {
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const want = createHmac('sha256', vaultKey()).update(body).digest();
  const got = Buffer.from(sig, 'base64url');
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    const v = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { p: string; e: number };
    return v.e > Date.now() ? v.p : null;
  } catch {
    return null;
  }
}
