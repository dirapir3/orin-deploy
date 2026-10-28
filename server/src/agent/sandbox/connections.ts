import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors.js';
import { assertPublicUrl } from '../net.js';
import type { AgentStore, VaultRow } from '../store.js';
import { decrypt, encrypt, revealLogin } from '../vault.js';
import { DAYTONA_API, DaytonaProvider, checkDaytonaKey } from './daytona.js';
import { E2BProvider } from './e2b.js';
import type { SandboxProvider } from './types.js';

/**
 * The user's sandbox connections (AI setup > Sandboxes in the app): as many as they like, each one
 * an API key for a provider Orin has an adapter for. Keys live in the Secure Vault like AI keys (the
 * vault row's password is the key, its notes hold { kind: 'orin-sandbox', ... }), so they are
 * encrypted with VAULT_KEY, kept per account, redacted from tool output, and saved with the rest of
 * the vault. Which one is the default, which are switched off and how each last checked out live in
 * the small setup_settings table.
 *
 * The server's own E2B key (E2B_API_KEY) shows up as the read-only "Built-in" connection.
 *
 * Order of use when Orin needs a computer: the default first, then the others (oldest first), with
 * any that failed in the last few minutes moved to the back. When one cannot start a computer (bad
 * key, out of credit, provider down) the manager moves on to the next; see manager.ts.
 */

export type SandboxProviderId = 'e2b' | 'daytona';

export interface SandboxProviderDef {
  id: SandboxProviderId;
  label: string;
  keyUrl: string;
  keyHint: string;
  /** a self-hosted API address may be entered */
  customApiUrl: boolean;
  can: string[];
  cannot: string[];
}

export const SANDBOX_PROVIDERS: SandboxProviderDef[] = [
  {
    id: 'e2b',
    label: 'E2B',
    keyUrl: 'https://e2b.dev/dashboard?tab=keys',
    keyHint: 'Starts with e2b_',
    customApiUrl: false,
    can: ['Commands, files and background jobs', 'Website previews and the live browser view', "Orin's full workspace image on the account it was built on"],
    cannot: ["Other E2B accounts start from E2B's standard image until the workspace image is built there"],
  },
  {
    id: 'daytona',
    label: 'Daytona',
    keyUrl: 'https://app.daytona.io/dashboard/keys',
    keyHint: 'From Daytona > Dashboard > API Keys',
    customApiUrl: true,
    can: ['Commands, files and background jobs', 'Your saved work folder carries over'],
    cannot: ['No website preview links or live browser view yet', "No Android SDK or browser tools from Orin's workspace image"],
  },
];

/** Services people ask about that have no adapter yet (shown so nobody pastes a key that cannot work). */
export const SANDBOX_NEEDS_ADAPTER = ['Modal', 'CodeSandbox', 'Vercel Sandbox', 'Runloop', 'Fly Machines'];

export const SERVER_CONNECTION_ID = 'server';
const MARK = 'orin-sandbox';
/** a connection that failed is tried last for this long */
export const FAIL_COOLDOWN_MS = 5 * 60_000;

export type HealthState = 'untested' | 'ok' | 'failed';
export interface Health {
  state: HealthState;
  checkedAt?: number;
  error?: string;
  failedUntil?: number;
}

export interface SandboxConnectionPublic {
  id: string;
  provider: SandboxProviderId;
  providerLabel: string;
  label: string;
  apiUrl?: string;
  last4: string;
  enabled: boolean;
  isDefault: boolean;
  builtIn: boolean;
  health: Health;
  createdAt: number;
  updatedAt: number;
}

export interface SandboxCandidate {
  connectionId: string;
  label: string;
  provider: SandboxProvider;
}

interface ConnNotes {
  kind: typeof MARK;
  id: string;
  provider: SandboxProviderId;
  label: string;
  apiUrl?: string;
  createdAt: number;
}

