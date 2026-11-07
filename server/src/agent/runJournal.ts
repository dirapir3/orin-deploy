import type { DatabaseSync } from 'node:sqlite';
import type { ProviderMessage } from '../ai/types.js';
import { logger } from '../logger.js';
import { amendments, runKey } from './amendments.js';
import { ChatRun, replyTitle, type RunEvent } from './chatRuns.js';
import { compactTranscript } from './runtime.js';

/**
 * Chat replies that survive the server, not only the connection.
 *
 * chatRuns.ts keeps a reply working when the phone drops off, but only in memory: a redeploy, a
 * crash or Render putting the server to sleep used to lose the run, its event log and everything
 * it had done, and "Try again" then started the whole job over. The journal writes each run to
 * SQLite (mirrored to Firestore by durable/sync.ts) as it goes: its events, so the app can come
 * back to the same run id after a restart, and its transcript after every tool step, so the work
 * can go on from the last step that finished instead of from the beginning.
 *
 * After a restart the runs that were still working are put back (same id, same events) and, after
 * a short wait for the old server instance to stop, carried on as a background task from their
 * last checkpoint. Tool calls that had started but not finished are named to the model as
 * "outcome unknown", so nothing with an outside effect is repeated blindly, and approvals the old
 * run was waiting on are closed, so the work asks again instead of acting on a stale card.
 * Ghost (incognito) chats are never written down.
 */

export type JournalStatus = 'running' | 'done' | 'failed' | 'cancelled' | 'handed_off' | 'resumed';

export interface JournalMeta {
  mode?: string;
  character?: string;
  timezone?: string;
  /** how many times a restart or a Try again has carried this run on */
  restarts?: number;
  error?: string;
}

interface Row {
  id: string;
  owner: string;
  account: string;
  reply_id: string | null;
  conversation_id: string | null;
  status: JournalStatus;
  topic: string;
  meta: string;
  events: string;
  transcript: string | null;
  steps: number;
  created_at: number;
  updated_at: number;
}

/** what the app is told about a run it asks for by its reply id */
export interface RunInfo {
  id: string;
  status: JournalStatus;
  done: boolean;
  /** finished with an error after real work: Try again can carry it on instead of starting over */
  resumable: boolean;
  steps: number;
  events: number;
}

