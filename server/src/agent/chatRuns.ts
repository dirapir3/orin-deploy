import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import type { RunJournal } from './runJournal.js';

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
/** finished replies that did real work, kept for Activity after their events are swept */
const KEEP_RECENT = 8;
const KEEP_RECENT_MS = 24 * 60 * 60_000;

/**
 * A chat reply that used tools (built something, browsed, wrote files), in the same shape as a
 * background task, so Activity, Recent and the call bar list the work Orin does inside a chat.
 * Only real runs are listed: a reply that never called a tool is not work and is left out.
 */
export interface ReplyActivity {
  id: string;
  kind: 'reply';
  title: string;
  input: { prompt: string; conversationId: string | null; runId: string };
  status: 'running' | 'done' | 'failed' | 'cancelled';
  result: string | null;
  error: string | null;
  events: { t: number; type: string; text: string }[];
  scheduleId: null;
  createdAt: number;
  startedAt: number;
  finishedAt: number | null;
}

/** First line of what the user asked, cut at a word boundary: the row's title. */
export function replyTitle(topic: string): string {
  const one = topic.replace(/\s+/g, ' ').trim();
  if (!one) return 'Working on your request';
  if (one.length <= 70) return one;
  const cut = one.slice(0, 70);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > 40 ? cut.slice(0, sp) : cut).replace(/[\s,.;:!?-]+$/, '')}\u2026`;
}

export class ChatRun {
  readonly controller = new AbortController();
  readonly events: RunEvent[] = [];
  done = false;
  finishedAt = 0;
  /** true once a client has dropped off at least once */
  everDetached = false;
  /** what the user asked (short), and the step it is on: for the shared work picture */
  topic = '';
  step: string | null = null;
  /** tool steps taken (label + time), for Activity */
  readonly steps: { t: number; text: string }[] = [];
  /** set by the chat route just before it ends the run */
  outcome: { status: 'done' | 'failed' | 'cancelled'; result?: string; error?: string } | null = null;
  /** the work moved to a background task (that task is listed instead) */
  handedOff = false;
  /** ghost chats leave nothing behind, Activity included */
  incognito = false;
  /** put back from the journal after a server restart (runJournal.ts) */
  restored = false;
  /** journal hooks: every event and the end are written down (runJournal.ts) */
  journal: { emit: (e: RunEvent) => void; end: () => void } | null = null;
  private subs = new Set<(e: RunEvent | null) => void>();

  constructor(
    readonly owner: string,
    readonly account: string,
    readonly replyId: string | null,
    readonly conversationId: string | null,
    /** a run put back after a restart keeps its id, so the app can find it again */
    readonly id: string = randomUUID(),
    readonly createdAt: number = Date.now(),
  ) {}

  get attached(): boolean {
    return this.subs.size > 0;
  }

  /** a tool step started: shown as the row's current step */
  noteStep(label: string) {
    this.step = label;
    this.steps.push({ t: Date.now(), text: label });
    if (this.steps.length > 60) this.steps.splice(0, this.steps.length - 60);
  }

  /** this run as an Activity row, or null when it is not work worth listing */
  activity(): ReplyActivity | null {
    if (this.incognito || this.handedOff || !this.steps.length) return null;
    const status = this.done ? (this.outcome?.status ?? (this.controller.signal.aborted ? 'cancelled' : 'done')) : 'running';
    return {
      id: `reply:${this.id}`,
      kind: 'reply',
      title: replyTitle(this.topic),
      input: { prompt: this.topic, conversationId: this.conversationId, runId: this.id },
      status,
      result: this.done ? (this.outcome?.result ?? null)?.slice(0, 2000) ?? null : null,
      error: this.done ? (this.outcome?.error ?? null) : null,
      events: this.steps.map((x) => ({ t: x.t, type: 'tool', text: x.text })),
      scheduleId: null,
      createdAt: this.createdAt,
      startedAt: this.createdAt,
      finishedAt: this.done ? this.finishedAt : null,
    };
  }

  emit(event: string, data: unknown) {
    if (this.done) return;
    const e = { event, data };
    this.events.push(e);
    for (const s of this.subs) s(e);
    try {
      this.journal?.emit(e);
    } catch {
      // writing it down must never break a reply
    }
  }

  /** registry hook: runs once when the run ends */
  onEnd: (() => void) | null = null;

  end() {
    if (this.done) return;
    this.done = true;
    this.finishedAt = Date.now();
    try {
      this.onEnd?.();
    } catch {
      // Activity bookkeeping must never break a reply
    }
    try {
      this.journal?.end();
    } catch {
      // same
    }
    for (const s of this.subs) s(null);
    this.subs.clear();
  }

  /** Streams events after `after` to res, then live ones, until the run ends or res closes. */
  attach(res: Response, after = 0) {
    const write = (e: RunEvent) => res.write(`event: ${e.event}\ndata: ${JSON.stringify(e.data)}\n\n`);
    // the app saw more events than this run has (a run put back after a restart can be missing the
    // last few): it starts the reply over from the first event instead of skipping ahead
    if (after > this.events.length) {
      res.write('event: reset\ndata: {}\n\n');
      after = 0;
    }
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
  /** per owner: the last few finished replies that did work (newest first) */
  private recent = new Map<string, ReplyActivity[]>();
  /** writes runs down so they survive a server restart (set by the agent runtime) */
  journal: RunJournal | null = null;

  create(owner: string, account: string, replyId: string | null, conversationId: string | null): ChatRun {
    this.sweep();
    const r = new ChatRun(owner, account, replyId, conversationId);
    this.runs.set(r.id, r);
    // when it finishes, keep its Activity row after the full event log is swept
    r.onEnd = () => {
      const a = r.activity();
      if (!a) return;
      const list = (this.recent.get(owner) ?? []).filter((x) => x.id !== a.id);
      list.unshift(a);
      this.recent.set(owner, list.slice(0, KEEP_RECENT));
    };
    return r;
  }

  /**
   * Activity rows for this owner: replies working now, then the last few that finished
   * (in memory: a server restart forgets finished ones; background tasks are stored for good).
   */
  activity(owner: string): ReplyActivity[] {
    const out: ReplyActivity[] = [];
    const seen = new Set<string>();
    for (const r of this.runs.values()) {
      if (r.owner !== owner || r.done) continue;
      const a = r.activity();
      if (a) {
        out.push(a);
        seen.add(a.id);
      }
    }
    const now = Date.now();
    for (const a of this.recent.get(owner) ?? []) if (!seen.has(a.id) && now - (a.finishedAt ?? a.createdAt) < KEEP_RECENT_MS) out.push(a);
    return out.sort((x, y) => y.createdAt - x.createdAt);
  }

  get(id: string, account: string): ChatRun | null {
    const r = this.runs.get(id);
    if (r) return r.account === account ? r : null;
    // finished before a restart: replay it from the journal
    const saved = this.journal?.loadDone(id, account) ?? null;
    if (saved) this.runs.set(saved.id, saved);
    return saved;
  }

  /** A run put back after a restart (runJournal.ts). */
  adopt(run: ChatRun) {
    this.runs.set(run.id, run);
  }

  /**
   * The run to join when the same reply is sent again (the connection dropped before the app heard
   * back): one still working, or one that finished well (replayed, not run twice). A reply that
   * failed or was stopped is not joined: sending it again is a real retry.
   */
  sameReply(replyId: string, account: string): ChatRun | null {
    const live = this.byReply(replyId, account);
    if (live) return !live.done || live.handedOff || (live.outcome?.status ?? (live.controller.signal.aborted ? 'cancelled' : 'done')) === 'done' ? live : null;
    const saved = this.journal?.byReply(replyId, account);
    if (saved && ['done', 'handed_off', 'resumed'].includes(saved.status)) return this.get(saved.id, account);
    return null;
  }

  /** The newest run for this reply id in memory (the app lost the run id). */
  byReply(replyId: string, account: string): ChatRun | null {
    let best: ChatRun | null = null;
    for (const r of this.runs.values()) if (r.replyId === replyId && r.account === account && (!best || r.createdAt > best.createdAt)) best = r;
    return best;
  }

  /** Runs still working for this agent owner (counted as "running" so the phone keeps checking). */
  active(owner: string): number {
    let n = 0;
    for (const r of this.runs.values()) if (!r.done && r.owner === owner) n++;
    return n;
  }

  /** Replies still working for this owner, other than `except` (workContext.ts). */
  listActive(owner: string, except?: string): { conversationId: string | null; topic: string; startedAt: number; step: string | null }[] {
    const out: { conversationId: string | null; topic: string; startedAt: number; step: string | null }[] = [];
    for (const r of this.runs.values()) if (!r.done && r.owner === owner && r.id !== except) out.push({ conversationId: r.conversationId, topic: r.topic || 'a request', startedAt: r.createdAt, step: r.step });
    return out;
  }

  /** Runs of this owner in one chat (a ghost chat has no id: pass the run ids the app sent), newest first. */
  inConversation(owner: string, conversationId: string): ChatRun[] {
    const out: ChatRun[] = [];
    for (const r of this.runs.values()) if (r.owner === owner && r.conversationId === conversationId) out.push(r);
    return out.sort((a, b) => b.createdAt - a.createdAt);
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
