import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { SignJWT, jwtVerify } from 'jose';
import { AppError } from '../errors.js';

/**
 * Orin accounts: email + password sign-in through Firebase Authentication (the same Firebase project
 * that keeps the server's saved data), with no extra setup on Render.
 *
 * An account is bound to a workspace: the id the app already uses for all of its data (chats,
 * memory, keys, sandboxes, profile picture). Signing up binds the device's current workspace, so
 * nothing is lost; signing in on another device hands that device the same workspace id, so the
 * data follows the account. The app keeps a session token (HS256, signed with a key derived from
 * VAULT_KEY) to show who is signed in.
 */
export interface OrinAccount {
  uid: string;
  email: string;
  name: string;
  workspace: string;
  createdAt: number;
  updatedAt: number;
}

export interface AccountPublic {
  uid: string;
  email: string;
  name: string;
  createdAt: number;
}

export interface FirebaseAuthApi {
  signUp(email: string, password: string): Promise<{ localId: string; idToken: string }>;
  signIn(email: string, password: string): Promise<{ localId: string; idToken: string; email?: string }>;
  sendReset(email: string): Promise<void>;
  remove(idToken: string): Promise<void>;
}

type Code = 'validation_error' | 'forbidden' | 'rate_limited' | 'provider_not_configured';
const FIREBASE_ERRORS: Record<string, [Code, string]> = {
  EMAIL_EXISTS: ['validation_error', 'An account with this email already exists. Sign in instead.'],
  INVALID_EMAIL: ['validation_error', 'That email address does not look right.'],
  MISSING_EMAIL: ['validation_error', 'Enter your email address.'],
  MISSING_PASSWORD: ['validation_error', 'Enter your password.'],
  INVALID_PASSWORD: ['forbidden', 'Wrong email or password.'],
  EMAIL_NOT_FOUND: ['forbidden', 'Wrong email or password.'],
  INVALID_LOGIN_CREDENTIALS: ['forbidden', 'Wrong email or password.'],
  USER_DISABLED: ['forbidden', 'This account has been turned off.'],
  TOO_MANY_ATTEMPTS_TRY_LATER: ['rate_limited', 'Too many tries. Please wait a few minutes and try again.'],
  OPERATION_NOT_ALLOWED: ['provider_not_configured', 'Email sign-in is turned off for this server.'],
  ADMIN_ONLY_OPERATION: ['provider_not_configured', 'New sign-ups are turned off for this server.'],
};

function firebaseError(raw: string): AppError {
  const key = raw.split(':')[0]!.trim().split(' ')[0]!;
  if (key.startsWith('WEAK_PASSWORD')) return new AppError('validation_error', 'Use a password with at least 8 characters.');
  const hit = FIREBASE_ERRORS[key];
  if (hit) return new AppError(hit[0], hit[1], hit[0] === 'validation_error' && key === 'EMAIL_EXISTS' ? { status: 409 } : {});
  return new AppError('provider_unavailable', 'Sign-in service had a problem. Please try again.');
}

