/**
 * Minimal Firestore REST client for durable storage.
 *
 * The server signs in to Firebase Auth as one email/password account whose password is derived
 * from VAULT_KEY (see durable/index.ts), so no service-account key file exists anywhere. Firestore
 * security rules only let that one account read or write. Project ID and Web API key are public
 * client identifiers, not secrets.
 */

export interface FirestoreOptions {
  projectId: string;
  apiKey: string;
  email: string;
  password: string;
  /** Overrides for tests / the emulator. */
  firestoreBase?: string;
  authBase?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type FieldValue =
  | { stringValue: string }
  | { integerValue: string }
  | { bytesValue: string }
  | { booleanValue: boolean }
  | { nullValue: null };

export interface FsDoc {
  /** Document id (last path segment). */
  id: string;
  fields: Record<string, FieldValue>;
}

export type FsWrite = { op: 'set'; collection: string; id: string; fields: Record<string, FieldValue> } | { op: 'delete'; collection: string; id: string };

export class FirestoreError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export class FirestoreClient {
  private token = '';
  private tokenExp = 0;
  private readonly fetch: typeof fetch;
  private readonly fsBase: string;
  private readonly authBase: string;

  constructor(private readonly o: FirestoreOptions) {
    this.fetch = o.fetchImpl ?? fetch;
    this.fsBase = (o.firestoreBase ?? 'https://firestore.googleapis.com').replace(/\/+$/, '');
    this.authBase = (o.authBase ?? 'https://identitytoolkit.googleapis.com').replace(/\/+$/, '');
  }

  private get docsRoot(): string {
    return `${this.fsBase}/v1/projects/${encodeURIComponent(this.o.projectId)}/databases/(default)/documents`;
  }

  private async req(url: string, init: RequestInit & { auth?: boolean } = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set('content-type', 'application/json');
    if (init.auth !== false) headers.set('authorization', `Bearer ${await this.idToken()}`);
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), this.o.timeoutMs ?? 30_000);
    try {
      return await this.fetch(url, { ...init, headers, signal: ctl.signal });
    } finally {
      clearTimeout(t);
    }
  }

  /** Firebase Auth ID token (1 hour). Signs in, creating the account on the very first run. */
  async idToken(): Promise<string> {
    if (this.token && Date.now() < this.tokenExp - 120_000) return this.token;
    const body = JSON.stringify({ email: this.o.email, password: this.o.password, returnSecureToken: true });
    let r = await this.req(`${this.authBase}/v1/accounts:signInWithPassword?key=${encodeURIComponent(this.o.apiKey)}`, { method: 'POST', body, auth: false });
    let j = (await r.json().catch(() => ({}))) as { idToken?: string; expiresIn?: string; error?: { message?: string } };
    const msg = j.error?.message ?? '';
    if (!r.ok && /EMAIL_NOT_FOUND|INVALID_LOGIN_CREDENTIALS/.test(msg)) {
      // First run: create the server account. If it already exists, the password is wrong
      // (VAULT_KEY changed) and sign-up fails with EMAIL_EXISTS, which we report as such.
      r = await this.req(`${this.authBase}/v1/accounts:signUp?key=${encodeURIComponent(this.o.apiKey)}`, { method: 'POST', body, auth: false });
      j = (await r.json().catch(() => ({}))) as typeof j;
      if (!r.ok && /EMAIL_EXISTS/.test(j.error?.message ?? '')) {
        throw new FirestoreError('Firebase sign-in failed: the server account exists but its password does not match. Was VAULT_KEY changed?', 401);
      }
    }
    if (!r.ok || !j.idToken) throw new FirestoreError(`Firebase sign-in failed: ${j.error?.message ?? r.status}`, r.status);
    this.token = j.idToken;
    this.tokenExp = Date.now() + Number(j.expiresIn ?? 3600) * 1000;
    return this.token;
  }

  async get(collection: string, id: string): Promise<FsDoc | null> {
    const r = await this.req(`${this.docsRoot}/${collection}/${encodeURIComponent(id)}`);
    if (r.status === 404) return null;
    if (!r.ok) throw new FirestoreError(`Firestore get ${collection}/${id}: ${r.status} ${await safeText(r)}`, r.status);
    return toDoc((await r.json()) as RawDoc);
  }

  /** Lists every document in a collection (paged). */
  async list(collection: string, fieldMask?: string[]): Promise<FsDoc[]> {
    const out: FsDoc[] = [];
    let pageToken = '';
    for (let i = 0; i < 10_000; i++) {
      const q = new URLSearchParams({ pageSize: '300' });
      if (pageToken) q.set('pageToken', pageToken);
      for (const f of fieldMask ?? []) q.append('mask.fieldPaths', f);
      const r = await this.req(`${this.docsRoot}/${collection}?${q}`);
      if (!r.ok) throw new FirestoreError(`Firestore list ${collection}: ${r.status} ${await safeText(r)}`, r.status);
      const j = (await r.json()) as { documents?: RawDoc[]; nextPageToken?: string };
      for (const d of j.documents ?? []) out.push(toDoc(d));
      if (!j.nextPageToken) break;
      pageToken = j.nextPageToken;
    }
    return out;
  }

  /** Applies all writes atomically (max 500 writes and ~10 MB per call). */
  async commit(writes: FsWrite[]): Promise<void> {
    if (!writes.length) return;
    const name = (c: string, id: string) => `projects/${this.o.projectId}/databases/(default)/documents/${c}/${id}`;
    const body = {
      writes: writes.map((w) => (w.op === 'delete' ? { delete: name(w.collection, w.id) } : { update: { name: name(w.collection, w.id), fields: w.fields } })),
    };
    const r = await this.req(`${this.docsRoot}:commit`, { method: 'POST', body: JSON.stringify(body) });
    if (!r.ok) throw new FirestoreError(`Firestore commit: ${r.status} ${await safeText(r)}`, r.status);
  }
}

interface RawDoc {
  name: string;
  fields?: Record<string, FieldValue>;
}

function toDoc(d: RawDoc): FsDoc {
  return { id: decodeURIComponent(d.name.slice(d.name.lastIndexOf('/') + 1)), fields: d.fields ?? {} };
}

async function safeText(r: Response): Promise<string> {
  try {
    return (await r.text()).slice(0, 300);
  } catch {
    return '';
  }
}

export const str = (v: string): FieldValue => ({ stringValue: v });
export const int = (v: number): FieldValue => ({ integerValue: String(Math.trunc(v)) });
export const bytes = (b: Buffer): FieldValue => ({ bytesValue: b.toString('base64') });
export function getStr(d: FsDoc, k: string): string {
  const f = d.fields[k] as { stringValue?: string } | undefined;
  return f?.stringValue ?? '';
}
export function getInt(d: FsDoc, k: string): number {
  const f = d.fields[k] as { integerValue?: string } | undefined;
  return Number(f?.integerValue ?? 0);
}
export function getBytes(d: FsDoc, k: string): Buffer {
  const f = d.fields[k] as { bytesValue?: string } | undefined;
  return Buffer.from(f?.bytesValue ?? '', 'base64');
}