interface SandboxSettings {
  defaultId?: string;
  disabled: string[];
  health: Record<string, Health>;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

// ---- small per-account settings table (non-secret)

const ensured = new WeakSet<object>();
function db(store: AgentStore) {
  if (!ensured.has(store.db)) {
    store.db.exec('CREATE TABLE IF NOT EXISTS setup_settings (owner TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner, key))');
    ensured.add(store.db);
  }
  return store.db;
}
export function getSetting<T>(store: AgentStore, owner: string, key: string, fallback: T): T {
  const r = db(store).prepare('SELECT value FROM setup_settings WHERE owner = ? AND key = ?').get(owner, key) as { value?: string } | undefined;
  if (!r?.value) return fallback;
  try {
    return { ...fallback, ...(JSON.parse(r.value) as T) };
  } catch {
    return fallback;
  }
}
export function setSetting(store: AgentStore, owner: string, key: string, value: unknown): void {
  db(store)
    .prepare('INSERT INTO setup_settings (owner, key, value, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(owner, key, JSON.stringify(value), Date.now());
}

// ---- helpers

export function providerDef(id: string): SandboxProviderDef {
  const d = SANDBOX_PROVIDERS.find((p) => p.id === id);
  if (!d) {
    const named = SANDBOX_NEEDS_ADAPTER.find((n) => n.toLowerCase().replace(/\s/g, '') === id.toLowerCase().replace(/\s/g, ''));
    throw new AppError('validation_error', `${named ?? 'That service'} has no adapter in Orin yet, so its key can't run her computer. Supported now: ${SANDBOX_PROVIDERS.map((p) => p.label).join(', ')}.`);
  }
  return d;
}

function cleanKey(provider: SandboxProviderId, key: string): string {
  const k = (key ?? '').trim();
  if (!k) throw new AppError('validation_error', 'Paste the API key.');
  if (k.length > 1000 || /\s/.test(k)) throw new AppError('validation_error', 'That does not look like an API key (it has spaces or is too long).');
  if (provider === 'e2b' && !k.startsWith('e2b_')) throw new AppError('validation_error', 'E2B API keys start with "e2b_". Copy it from E2B > Dashboard > API Keys.');
  return k;
}

async function cleanApiUrl(def: SandboxProviderDef, raw: string | undefined, lookup?: Parameters<typeof assertPublicUrl>[1]): Promise<string | undefined> {
  const v = (raw ?? '').trim().replace(/\/+$/, '');
  if (!v) return undefined;
  if (!def.customApiUrl) throw new AppError('validation_error', `${def.label} does not take a custom API address.`);
  if (v === DAYTONA_API) return undefined;
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new AppError('validation_error', 'The API address is not a valid web address.');
  }
  if (u.protocol !== 'https:') throw new AppError('validation_error', 'The API address must start with https:// (the key is sent there).');
  if (u.username || u.password) throw new AppError('validation_error', 'Leave the user name and password out of the API address.');
  try {
    await assertPublicUrl(v, lookup);
  } catch (e) {
    if (e instanceof AppError && e.code === 'forbidden') throw new AppError('validation_error', `${u.hostname} is a local or private address, so it can't be used (Orin only sends keys to public https servers).`);
    if (e instanceof AppError && e.code === 'provider_unavailable') throw new AppError('validation_error', `Can't find ${u.hostname}. Check the API address.`);
    throw e;
  }
  return v;
}

function readNotes(row: VaultRow): ConnNotes | null {
  if (!row.notesEnc) return null;
  try {
    const n = JSON.parse(decrypt(row.notesEnc)) as Partial<ConnNotes>;
    if (n.kind !== MARK || !n.id || !n.provider || !SANDBOX_PROVIDERS.some((p) => p.id === n.provider)) return null;
    return { kind: MARK, id: n.id, provider: n.provider, label: n.label || n.provider, apiUrl: n.apiUrl || undefined, createdAt: n.createdAt || row.createdAt };
  } catch {
    return null;
  }
}

const last4 = (k: string) => (k.length > 8 ? k.slice(-4) : '');
const errText = (e: unknown) => String((e as Error)?.message ?? e).slice(0, 240);

function vaultFields(n: ConnNotes) {
  const def = providerDef(n.provider);
  return {
    name: `${n.label} sandbox key`,
    domain: n.provider === 'e2b' ? 'e2b.dev' : n.apiUrl ? new URL(n.apiUrl).hostname : 'app.daytona.io',
    username: `Sandbox key · ${def.label}`,
    notes: JSON.stringify(n),
  };
}

export function friendlyHealthError(provider: string, e: unknown): string {
  const status = (e as { status?: number })?.status;
  const msg = errText(e);
  const label = SANDBOX_PROVIDERS.find((p) => p.id === provider)?.label ?? provider;
  if (status === 401 || status === 403 || /\b401\b|\b403\b|invalid api key|unauthori[sz]ed|invalid credentials/i.test(msg)) return `${label} rejected the key. Check it or paste a new one.`;
  if (status === 402 || status === 429 || /\b402\b|\b429\b|quota|credit|limit|rate/i.test(msg)) return `${label} says the account is out of credit or over its limit: ${msg}`;
  if (/fetch failed|ENOTFOUND|ECONNREFUSED|ECONNRESET|timeout|timed out|network/i.test(msg)) return `Couldn't reach ${label} just now (${msg}).`;
  return msg;
}

// ---- the store

export class SandboxConnections {
  private readonly providers = new Map<string, SandboxProvider>();
  private readonly f: FetchLike;
  private readonly now: () => number;

