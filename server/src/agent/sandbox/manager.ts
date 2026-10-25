import { logger } from '../../logger.js';
import type { SandboxEvent, SandboxEventKind, SandboxProvider, SandboxSession } from './types.js';

/**
 * One sandbox per owner (agent of a user), started on first use and reused by every tool call
 * after that, so files and installed packages stay between steps. It is closed after a quiet
 * spell (idleMs) or a hard lifetime (maxLifeMs), on request, or when the server stops; before
 * closing, onBeforeClose saves what is worth keeping (sandboxes are wiped when they close).
 * The provider-side timer is kept a little longer than idleMs, so a sandbox is never left
 * running (and billing) if this server dies.
 */

export interface SandboxManagerOptions {
  /** current provider (re-read on every start so admin key changes apply), null when off */
  provider: () => SandboxProvider | null;
  idleMs?: number;
  maxLifeMs?: number;
  /** sandboxes running at once across all users */
  maxSessions?: number;
  /** after start, e.g. restore saved files */
  onStart?: (owner: string, s: SandboxSession, log: (kind: SandboxEventKind, text: string, ok?: boolean) => void) => Promise<void>;
  /** before close, e.g. save changed files; skipped when the session was used from an incognito chat */
  onBeforeClose?: (owner: string, s: SandboxSession, log: (kind: SandboxEventKind, text: string, ok?: boolean) => void) => Promise<void>;
  now?: () => number;
  /** sweep timer period; 0 = no timer (tests call sweep()) */
  sweepMs?: number;
}

interface Entry {
  owner: string;
  session: SandboxSession;
  startedAt: number;
  lastUsedAt: number;
  /** when the provider-side kill timer was last moved */
  extendedAt: number;
  busy: number;
  noSave: boolean;
  closing?: Promise<void>;
}

export interface SandboxStatus {
  provider: string;
  id: string;
  startedAt: number;
  lastUsedAt: number;
  /** when it will close if nothing else happens */
  closesAt: number;
  busy: boolean;
}

export class SandboxBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxBusyError';
  }
}

const MAX_EVENTS = 60;

export class SandboxManager {
  readonly idleMs: number;
  readonly maxLifeMs: number;
  readonly maxSessions: number;
  private readonly sessions = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<Entry>>();
  private readonly events = new Map<string, SandboxEvent[]>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;

  constructor(private readonly o: SandboxManagerOptions) {
    this.idleMs = o.idleMs ?? 10 * 60_000;
    this.maxLifeMs = o.maxLifeMs ?? 45 * 60_000;
    this.maxSessions = o.maxSessions ?? 4;
    this.now = o.now ?? Date.now;
    const sweepMs = o.sweepMs ?? 30_000;
    if (sweepMs > 0) {
      this.timer = setInterval(() => void this.sweep(), sweepMs);
      this.timer.unref();
    }
  }

  /** null when sandboxes can be used, otherwise what is missing */
  needs(): string | null {
    const p = this.o.provider();
    return p ? p.needs() : 'a sandbox provider (E2B_API_KEY)';
  }

  providerId(): string | null {
    return this.o.provider()?.id ?? null;
  }

  log(owner: string, kind: SandboxEventKind, text: string, ok = true, extra: Partial<SandboxEvent> = {}) {
    const list = this.events.get(owner) ?? [];
    list.push({ at: this.now(), kind, text: text.slice(0, 300), ok, ...extra });
    if (list.length > MAX_EVENTS) list.splice(0, list.length - MAX_EVENTS);
    this.events.set(owner, list);
  }

  activity(owner: string): SandboxEvent[] {
    return [...(this.events.get(owner) ?? [])].reverse();
  }

  status(owner: string): SandboxStatus | null {
    const e = this.sessions.get(owner);
    if (!e || e.closing) return null;
    return { provider: e.session.provider, id: e.session.id, startedAt: e.startedAt, lastUsedAt: e.lastUsedAt, closesAt: Math.min(e.lastUsedAt + this.idleMs, e.startedAt + this.maxLifeMs), busy: e.busy > 0 };
  }

  activeCount(): number {
    return [...this.sessions.values()].filter((e) => !e.closing).length;
  }

  /**
   * Runs fn with the owner's sandbox (starting one if needed). The sandbox is marked busy while fn
   * runs, so the idle sweep never closes it mid-command.
   */
  async use<T>(owner: string, fn: (s: SandboxSession) => Promise<T>, opts: { signal?: AbortSignal; incognito?: boolean } = {}): Promise<T> {
    const e = await this.acquire(owner, opts.signal);
    if (opts.incognito) e.noSave = true;
    e.busy++;
    e.lastUsedAt = this.now();
    try {
      await this.keepAlive(e);
      return await fn(e.session);
    } finally {
      e.busy--;
      e.lastUsedAt = this.now();
    }
  }

