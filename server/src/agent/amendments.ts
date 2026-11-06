/**
 * What the user says while work is still running, passed on to that work.
 *
 * The chat never locks: the user can keep writing while a reply builds, browses or waits on a card.
 * Each new message gets its own quick reply, and is also queued here for the work already running
 * in that chat (a chat reply, or the background task it became). The running loop takes the queue
 * at its next step (loop.ts `takeNotes`), so "make it blue too" changes the work under way instead
 * of starting a second copy of it.
 *
 * Keys: `run:<chat run id>` and `task:<task id>`. When a reply moves to a background task (or a
 * task carries on as its next part) its key is redirected, so notes still reach the work.
 * In memory: a server restart forgets notes that were not taken yet.
 */

export interface Amendment {
  text: string;
  at: number;
}

const MAX_QUEUED = 12;
const MAX_CHARS = 4000;
const KEEP_MS = 6 * 60 * 60_000;

export const runKey = (id: string) => `run:${id}`;
export const taskKey = (id: string) => `task:${id}`;

export class Amendments {
  private queues = new Map<string, Amendment[]>();
  private moved = new Map<string, { to: string; at: number }>();

  /** where notes for `key` go now (follows redirects) */
  resolve(key: string): string {
    let k = key;
    for (let i = 0; i < 20; i++) {
      const next = this.moved.get(k);
      if (!next) break;
      k = next.to;
    }
    return k;
  }

  /** Queues a note for the work behind `key`; returns the key it landed on. */
  add(key: string, text: string, now = Date.now()): string {
    this.sweep(now);
    const k = this.resolve(key);
    const clean = text.trim().slice(0, MAX_CHARS);
    if (!clean) return k;
    const q = this.queues.get(k) ?? [];
    q.push({ text: clean, at: now });
    if (q.length > MAX_QUEUED) q.splice(0, q.length - MAX_QUEUED);
    this.queues.set(k, q);
    return k;
  }

  /** Takes (and clears) the notes waiting for `key`, oldest first. */
  take(key: string): Amendment[] {
    const q = this.queues.get(key);
    if (!q?.length) return [];
    this.queues.delete(key);
    return q;
  }

  pending(key: string): number {
    return this.queues.get(key)?.length ?? 0;
  }

  /** The work behind `from` carries on as `to`: waiting notes move, and later ones follow. */
  redirect(from: string, to: string, now = Date.now()) {
    if (from === to) return;
    this.moved.set(from, { to, at: now });
    const q = this.queues.get(from);
    if (q?.length) {
      this.queues.delete(from);
      this.queues.set(to, [...(this.queues.get(to) ?? []), ...q].slice(-MAX_QUEUED));
    }
  }

  /** The work behind `key` ended: nothing more can reach it. */
  close(key: string) {
    this.queues.delete(key);
  }

  private sweep(now: number) {
    for (const [k, q] of this.queues) if (!q.length || now - q[q.length - 1]!.at > KEEP_MS) this.queues.delete(k);
    for (const [k, m] of this.moved) if (now - m.at > KEEP_MS * 4) this.moved.delete(k);
  }
}

export const amendments = new Amendments();

/**
 * How queued notes read to the running work: the user's own words, marked as sent mid-work, with
 * the rule that another reply already answered them in the chat (so the work does not greet or
 * repeat itself) and that unrelated messages change nothing.
 */
export function amendmentNote(notes: Amendment[]): string {
  const said = notes.map((n) => `"${n.text.replace(/\s+/g, ' ').trim()}"`).join('\n');
  return [
    `[While you were working on this, the user sent ${notes.length === 1 ? 'this message' : 'these messages'} in the chat. Another reply has already answered them there, so do not greet them or answer it twice.`,
    'If it changes, adds to, corrects or cancels part of THIS work, apply it now and mention it in your final answer. If it is about something else, ignore it and carry on.]',
    said,
  ].join('\n');
}