  constructor(
    private readonly st: AgentStore,
    private readonly o: {
      /** the server's own E2B key (Built-in connection), '' when none */
      serverKey: () => string;
      fetchImpl?: FetchLike;
      lookup?: Parameters<typeof assertPublicUrl>[1];
      now?: () => number;
      /** tests: build providers without the network */
      makeProvider?: (provider: SandboxProviderId, key: () => string, apiUrl?: string) => SandboxProvider;
    },
  ) {
    this.f = o.fetchImpl ?? ((u, i) => fetch(u, i));
    this.now = o.now ?? Date.now;
  }

  private settings(account: string): SandboxSettings {
    return getSetting<SandboxSettings>(this.st, account, 'sandbox', { disabled: [], health: {} });
  }
  private save(account: string, s: SandboxSettings) {
    setSetting(this.st, account, 'sandbox', s);
  }

  private rows(account: string): { row: VaultRow; n: ConnNotes }[] {
    const out: { row: VaultRow; n: ConnNotes }[] = [];
    for (const row of this.st.listVault(account)) {
      const n = readNotes(row);
      if (n) out.push({ row, n });
    }
    return out.sort((a, b) => a.n.createdAt - b.n.createdAt);
  }

  private find(account: string, id: string) {
    const f = this.rows(account).find((x) => x.n.id === id);
    if (!f) throw new AppError('not_found', 'That sandbox connection is not there any more.');
    return f;
  }

  private hasServer() {
    return Boolean(this.o.serverKey());
  }

  /** The effective default: the chosen one if it is still there and on, else the first one that is on. */
  private defaultId(account: string, s = this.settings(account)): string | null {
    const ids = [...this.rows(account).map((x) => x.n.id), ...(this.hasServer() ? [SERVER_CONNECTION_ID] : [])].filter((id) => !s.disabled.includes(id));
    if (s.defaultId && ids.includes(s.defaultId)) return s.defaultId;
    return ids[0] ?? null;
  }

  list(account: string): SandboxConnectionPublic[] {
    const s = this.settings(account);
    const def = this.defaultId(account, s);
    const h = (id: string): Health => s.health[id] ?? { state: 'untested' };
    const out: SandboxConnectionPublic[] = this.rows(account).map(({ row, n }) => ({
      id: n.id,
      provider: n.provider,
      providerLabel: providerDef(n.provider).label,
      label: n.label,
      ...(n.apiUrl ? { apiUrl: n.apiUrl } : {}),
      last4: last4(revealLogin(row).password),
      enabled: !s.disabled.includes(n.id),
      isDefault: def === n.id,
      builtIn: false,
      health: h(n.id),
      createdAt: n.createdAt,
      updatedAt: row.updatedAt,
    }));
    if (this.hasServer()) {
      out.push({
        id: SERVER_CONNECTION_ID,
        provider: 'e2b',
        providerLabel: 'E2B',
        label: 'Built-in (server key)',
        last4: last4(this.o.serverKey()),
        enabled: !s.disabled.includes(SERVER_CONNECTION_ID),
        isDefault: def === SERVER_CONNECTION_ID,
        builtIn: true,
        health: h(SERVER_CONNECTION_ID),
        createdAt: 0,
        updatedAt: 0,
      });
    }
    return out;
  }