  private async keepAlive(e: Entry) {
    // Move the provider's own kill timer only when a good part of it has passed (one API call).
    if (this.now() - e.extendedAt < this.idleMs / 3) return;
    try {
      await e.session.extend(this.idleMs + 2 * 60_000);
      e.extendedAt = this.now();
    } catch (err) {
      logger.warn('sandbox keep-alive failed', { id: e.session.id, err: String(err) });
    }
  }

  private async acquire(owner: string, signal?: AbortSignal): Promise<Entry> {
    const cur = this.sessions.get(owner);
    if (cur && !cur.closing) {
      if (this.now() - cur.startedAt < this.maxLifeMs || cur.busy > 0) return cur;
      await this.close(owner, 'it reached its time limit');
    } else if (cur?.closing) {
      await cur.closing;
    }
    const pending = this.starting.get(owner);
    if (pending) return pending;
    const p = this.start(owner, signal).finally(() => this.starting.delete(owner));
    this.starting.set(owner, p);
    return p;
  }

  private async start(owner: string, signal?: AbortSignal): Promise<Entry> {
    const provider = this.o.provider();
    const missing = provider ? provider.needs() : 'a sandbox provider';
    if (!provider || missing) throw new Error(`The sandbox is not set up on this server (needs ${missing}).`);
    if (this.activeCount() + this.starting.size >= this.maxSessions) {
      // free the quietest idle sandbox of someone else before giving up
      const idle = [...this.sessions.values()].filter((x) => !x.closing && x.busy === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (idle) await this.close(idle.owner, 'the server needed room for another sandbox');
      else throw new SandboxBusyError('All sandboxes on this server are busy right now. Try again in a minute.');
    }
    const t0 = this.now();
    let session: SandboxSession;
    try {
      session = await provider.create({ timeoutMs: this.idleMs + 2 * 60_000, metadata: { app: 'orin', owner: owner.slice(0, 64) }, signal });
    } catch (err) {
      this.log(owner, 'error', `Could not start the sandbox: ${String((err as Error)?.message ?? err)}`, false);
      throw err;
    }
    const e: Entry = { owner, session, startedAt: this.now(), lastUsedAt: this.now(), extendedAt: this.now(), busy: 0, noSave: false };
    this.sessions.set(owner, e);
    this.log(owner, 'start', `Started a ${provider.id.toUpperCase()} sandbox`, true, { ms: this.now() - t0, sandboxId: session.id });
    logger.info('sandbox started', { provider: provider.id, id: session.id, ms: this.now() - t0 });
    if (this.o.onStart) {
      try {
        await this.o.onStart(owner, session, (k, t, ok = true) => this.log(owner, k, t, ok, { sandboxId: session.id }));
      } catch (err) {
        this.log(owner, 'error', `Could not restore saved files: ${String((err as Error)?.message ?? err)}`, false);
      }
    }
    return e;
  }

  /** Saves (unless incognito), then shuts the owner's sandbox down. Safe to call twice. */
  async close(owner: string, reason = 'you asked'): Promise<boolean> {
    const e = this.sessions.get(owner);
    if (!e) return false;
    if (e.closing) {
      await e.closing;
      return true;
    }
    e.closing = (async () => {
      const log = (k: SandboxEventKind, t: string, ok = true) => this.log(owner, k, t, ok, { sandboxId: e.session.id });
      if (this.o.onBeforeClose && !e.noSave) {
        try {
          await this.o.onBeforeClose(owner, e.session, log);
        } catch (err) {
          log('error', `Could not save files before closing: ${String((err as Error)?.message ?? err)}`, false);
        }
      }
      try {
        await e.session.close();
      } catch (err) {
        logger.warn('sandbox close failed (the provider timer still kills it)', { id: e.session.id, err: String(err) });
      }
      log('close', `Closed the sandbox because ${reason}`);
      logger.info('sandbox closed', { id: e.session.id, reason, minutes: Math.round((this.now() - e.startedAt) / 60_000) });
    })().finally(() => this.sessions.delete(owner));
    await e.closing;
    return true;
  }

  /** Closes sandboxes that have been quiet for idleMs or alive for maxLifeMs (never one mid-command). */
  async sweep(): Promise<string[]> {
    const now = this.now();
    const closed: string[] = [];
    for (const e of [...this.sessions.values()]) {
      if (e.closing || e.busy > 0) continue;
      if (now - e.lastUsedAt >= this.idleMs) {
        closed.push(e.owner);
        await this.close(e.owner, 'it was not used for a while');
      } else if (now - e.startedAt >= this.maxLifeMs) {
        closed.push(e.owner);
        await this.close(e.owner, 'it reached its time limit');
      }
    }
    return closed;
  }

  async closeAll(reason = 'the server is stopping'): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await Promise.all([...this.sessions.keys()].map((o) => this.close(o, reason)));
  }
}