export function firebaseAuthApi(apiKey: string, base = 'https://identitytoolkit.googleapis.com'): FirebaseAuthApi {
  const call = async (path: string, body: unknown) => {
    let res: Response;
    try {
      res = await fetch(`${base}/v1/${path}?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AppError('provider_unavailable', 'Could not reach the sign-in service. Please try again.');
    }
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } } & Record<string, unknown>;
    if (!res.ok) throw firebaseError(String(data.error?.message ?? ''));
    return data;
  };
  return {
    async signUp(email, password) {
      const d = await call('accounts:signUp', { email, password, returnSecureToken: true });
      return { localId: String(d.localId), idToken: String(d.idToken) };
    },
    async signIn(email, password) {
      const d = await call('accounts:signInWithPassword', { email, password, returnSecureToken: true });
      return { localId: String(d.localId), idToken: String(d.idToken), email: typeof d.email === 'string' ? d.email : undefined };
    },
    async sendReset(email) {
      await call('accounts:sendOobCode', { requestType: 'PASSWORD_RESET', email });
    },
    async remove(idToken) {
      await call('accounts:delete', { idToken });
    },
  };
}

const SESSION_DAYS = 180;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function cleanEmail(v: unknown): string {
  const e = String(v ?? '').trim().toLowerCase();
  if (!EMAIL_RE.test(e) || e.length > 200) throw new AppError('validation_error', 'That email address does not look right.');
  return e;
}
export function cleanName(v: unknown): string {
  const n = String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  if (!n) throw new AppError('validation_error', 'Enter your name.');
  return n;
}
function cleanPassword(v: unknown, isNew: boolean): string {
  const p = String(v ?? '');
  if (!p) throw new AppError('validation_error', 'Enter your password.');
  if (isNew && p.length < 8) throw new AppError('validation_error', 'Use a password with at least 8 characters.');
  if (p.length > 200) throw new AppError('validation_error', 'That password is too long.');
  return p;
}

export class OrinAccounts {
  private cache: Record<string, OrinAccount> | null = null;
  constructor(
    private readonly file: string,
    private readonly auth: FirebaseAuthApi,
    private readonly secret: () => string,
    /** The server's own Firebase sign-in (it keeps the saved data); never usable as an Orin account. */
    private readonly reserved: string[] = [],
  ) {}

  private notReserved(email: string): void {
    if (this.reserved.includes(email)) throw new AppError('forbidden', 'This email cannot be used for an Orin account.');
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): OrinAccounts | null {
    const apiKey = (env.FIREBASE_API_KEY ?? '').trim();
    if (!apiKey || (env.ORIN_ACCOUNTS ?? '').toLowerCase() === 'off') return null;
    const file = join(resolve(env.DATA_DIR || './data'), 'accounts', 'accounts.json');
    return new OrinAccounts(file, firebaseAuthApi(apiKey, (env.FIREBASE_AUTH_BASE_URL ?? '').trim() || undefined), () => {
      const k = (env.VAULT_KEY ?? '').trim() || (env.ADMIN_TOKEN ?? '').trim();
      if (!k) throw new AppError('provider_not_configured', 'Accounts need VAULT_KEY on the server.');
      return createHmac('sha256', k).update('orin-account-session-v1').digest('hex');
    }, [(env.FIREBASE_SERVER_EMAIL ?? '').trim().toLowerCase()].filter(Boolean));
  }

  private all(): Record<string, OrinAccount> {
    if (this.cache) return this.cache;
    try {
      this.cache = existsSync(this.file) ? (JSON.parse(readFileSync(this.file, 'utf8')) as Record<string, OrinAccount>) : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }
  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${randomUUID().slice(0, 8)}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.all(), null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }
  private byWorkspace(ws: string): OrinAccount | undefined {
    return Object.values(this.all()).find((a) => a.workspace === ws);
  }

  static pub(a: OrinAccount): AccountPublic {
    return { uid: a.uid, email: a.email, name: a.name, createdAt: a.createdAt };
  }

  async session(a: OrinAccount): Promise<string> {
    return new SignJWT({ email: a.email, wid: a.workspace })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(a.uid)
      .setIssuer('orin')
      .setAudience('orin-app')
      .setIssuedAt()
      .setExpirationTime(`${SESSION_DAYS}d`)
      .sign(new TextEncoder().encode(this.secret()));
  }

  /** The account a session token belongs to (throws auth_expired when it is not valid any more). */
  async verify(token: string): Promise<OrinAccount> {
    let sub: string | undefined;
    try {
      const { payload } = await jwtVerify(token, new TextEncoder().encode(this.secret()), { issuer: 'orin', audience: 'orin-app' });
      sub = payload.sub;
    } catch {
      throw new AppError('auth_expired', 'You were signed out. Please sign in again.');
    }
    const a = sub ? this.all()[sub] : undefined;
    if (!a) throw new AppError('auth_expired', 'You were signed out. Please sign in again.');
    return a;
  }

  async signUp(input: { name: unknown; email: unknown; password: unknown }, workspace: string) {
    const name = cleanName(input.name);
    const email = cleanEmail(input.email);
    const password = cleanPassword(input.password, true);
    this.notReserved(email);
    const taken = this.byWorkspace(workspace);
    if (taken) throw new AppError('validation_error', `This device is already signed in as ${taken.email}. Sign out first.`);
    const { localId } = await this.auth.signUp(email, password);
    const now = Date.now();
    const a: OrinAccount = { uid: localId, email, name, workspace, createdAt: now, updatedAt: now };
    this.all()[localId] = a;
    this.save();
    return { account: a, session: await this.session(a) };
  }

  async signIn(input: { email: unknown; password: unknown }, workspace: string) {
    const email = cleanEmail(input.email);
    const password = cleanPassword(input.password, false);
    this.notReserved(email);
    const { localId } = await this.auth.signIn(email, password);
    let a = this.all()[localId];
    if (!a) {
      // made in Firebase but not here yet (e.g. lost record): bind this device's workspace
      const now = Date.now();
      a = { uid: localId, email, name: email.split('@')[0]!, workspace, createdAt: now, updatedAt: now };
      this.all()[localId] = a;
      this.save();
    }
    return { account: a, session: await this.session(a), workspace: a.workspace, moved: a.workspace !== workspace };
  }

  update(a: OrinAccount, patch: { name?: unknown }): OrinAccount {
    if (patch.name !== undefined) a.name = cleanName(patch.name);
    a.updatedAt = Date.now();
    this.save();
    return a;
  }

  async sendReset(email: unknown): Promise<void> {
    const e = cleanEmail(email);
    try {
      await this.auth.sendReset(e);
    } catch (err) {
      // do not reveal whether an email has an account
      if (err instanceof AppError && err.code === 'forbidden') return;
      throw err;
    }
  }

  /** Deletes the sign-in (needs the password again). The workspace data stays on this device. */
  async remove(a: OrinAccount, password: unknown): Promise<void> {
    const { idToken } = await this.auth.signIn(a.email, cleanPassword(password, false));
    await this.auth.remove(idToken);
    delete this.all()[a.uid];
    this.save();
  }
}
