import { randomUUID } from 'node:crypto';
import type { Response } from 'express';

/**
 * Chat replies that outlive the connection, like Sesame: the agent keeps working on the server when
 * the phone goes to the background, the app is closed or the network drops. Every event of a run is
 * kept (in order) so the app can come back and pick up from the last one it saw
 * (GET /v1/agent/runs/:id/events?after=N). A run that finishes with nobody listening puts its
 * reply in the inbox, which the app delivers into the same chat message and notifies about.
 */
export interface RunEvent {
  event: string;
  data: unknown;
}

const KEEP_DONE_MS = 20 * 60_000;

export class ChatRun {
  readonly id = randomUUID();
  readonly createdAt = Date.now();
  readonly controller = new AbortController();
  readonly events: RunEvent[] = [];
  done = false;
  finishedAt = 0;
  /** true once a client has dropped off at least once */
  everDetached = false;
  private subs = new Set<(e: RunEvent | null) => void>();

  constructor(
    readonly owner: string,
    readonly account: string,
    readonly replyId: string | null,
    readonly conversationId: string | null,
  ) {}

  get attached(): boolean {
    return this.subs.size > 0;
  }

  emit(event: string, data: unknown) {
    if (this.done) return;
    const e = { event, data };
    this.events.push(e);
    for (const s of this.subs) s(e);
  }

  end() {
    if (this.done) return;
    this.done = true;
    this.finishedAt = Date.now();
    for (const s of this.subs) s(null);
    this.subs.clear();
  }

  /** Streams events after `after` to res, then live ones, until the run ends or res closes. */
  attach(res: Response, after = 0) {
    const write = (e: RunEvent) => res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    for (let i = Math.max(0, after); i < this.events.length; i++) write(this.events[i]!);
    if (this.done) {
      res.end();
      return;
    }
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
    const sub = (e: RunEvent | null) => {
      if (e) write(e);
      else {
        clearInterval(heartbeat);
        if (!res.writableEnded) res.end();
      }
    };
    this.subs.add(sub);
    res.on('close', () => {
      clearInterval(heartbeat);
      if (this.subs.delete(sub) && !this.done) this.everDetached = true;
    });
  }
}

export class ChatRunRegistry {
  private runs = new Map<string, ChatRun>();

  create(owner: string, account: string, replyId: string | null, conversationId: string | null): ChatRun {
    this.sweep();
    const r = new ChatRun(owner, account, replyId, conversationId);
    this.runs.set(r.id, r);
    return r;
  }

  get(id: string, account: string): ChatRun | null {
    const r = this.runs.get(id);
    return r && r.account === account ? r : null;
  }

  /** Runs still working for this agent owner (counted as "running" so the phone keeps checking). */
  active(owner: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (!r.done && r.owner === owner) n++;
    return n;
  }

  anyActive(): boolean {
    for (const r of this.runs.values()) if (!r.done) return true;
    return false;
  }

  private sweep() {
    const now = Date.now();
    for (const [id, r] of this.runs) if (r.done && now - r.finishedAt > KEEP_DONE_MS) this.runs.delete(id);
  }
}

export const chatRuns = new ChatRunRegistry();