const DELTA_SAVE_MS = 2_000;
const MAX_EVENTS = 6_000;
const MAX_EVENT_JSON = 20_000;
/** finished runs are kept this long (the app can still replay them after a restart) */
const KEEP_MS = 24 * 60 * 60_000;
/** a run older than this when the server comes back is not carried on (the user has moved on) */
const RECOVER_MAX_AGE_MS = 3 * 60 * 60_000;
const MAX_RESTARTS = 3;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS chat_runs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, account TEXT NOT NULL, reply_id TEXT, conversation_id TEXT, status TEXT NOT NULL, topic TEXT NOT NULL DEFAULT '', meta TEXT NOT NULL DEFAULT '{}', events TEXT NOT NULL DEFAULT '[]', transcript TEXT, steps INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS chat_runs_reply ON chat_runs (reply_id);
CREATE INDEX IF NOT EXISTS chat_runs_status ON chat_runs (status);
`;

/** an event as it is written down: big tool displays are left out (the app has them already) */
function storable(e: RunEvent): RunEvent {
  const json = JSON.stringify(e.data ?? null);
  if (json.length <= MAX_EVENT_JSON) return e;
  if (e.data && typeof e.data === 'object') {
    const d = { ...(e.data as Record<string, unknown>) };
    delete d.display;
    for (const k of Object.keys(d)) if (typeof d[k] === 'string' && (d[k] as string).length > 4000) d[k] = `${(d[k] as string).slice(0, 4000)}\u2026`;
    return { event: e.event, data: d };
  }
  return { event: e.event, data: null };
}

/** Tool calls the events show as started but never finished: their outcome is unknown. */
export function unfinishedTools(events: RunEvent[]): { id: string; name: string; label: string }[] {
  const open = new Map<string, { id: string; name: string; label: string }>();
  for (const e of events) {
    if (e.event !== 'tool' || !e.data || typeof e.data !== 'object') continue;
    const d = e.data as { phase?: string; id?: string; name?: string; label?: string };
    if (!d.id) continue;
    if (d.phase === 'start') open.set(d.id, { id: d.id, name: d.name ?? 'tool', label: d.label || (d.name ?? 'tool').replace(/_/g, ' ') });
    else if (d.phase === 'end') open.delete(d.id);
  }
  return [...open.values()];
}

/** The note the carried-on work starts from: what happened, and what not to repeat. */
export function resumeNote(why: 'restart' | 'error', o: { unfinished: { name: string; label: string }[]; error?: string }): string {
  const lines = [
    '[Note from the Orin system, not from the user]',
    why === 'restart'
      ? 'The server restarted while you were working on this request, so the run above was cut off. Carry on from where it stopped: the tool results above are steps that finished, do not redo them.'
      : `The run above stopped with an error${o.error ? ` ("${o.error.slice(0, 300)}")` : ''}. The user asked to try again: carry on from where it stopped, the tool results above are steps that finished, do not redo them.`,
  ];
  if (o.unfinished.length) {
    lines.push(
      `These steps had started but their result was never recorded, so they may or may not have happened: ${o.unfinished.map((t) => `${t.label} (${t.name})`).join('; ')}. Check the real state first (files, the page, the sandbox, sent items, the vault) before doing any of them again, and never repeat a send, a purchase, a booking, a post or a deletion that may already have gone through. If you cannot tell, say so in the result instead of repeating it.`,
    );
  }
  lines.push(
    'Your computer may have been reset in between: files you saved to the workspace come back, anything else may need setting up again. Any approval or answer you were waiting for was not given: ask again if you still need it.',
  );
  return lines.join('\n');
}

export class RunJournal {
  private tracked = new Map<string, { run: ChatRun; meta: JournalMeta; timer: ReturnType<typeof setTimeout> | null; transcript: string | null; steps: number }>();

  constructor(private db: DatabaseSync) {
    db.exec(SCHEMA);
    try {
      const now = Date.now();
      db.prepare("DELETE FROM chat_runs WHERE updated_at < ? AND status != 'running'").run(now - KEEP_MS);
      db.prepare("DELETE FROM chat_runs WHERE status = 'running' AND updated_at < ?").run(now - KEEP_MS);
    } catch (err) {
      logger.warn('could not tidy saved chat runs', { err: String(err) });
    }
  }

  /** Starts writing this run down (not for ghost chats). */
  track(run: ChatRun, meta: JournalMeta) {
    if (run.incognito || this.tracked.has(run.id)) return;
    const now = Date.now();
    this.db
      .prepare('INSERT OR REPLACE INTO chat_runs (id, owner, account, reply_id, conversation_id, status, topic, meta, events, transcript, steps, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(run.id, run.owner, run.account, run.replyId, run.conversationId, 'running', run.topic.slice(0, 400), JSON.stringify(meta), '[]', null, 0, run.createdAt, now);
    const t = { run, meta, timer: null as ReturnType<typeof setTimeout> | null, transcript: null as string | null, steps: 0 };
    this.tracked.set(run.id, t);
    run.journal = {
      emit: (e) => {
        if (e.event === 'delta' || e.event === 'interim') {
          t.timer ??= setTimeout(() => {
            t.timer = null;
            this.save(run.id);
          }, DELTA_SAVE_MS);
          t.timer.unref?.();
        } else this.save(run.id);
      },
      end: () => this.finish(run.id),
    };
  }

  /** After each tool step (and once at the start): the transcript the work can go on from. */
  checkpoint(run: ChatRun, messages: ProviderMessage[], steps = 0) {
    const t = this.tracked.get(run.id);
    if (!t) return;
    try {
      const body = messages.filter((m, i) => !(i === 0 && m.role === 'system'));
      t.transcript = JSON.stringify(compactTranscript(body));
      t.steps = steps;
      this.save(run.id);
    } catch (err) {
      logger.warn('could not save a chat checkpoint', { err: String(err) });
    }
  }

  /** Writes everything still running now (server shutting down). */
  flushAll() {
    for (const id of this.tracked.keys()) this.save(id);
  }

  private save(id: string, status?: JournalStatus) {
    const t = this.tracked.get(id);
    if (!t) return;
    if (t.timer && status) {
      clearTimeout(t.timer);
      t.timer = null;
    }
    try {
      const events = t.run.events.length > MAX_EVENTS ? t.run.events.slice(0, MAX_EVENTS) : t.run.events;
      this.db
        .prepare('UPDATE chat_runs SET status = ?, events = ?, transcript = COALESCE(?, transcript), steps = ?, meta = ?, topic = ?, updated_at = ? WHERE id = ?')
        .run(status ?? 'running', JSON.stringify(events.map(storable)), t.transcript, t.steps, JSON.stringify(t.meta), t.run.topic.slice(0, 400), Date.now(), id);
    } catch (err) {
      logger.warn('could not save a chat run', { err: String(err) });
    }
  }

  private finish(id: string) {
    const t = this.tracked.get(id);
    if (!t) return;
    const r = t.run;
    const status: JournalStatus = r.handedOff ? 'handed_off' : (r.outcome?.status ?? (r.controller.signal.aborted ? 'cancelled' : 'done'));
    if (r.outcome?.error) t.meta.error = r.outcome.error.slice(0, 500);
    // the transcript is only needed again by a run that failed (Try again carries it on)
    if (status !== 'failed') t.transcript = null;
    this.save(id, status);
    if (status !== 'failed') {
      try {
        this.db.prepare('UPDATE chat_runs SET transcript = NULL WHERE id = ?').run(id);
      } catch {
        // only space
      }
    }
    this.tracked.delete(id);
  }

  private row(id: string, account?: string): Row | null {
    const r = this.db.prepare('SELECT * FROM chat_runs WHERE id = ?').get(id) as Row | undefined;
    if (!r || (account !== undefined && r.account !== account)) return null;
    return r;
  }

  private toRun(r: Row): ChatRun {
    const run = new ChatRun(r.owner, r.account, r.reply_id, r.conversation_id, r.id, r.created_at);
    run.topic = r.topic;
    run.restored = true;
    try {
      for (const e of JSON.parse(r.events) as RunEvent[]) run.events.push(e);
    } catch {
      // a broken log replays as empty; the reply itself is in the inbox or the app
    }
    return run;
  }

  /** A finished run from before a restart, so the app can still replay it (null when unknown). */
  loadDone(id: string, account: string): ChatRun | null {
    const r = this.row(id, account);
    if (!r || r.status === 'running') return null;
    const run = this.toRun(r);
    run.handedOff = r.status === 'handed_off' || r.status === 'resumed';
    run.outcome = r.status === 'failed' ? { status: 'failed', error: (JSON.parse(r.meta) as JournalMeta).error } : r.status === 'cancelled' ? { status: 'cancelled' } : { status: 'done' };
    run.done = true;
    run.finishedAt = r.updated_at;
    return run;
  }

  /** The newest run written for this reply id (any status). */
  byReply(replyId: string, account: string): RunInfo | null {
    const r = this.db.prepare('SELECT id, status, steps, events, transcript, created_at FROM chat_runs WHERE reply_id = ? AND account = ? ORDER BY created_at DESC LIMIT 1').get(replyId, account) as Pick<Row, 'id' | 'status' | 'steps' | 'events' | 'transcript'> | undefined;
    if (!r) return null;
    let events = 0;
    try {
      events = (JSON.parse(r.events) as unknown[]).length;
    } catch {
      events = 0;
    }
    return { id: r.id, status: r.status, done: r.status !== 'running', resumable: r.status === 'failed' && Boolean(r.transcript) && r.steps > 0, steps: r.steps, events };
  }

  /** Runs that were working when the server stopped, put back with their ids and events. */
  interrupted(): ChatRun[] {
    const rows = this.db.prepare("SELECT * FROM chat_runs WHERE status = 'running' ORDER BY created_at").all() as unknown as Row[];
    return rows.filter((r) => !this.tracked.has(r.id)).map((r) => this.toRun(r));
  }

  /** The saved transcript + meta of a run, for carrying it on. */
  resumeData(id: string): { transcript: ProviderMessage[] | null; meta: JournalMeta; status: JournalStatus; updatedAt: number; steps: number } | null {
    const r = this.row(id);
    if (!r) return null;
    let transcript: ProviderMessage[] | null = null;
    try {
      transcript = r.transcript ? (JSON.parse(r.transcript) as ProviderMessage[]) : null;
    } catch {
      transcript = null;
    }
    let meta: JournalMeta = {};
    try {
      meta = JSON.parse(r.meta) as JournalMeta;
    } catch {
      meta = {};
    }
    return { transcript, meta, status: r.status, updatedAt: r.updated_at, steps: r.steps };
  }

  /** Closes a run from the outside (recovery), with its final events. */
  close(run: ChatRun, status: JournalStatus, meta?: JournalMeta) {
    try {
      this.db
        .prepare('UPDATE chat_runs SET status = ?, events = ?, transcript = CASE WHEN ? THEN transcript ELSE NULL END, meta = COALESCE(?, meta), updated_at = ? WHERE id = ?')
        .run(status, JSON.stringify(run.events.slice(0, MAX_EVENTS).map(storable)), status === 'failed' ? 1 : 0, meta ? JSON.stringify(meta) : null, Date.now(), run.id);
    } catch (err) {
      logger.warn('could not close a saved chat run', { err: String(err) });
    }
  }
}

/** What a recovery needs from the agent runtime (kept narrow so tests can stand in for it). */
export interface RecoveryHost {
  continueInBackground(owner: string, o: { title: string; prompt: string; messages: ProviderMessage[]; conversationId?: string | null; timezone?: string; from?: string }): string | null;
  closePromptsFor(linkId: string): number;
  deliverReply(owner: string, conversationId: string, replyId: string | null, text: string): void;
}

export const RESUMED_LINE = "The server restarted while I was working on this, so I picked it back up from the last step that finished. I'm finishing it in the background and I'll post the result here, you don't need to ask again.";
export const RETRY_LINE = "Picking this back up from the last step that finished instead of starting over. I'm finishing it in the background and I'll post the result here.";
const GAVE_UP_LINE = "The server restarted while I was working on this and I couldn't pick it back up. Ask me again and I'll start it over.";

/**
 * Carries one interrupted run on as a background task from its last checkpoint and closes the
 * run with a line saying so (the app shows it in the same reply; the task posts the result).
 * Returns the line, or null when the run could not be carried on.
 */
export function carryOn(journal: RunJournal, host: RecoveryHost, run: ChatRun, why: 'restart' | 'error'): string | null {
  const data = journal.resumeData(run.id);
  const meta: JournalMeta = { ...(data?.meta ?? {}) };
  meta.restarts = (meta.restarts ?? 0) + 1;
  // a card the old run was waiting on can never be answered now: close it, the work asks again
  try {
    host.closePromptsFor(`reply:${run.id}`);
  } catch {
    // nothing to close
  }
  let line: string | null = null;
  if (data?.transcript?.length && meta.restarts <= MAX_RESTARTS && Date.now() - (data.updatedAt || run.createdAt) < RECOVER_MAX_AGE_MS) {
    const note = resumeNote(why, { unfinished: unfinishedTools(run.events), error: meta.error });
    try {
      line = host.continueInBackground(run.owner, {
        title: replyTitle(run.topic),
        prompt: run.topic || 'Carry on with the request above',
        messages: [...data.transcript, { role: 'user', content: note }],
        conversationId: run.conversationId,
        ...(meta.timezone ? { timezone: meta.timezone } : {}),
        from: runKey(run.id),
      })
        ? why === 'restart'
          ? RESUMED_LINE
          : RETRY_LINE
        : null;
    } catch (err) {
      logger.warn('could not carry on an interrupted chat run', { err: String(err) });
      line = null;
    }
  }
  if (why === 'error') {
    // Try again on a failed run: nothing changes when it cannot be carried on (the app starts over)
    if (!line) return null;
    journal.close(run, 'resumed', meta);
    return line;
  }
  const text = line ?? GAVE_UP_LINE;
  run.emit('delta', { text: (run.events.some((e) => e.event === 'delta') ? '\n\n' : '') + text });
  run.emit('done', { finishReason: 'stop', usage: {}, demo: false, steps: 0, toolCalls: 0, reply: text, resumed: Boolean(line) });
  run.handedOff = Boolean(line);
  run.outcome = line ? { status: 'done', result: text } : { status: 'failed', error: text };
  if (!run.attached && run.conversationId) {
    try {
      host.deliverReply(run.owner, run.conversationId, run.replyId, text);
    } catch (err) {
      logger.warn('could not save a resumed reply for later', { err: String(err) });
    }
  }
  if (!line) amendments.close(runKey(run.id));
  run.end();
  journal.close(run, line ? 'resumed' : 'failed', meta);
  return line;
}
