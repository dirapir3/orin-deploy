import type { AgentStore } from './store.js';
import type { SandboxSession } from './sandbox/types.js';

/**
 * Browser sign-ins kept between Orin's computers. A cloud computer is wiped when it closes, so the
 * browser's cookies are exported from it (on close, and now and then while she works), kept on the
 * server in the connections table (encrypted at rest with VAULT_KEY, like connected-app tokens) and
 * put into the next computer's browser before its first page. They belong to the user (shared by
 * their characters, like the Secure Vault), are never shown to the model, are not saved from an
 * incognito chat, and "forget sign-ins" deletes them.
 */
export const SIGNINS_PROVIDER = 'browser_state';
const MAX_COOKIES = 3000;
const MAX_BYTES = 1_500_000;

export interface Cookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

const userOf = (owner: string) => owner.split('#')[0]!;

export function loadSignins(store: AgentStore, owner: string): Cookie[] {
  const c = store.getConnection(userOf(owner), SIGNINS_PROVIDER);
  if (!c?.accessToken) return [];
  try {
    const v = JSON.parse(c.accessToken) as unknown;
    return Array.isArray(v) ? (v as Cookie[]) : [];
  } catch {
    return [];
  }
}

/** Keeps the cookies that are still valid; returns how many were kept. */
export function saveSignins(store: AgentStore, owner: string, cookies: unknown, rev = ''): number {
  if (!Array.isArray(cookies)) return 0;
  const now = Date.now() / 1000;
  let list = (cookies as Cookie[]).filter((c) => c && typeof c.name === 'string' && typeof c.domain === 'string' && typeof c.value === 'string' && (c.expires === undefined || c.expires === -1 || c.expires > now));
  list = list.slice(0, MAX_COOKIES);
  let json = JSON.stringify(list);
  while (json.length > MAX_BYTES && list.length) {
    list = list.slice(0, Math.floor(list.length * 0.8));
    json = JSON.stringify(list);
  }
  if (!list.length) {
    store.deleteConnection(userOf(owner), SIGNINS_PROVIDER);
    return 0;
  }
  store.saveConnection({ owner: userOf(owner), provider: SIGNINS_PROVIDER, accessToken: json, refreshToken: '', expiresAt: 0, scope: rev, email: '' });
  return list.length;
}

export function savedSigninsRev(store: AgentStore, owner: string): string {
  return store.getConnection(userOf(owner), SIGNINS_PROVIDER)?.scope ?? '';
}

export function forgetSignins(store: AgentStore, owner: string): boolean {
  return store.deleteConnection(userOf(owner), SIGNINS_PROVIDER);
}

/** Sites with saved sign-ins (cookie domains), for telling the user what is kept. */
export function signinSites(store: AgentStore, owner: string): string[] {
  const set = new Set(loadSignins(store, owner).map((c) => c.domain.replace(/^\./, '').replace(/^www\./, '')));
  return [...set].sort();
}

/** Where the browser script lives on Orin's computer (kept in step with tools/computer.ts). */
export const BROWSER_SCRIPT_PATH = '/home/user/.orin/orin_browser.py';
export const SIGNINS_IN_PATH = '/home/user/.orin/signins-in.json';

/**
 * Asks the running browser on this computer for its cookies and keeps them. Does nothing when the
 * browser is not running (it never starts one). Returns how many cookies were kept, or -1 when nothing was read.
 */
export async function exportSignins(store: AgentStore, owner: string, s: SandboxSession): Promise<number> {
  const r = await s.exec(`test -f ${BROWSER_SCRIPT_PATH} && python3 ${BROWSER_SCRIPT_PATH}`, { cwd: '/home/user', timeoutMs: 30_000, envs: { ORIN_ACT: JSON.stringify({ action: 'export_signins' }) } });
  const out = r.stdout.trim().split('\n').pop() ?? '';
  try {
    const j = JSON.parse(out) as { ok?: boolean; cookies?: unknown; signins_rev?: string };
    if (!j.ok || !Array.isArray(j.cookies)) return -1;
    return saveSignins(store, owner, j.cookies, j.signins_rev ?? '');
  } catch {
    return -1;
  }
}

/** Puts the saved cookies on a fresh computer; the browser adds them before its next page and deletes the file. */
export async function stageSignins(store: AgentStore, owner: string, s: SandboxSession): Promise<number> {
  const cookies = loadSignins(store, owner);
  if (!cookies.length) return 0;
  await s.writeFile(SIGNINS_IN_PATH, JSON.stringify(cookies));
  await s.exec(`chmod 600 ${SIGNINS_IN_PATH}`, { cwd: '/home/user', timeoutMs: 10_000 });
  return cookies.length;
}
