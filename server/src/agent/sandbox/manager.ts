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
  /**
   * The owner's sandbox connections to try, best first (AI setup > Sandboxes). When it returns any,
   * they are used instead of provider(); when one cannot start a computer the next is tried.
   */
  candidates?: (owner: string) => SandboxCandidate[];
  /** told when a connection started a computer (ok) or failed to start / died (not ok) */
  onHealth?: (owner: string, connectionId: string, ok: boolean, error?: string) => void;
  now?: () => number;
  /** sweep timer period; 0 = no timer (tests call sweep()) */
  sweepMs?: number;
}

export interface SandboxCandidate {
  connectionId: string;
  label: string;
  provider: SandboxProvider;
}

/** What was lost when a computer stopped by itself (shown to Orin and in the status). */
export interface SandboxInterruption {
  at: number;
  label: string;
  reason: string;
  /** a background job (sandbox_job) was probably still running */
  jobInterrupted: boolean;
}

interface Entry {
  owner: string;
  session: SandboxSession;
  /** the connection it runs on (null = the plain provider(), no connections set up) */
  connectionId: string | null;
  label: string;
  /** close as soon as the current command finishes (its connection was removed or switched off) */
  retire?: string;
  startedAt: number;
  lastUsedAt: number;
  /** when the provider-side kill timer was last moved */
  extendedAt: number;
  busy: number;
  noSave: boolean;
  /** a background job (sandbox_job) may still be running until about this time */
  jobUntil?: number;
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
  connectionId: string | null;
  label: string;
}

export class SandboxBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SandboxBusyError';
  }
}

const MAX_EVENTS = 60;

/** Errors that mean the computer itself is gone (not a command that failed). Confirmed by a probe. */
const GONE = /sandbox (?:was )?not found|sandbox .*(?:not running|terminated|killed|stopped|expired)|not found.*sandbox|\b(?:404|502|503)\b|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|other side closed|terminated|connection (?:was )?(?:closed|reset)/i;
const msgOf = (e: unknown) => String((e as Error)?.message ?? e);

export class SandboxManager {
  readonly idleMs: number;
  readonly maxLifeMs: number;
  readonly maxSessions: number;
  private readonly sessions = new Map<string, Entry>();
  private readonly starting = new Map<string, Promise<Entry>>();
  private readonly events = new Map<string, SandboxEvent[]>();
  private readonly interruptions = new Map<string, SandboxInterruption>();
  private readonly now: () => number;
  private timer?: NodeJS.Timeout;

  constructor(private readonly o: SandboxManagerOptions) {
    this.idleMs = o.idleMs ?? 10 * 60_000;
    // E2B's free plan ends every sandbox after one hour, so the default stays just under that.
    this.maxLifeMs = o.maxLifeMs ?? (Number(process.env.E2B_MAX_LIFE_MIN) || 55) * 60_000;
    this.maxSessions = o.maxSessions ?? 4;
    this.now = o.now ?? Date.now;
    const sweepMs = o.sweepMs ?? 30_000;
    if (sweepMs > 0) {
      this.timer = setInterval(() => void this.sweep(), sweepMs);
      this.timer.unref();
    }
  }

  /** null when sandboxes can be used (for this owner, when given), otherwise what is missing */
  needs(owner?: string): string | null {
    if (owner && this.o.candidates) {
      // the owner's connections are the whole list (the server key is in it as "Built-in")
      return this.list(owner).some((c) => !c.provider.needs()) ? null : 'a working sandbox connection (AI setup > Sandboxes)';
    }
    const p = this.o.provider();
    return p ? p.needs() : 'a sandbox connection (AI setup > Sandboxes) or E2B_API_KEY';
  }