  async add(account: string, input: { provider: string; label?: string; key: string; apiUrl?: string }): Promise<SandboxConnectionPublic> {
    const def = providerDef(input.provider);
    const key = cleanKey(def.id, input.key);
    const apiUrl = await cleanApiUrl(def, input.apiUrl, this.o.lookup);
    if (this.st.listVault(account).length >= 100) throw new AppError('validation_error', 'The vault holds up to 100 entries. Delete some first.');
    const taken = new Set(this.rows(account).map((x) => x.n.label.toLowerCase()));
    let label = (input.label ?? '').trim().slice(0, 60) || def.label;
    for (let i = 2; taken.has(label.toLowerCase()); i++) label = `${(input.label ?? '').trim().slice(0, 56) || def.label} ${i}`;
    const n: ConnNotes = { kind: MARK, id: randomUUID(), provider: def.id, label, ...(apiUrl ? { apiUrl } : {}), createdAt: this.now() };
    const f = vaultFields(n);
    this.st.insertVault(account, { name: f.name, domain: f.domain, usernameEnc: encrypt(f.username), passwordEnc: encrypt(key), notesEnc: encrypt(f.notes) });
    return this.list(account).find((c) => c.id === n.id)!;
  }

  async update(account: string, id: string, input: { label?: string; key?: string; apiUrl?: string; enabled?: boolean }): Promise<SandboxConnectionPublic> {
    const s = this.settings(account);
    if (input.enabled !== undefined) {
      s.disabled = s.disabled.filter((x) => x !== id);
      if (!input.enabled) s.disabled.push(id);
    }
    if (id === SERVER_CONNECTION_ID) {
      if (!this.hasServer()) throw new AppError('not_found', 'This server has no built-in sandbox key.');
      if (input.key || input.label || input.apiUrl) throw new AppError('validation_error', "The built-in connection uses the server's own key; change it in Render's settings (E2B_API_KEY).");
      this.save(account, s);
      return this.list(account).find((c) => c.id === id)!;
    }
    const { row, n } = this.find(account, id);
    const def = providerDef(n.provider);
    const next: ConnNotes = { ...n };
    if (input.label !== undefined) next.label = input.label.trim().slice(0, 60) || n.label;
    if (input.apiUrl !== undefined) {
      const u = await cleanApiUrl(def, input.apiUrl, this.o.lookup);
      if (u) next.apiUrl = u;
      else delete next.apiUrl;
    }
    const newKey = input.key?.trim() ? cleanKey(def.id, input.key) : null;
    const f = vaultFields(next);
    this.st.updateVault(account, row.id, { name: f.name, domain: f.domain, usernameEnc: encrypt(f.username), notesEnc: encrypt(f.notes), ...(newKey ? { passwordEnc: encrypt(newKey) } : {}) });
    // a new key or address has not been checked yet
    if (newKey || input.apiUrl !== undefined) delete s.health[id];
    this.save(account, s);
    return this.list(account).find((c) => c.id === id)!;
  }

  setDefault(account: string, id: string): SandboxConnectionPublic[] {
    if (id !== SERVER_CONNECTION_ID || !this.hasServer()) this.find(account, id);
    const s = this.settings(account);
    s.defaultId = id;
    s.disabled = s.disabled.filter((x) => x !== id);
    this.save(account, s);
    return this.list(account);
  }

  remove(account: string, id: string): boolean {
    if (id === SERVER_CONNECTION_ID) throw new AppError('validation_error', "The built-in connection can't be deleted here; switch it off instead.");
    const { row } = this.find(account, id);
    const ok = this.st.deleteVault(account, row.id);
    const s = this.settings(account);
    delete s.health[id];
    s.disabled = s.disabled.filter((x) => x !== id);
    if (s.defaultId === id) delete s.defaultId;
    this.save(account, s);
    for (const k of [...this.providers.keys()]) if (k.startsWith(`${account}|${id}|`)) this.providers.delete(k);
    return ok;
  }

  private keyOf(account: string, id: string): { provider: SandboxProviderId; key: string; apiUrl?: string; label: string; stamp: number } | null {
    if (id === SERVER_CONNECTION_ID) {
      const key = this.o.serverKey();
      return key ? { provider: 'e2b', key, label: 'Built-in (server key)', stamp: 0 } : null;
    }
    const f = this.rows(account).find((x) => x.n.id === id);
    if (!f) return null;
    return { provider: f.n.provider, key: revealLogin(f.row).password, apiUrl: f.n.apiUrl, label: f.n.label, stamp: f.row.updatedAt };
  }