  /** The last time the owner's computer stopped by itself, if it was recent. */
  lastInterruption(owner: string): SandboxInterruption | null {
    const i = this.interruptions.get(owner);
    return i && this.now() - i.at < 60 * 60_000 ? i : null;
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
    return { provider: e.session.provider, id: e.session.id, startedAt: e.startedAt, lastUsedAt: e.lastUsedAt, closesAt: Math.min(e.lastUsedAt + this.idleMs, e.startedAt + this.maxLifeMs), busy: e.busy > 0, connectionId: e.connectionId, label: e.label };
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
    } catch (err) {
      if (!opts.signal?.aborted && !e.closing && GONE.test(msgOf(err)) && !(await this.alive(e))) {
        throw new Error(this.markDead(e, msgOf(err)));
      }
      throw err;
    } finally {
      e.busy--;
      e.lastUsedAt = this.now();
      if (e.retire && e.busy === 0 && !e.closing) void this.close(owner, e.retire);
    }
  }

  /** A tiny command, to tell a failed command from a computer that is gone. */
  private async alive(e: Entry): Promise<boolean> {
    try {
      const r = await e.session.exec('true', { cwd: '/', timeoutMs: 15_000 });
      return r.exitCode === 0 || r.exitCode === null;
    } catch {
      return false;
    }
  }

  /**
   * The computer stopped by itself (provider ended it, out of credit, network gone): forget it,
   * mark the connection as failing so the next start goes to another one, and say what was lost.
   */
  private markDead(e: Entry, reason: string): string {
    this.sessions.delete(e.owner);
    e.closing = Promise.resolve();
    const jobInterrupted = Boolean(e.jobUntil && this.now() < e.jobUntil);
    this.interruptions.set(e.owner, { at: this.now(), label: e.label, reason: reason.slice(0, 200), jobInterrupted });
    this.log(e.owner, 'error', `The computer on ${e.label} stopped by itself (${reason.slice(0, 120)})`, false, { sandboxId: e.session.id });
    logger.warn('sandbox died', { id: e.session.id, connection: e.connectionId, reason: reason.slice(0, 200) });
    if (e.connectionId) this.o.onHealth?.(e.owner, e.connectionId, false, `The computer stopped by itself: ${reason.slice(0, 160)}`);
    void e.session.close().catch(() => undefined);
    return (
      `The computer on ${e.label} stopped by itself (${reason.slice(0, 120)}). ` +
      'Files saved before that are kept; changes since the last save' +
      (jobInterrupted ? ' and the background job that was running' : '') +
      ' were lost. The next step starts a new computer' +
      (this.o.candidates ? ' on the next working sandbox connection' : '') +
      ' with the saved files; nothing was re-run automatically.'
    );
  }

  /**
   * A connection was removed or switched off: computers on it close (saving first) now if idle,
   * or right after the command that is running. Returns how many were affected.
   */
  retireConnection(connectionId: string, reason: string, owners?: (owner: string) => boolean): number {
    let n = 0;
    for (const e of this.sessions.values()) {
      if (e.closing || e.connectionId !== connectionId || (owners && !owners(e.owner))) continue;
      n++;
      if (e.busy > 0) e.retire = reason;
      else void this.close(e.owner, reason);
    }
    return n;
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
      // a computer stays on the connection it started on (jobs and files are there) until it closes
      if (cur.retire && cur.busy === 0) await this.close(owner, cur.retire);
      else if (this.now() - cur.startedAt < this.maxLifeMs || cur.busy > 0) return cur;
      else await this.close(owner, 'it reached its time limit');
    } else if (cur?.closing) {
      await cur.closing;
    }
    const pending = this.starting.get(owner);
    if (pending) return pending;
    const p = this.start(owner, signal).finally(() => this.starting.delete(owner));
    this.starting.set(owner, p);
    return p;
  }

  private list(owner: string): SandboxCandidate[] {
    let list: SandboxCandidate[] = [];
    if (this.o.candidates) {
      try {
        list = this.o.candidates(owner);
      } catch (err) {
        logger.warn('sandbox connections lookup failed', { err: String(err) });
      }
    }
    if (!list.length && !this.o.candidates) {
      const p = this.o.provider();
      if (p) list = [{ connectionId: '', label: p.id.toUpperCase(), provider: p }];
    }
    return list;
  }

  private async start(owner: string, signal?: AbortSignal): Promise<Entry> {
    const list = this.list(owner).filter((c) => !c.provider.needs());
    if (!list.length) {
      const p = this.o.candidates ? null : this.o.provider();
      throw new Error(`No sandbox is set up (needs ${p?.needs() ?? 'a working sandbox connection: add or switch one on in AI setup > Sandboxes'}).`);
    }
    if (this.activeCount() + this.starting.size >= this.maxSessions) {
      // free the quietest idle sandbox of someone else before giving up
      const idle = [...this.sessions.values()].filter((x) => !x.closing && x.busy === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (idle) await this.close(idle.owner, 'the server needed room for another sandbox');
      else throw new SandboxBusyError('All sandboxes on this server are busy right now. Try again in a minute.');
    }
    const t0 = this.now();
    let session: SandboxSession | null = null;
    let used: SandboxCandidate = list[0]!;
    const failed: string[] = [];
    let lastErr: unknown;
    for (const c of list) {
      try {
        session = await c.provider.create({ timeoutMs: this.idleMs + 2 * 60_000, metadata: { app: 'orin', owner: owner.slice(0, 64) }, signal });
        used = c;
        break;
      } catch (err) {
        lastErr = err;
        const m = msgOf(err).slice(0, 200);
        failed.push(`${c.label}: ${m}`);
        if (c.connectionId) this.o.onHealth?.(owner, c.connectionId, false, `Could not start a computer: ${m}`);
        if (signal?.aborted) break;
        const next = list[list.indexOf(c) + 1];
        if (list.length > 1) this.log(owner, 'error', `Could not start a computer on ${c.label}: ${m}${next ? ` Trying ${next.label}.` : ''}`, false);
      }
    }
    if (!session) {
      if (list.length === 1) {
        this.log(owner, 'error', `Could not start the sandbox: ${msgOf(lastErr)}`, false);
        throw lastErr;
      }
      throw new Error(`No sandbox connection could start a computer. ${failed.join(' | ')}`);
    }
    const e: Entry = { owner, session, connectionId: used.connectionId || null, label: used.label, startedAt: this.now(), lastUsedAt: this.now(), extendedAt: this.now(), busy: 0, noSave: false };
    this.sessions.set(owner, e);
    if (used.connectionId) this.o.onHealth?.(owner, used.connectionId, true);
    const via = failed.length ? ` after ${failed.length} connection${failed.length > 1 ? 's' : ''} failed` : '';
    this.log(owner, 'start', this.o.candidates && used.connectionId ? `Started a computer on ${used.label}${via}` : `Started a ${used.provider.id.toUpperCase()} sandbox${via}`, true, { ms: this.now() - t0, sandboxId: session.id });
    logger.info('sandbox started', { provider: used.provider.id, connection: used.connectionId || undefined, failedOver: failed.length || undefined, id: session.id, ms: this.now() - t0 });
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

  /** Time left before the owner's sandbox reaches its hard lifetime (null when none is open). */
  remainingMs(owner: string): number | null {
    const e = this.sessions.get(owner);
    if (!e || e.closing) return null;
    return e.startedAt + this.maxLifeMs - this.now();
  }

  /** Marks that a background job was started: the idle sweep keeps the sandbox while it runs. */
  markJob(owner: string, maxMs = this.maxLifeMs): void {
    const e = this.sessions.get(owner);
    if (e) e.jobUntil = Math.max(e.jobUntil ?? 0, this.now() + maxMs);
  }

  /** True while a sandbox_job is still running (its .exit file is not written yet). */
  private async jobRunning(e: Entry): Promise<boolean> {
    try {
      const r = await e.session.exec('for f in /home/user/.orin/jobs/*.pid; do [ -e "$f" ] || continue; [ -e "${f%.pid}.exit" ] || { echo running; break; }; done', { cwd: '/', timeoutMs: 20_000 });
      return r.stdout.includes('running');
    } catch {
      return false;
    }
  }

  /** Closes sandboxes that have been quiet for idleMs or alive for maxLifeMs (never one mid-command). */
  async sweep(): Promise<string[]> {
    const now = this.now();
    const closed: string[] = [];
    for (const e of [...this.sessions.values()]) {
      if (e.closing || e.busy > 0) continue;
      if (now - e.lastUsedAt >= this.idleMs && e.jobUntil && now < e.jobUntil && now - e.startedAt < this.maxLifeMs) {
        // A long build or job is still running in the background: keep the computer on.
        if (await this.jobRunning(e)) {
          await this.keepAlive(e);
          continue;
        }
        e.jobUntil = undefined;
      }
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