  /** Live check: one cheap authenticated call to the provider. Saves and returns the result. */
  async check(account: string, id: string): Promise<Health> {
    const k = this.keyOf(account, id);
    if (!k) throw new AppError('not_found', 'That sandbox connection is not there any more.');
    let h: Health;
    try {
      if (!k.key) throw new Error('The vault entry has no key. Paste the key again.');
      if (k.provider === 'e2b') {
        const res = await this.f('https://api.e2b.app/sandboxes', { headers: { 'X-API-Key': k.key }, signal: AbortSignal.timeout(20_000) });
        if (!res.ok) {
          const t = await res.text().catch(() => '');
          throw Object.assign(new Error(`E2B ${res.status}: ${t.slice(0, 160)}`), { status: res.status });
        }
        await res.body?.cancel().catch(() => undefined);
      } else {
        await checkDaytonaKey(k.key, { apiUrl: k.apiUrl, fetchImpl: this.f, lookup: this.o.lookup });
      }
      h = { state: 'ok', checkedAt: this.now() };
    } catch (e) {
      h = { state: 'failed', checkedAt: this.now(), error: friendlyHealthError(k.provider, e), failedUntil: this.now() + FAIL_COOLDOWN_MS };
    }
    const s = this.settings(account);
    s.health[id] = h;
    this.save(account, s);
    return h;
  }

  /** Called by the manager when a connection started (ok) or failed to start / died (not ok). */
  markHealth(account: string, id: string, ok: boolean, error?: string): void {
    if (!this.keyOf(account, id)) return;
    const s = this.settings(account);
    const prev = s.health[id];
    if (ok) {
      // write only when something changes (this runs on every computer start)
      if (prev?.state === 'ok' && prev.checkedAt && this.now() - prev.checkedAt < 10 * 60_000) return;
      s.health[id] = { state: 'ok', checkedAt: this.now() };
    } else {
      s.health[id] = { state: 'failed', checkedAt: this.now(), error: (error ?? 'It failed.').slice(0, 240), failedUntil: this.now() + FAIL_COOLDOWN_MS };
    }
    this.save(account, s);
  }

  private providerFor(account: string, id: string): SandboxProvider | null {
    const k = this.keyOf(account, id);
    if (!k) return null;
    const cacheKey = `${account}|${id}|${k.stamp}|${k.apiUrl ?? ''}`;
    let p = this.providers.get(cacheKey);
    if (!p) {
      // the key is re-read from the vault on every start, so a replaced key applies at once
      const key = () => this.keyOf(account, id)?.key ?? '';
      p = this.o.makeProvider ? this.o.makeProvider(k.provider, key, k.apiUrl) : k.provider === 'e2b' ? new E2BProvider(key) : new DaytonaProvider(key, { apiUrl: k.apiUrl, fetchImpl: this.f, lookup: this.o.lookup });
      this.providers.set(cacheKey, p);
    }
    return p;
  }

  /** True when the connection exists and is switched on. */
  isUsable(account: string, id: string): boolean {
    return Boolean(this.keyOf(account, id)) && !this.settings(account).disabled.includes(id);
  }

  labelOf(account: string, id: string): string | null {
    return this.keyOf(account, id)?.label ?? null;
  }

  /** Connections to try, best first: default, then the rest; recently failed ones go last. */
  candidates(account: string): SandboxCandidate[] {
    const s = this.settings(account);
    const def = this.defaultId(account, s);
    const ids = [...this.rows(account).map((x) => x.n.id), ...(this.hasServer() ? [SERVER_CONNECTION_ID] : [])].filter((id) => !s.disabled.includes(id));
    const now = this.now();
    const cooling = (id: string) => Boolean(s.health[id]?.state === 'failed' && (s.health[id]?.failedUntil ?? 0) > now);
    const ordered = [...ids].sort((a, b) => Number(cooling(a)) - Number(cooling(b)) || Number(b === def) - Number(a === def));
    const out: SandboxCandidate[] = [];
    for (const id of ordered) {
      const p = this.providerFor(account, id);
      const label = this.labelOf(account, id);
      if (p && label) out.push({ connectionId: id, label, provider: p });
    }
    return out;
  }
}

const stores = new WeakMap<AgentStore, SandboxConnections>();
export function sandboxConnections(st: AgentStore, o: ConstructorParameters<typeof SandboxConnections>[1]): SandboxConnections {
  let c = stores.get(st);
  if (!c) {
    c = new SandboxConnections(st, o);
    stores.set(st, c);
  }
  return c;
}
