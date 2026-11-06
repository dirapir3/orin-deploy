import type { z } from 'zod';
import type { ChatMessageSchema } from '../schemas.js';
import { amendments, runKey } from './amendments.js';
import type { ChatRun, ChatRunRegistry } from './chatRuns.js';
import type { Task } from './store.js';

type ChatMessage = z.infer<typeof ChatMessageSchema>;

/**
 * A message sent while earlier work in the same chat is still running (the chat never locks).
 *
 * The new message gets its own reply straight away, and it is also passed to that running work
 * (agent/amendments.ts): a reply still working, or the background task a reply became. This
 * module decides where it goes and what the new reply is told, so it answers honestly ("passed
 * that on") and never starts a second copy of the same work.
 */

/** a reply that ended a moment ago, which the app may not have shown yet */
const JUST_FINISHED_MS = 3 * 60_000;

export interface Alongside {
  /** work the message was passed to */
  passedTo: { topic: string; kind: 'reply' | 'task'; taskId?: string }[];
  /** earlier replies in this chat that finished just before this message (with what they said) */
  justFinished: { topic: string; result: string }[];
}

/** The latest user turn as the running work should read it: their words, plus what they attached. */
export function saidText(messages: Pick<ChatMessage, 'role' | 'content' | 'images' | 'documents'>[]): string {
  const last = [...messages].reverse().find((m) => m.role === 'user');
  if (!last) return '';
  const extra: string[] = [];
  if (last.images?.length) extra.push(last.images.length === 1 ? 'an image' : `${last.images.length} images`);
  for (const d of last.documents ?? []) extra.push(`the file "${d.name}"`);
  const words = last.content.trim();
  if (!extra.length) return words;
  return `${words}${words ? ' ' : ''}(attached ${extra.join(', ')}; the reply in the chat can see it)`;
}

export function passAlong(o: {
  runs: Pick<ChatRunRegistry, 'get' | 'inConversation'>;
  store: { getTaskById(id: string): Task | null };
  owner: string;
  account: string;
  /** the new reply (never passed to itself) */
  run: ChatRun;
  conversationId: string | null;
  incognito: boolean;
  /** run ids the app says are still working in this chat */
  alongside?: string[];
  said: string;
  now?: number;
}): Alongside {
  const now = o.now ?? Date.now();
  const out: Alongside = { passedTo: [], justFinished: [] };
  if (!o.said.trim()) return out;
  const candidates = new Map<string, { r: ChatRun; named: boolean }>();
  for (const id of o.alongside ?? []) {
    const r = o.runs.get(id, o.account);
    // same agent, same chat (a ghost chat only ever reaches ghost replies the app named)
    if (!r || r.id === o.run.id || r.owner !== o.owner) continue;
    if (r.incognito !== o.incognito || r.conversationId !== o.conversationId) continue;
    candidates.set(r.id, { r, named: true });
  }
  // another tab or device writing in the same chat reaches the same work
  if (o.conversationId && !o.incognito) {
    for (const r of o.runs.inConversation(o.owner, o.conversationId)) {
      if (r.id === o.run.id || r.incognito || candidates.has(r.id)) continue;
      if (!r.done || r.handedOff) candidates.set(r.id, { r, named: false });
    }
  }
  const seenTasks = new Set<string>();
  for (const { r, named } of candidates.values()) {
    const topic = r.topic || 'your earlier request';
    if (!r.done) {
      const key = amendments.add(runKey(r.id), o.said, now);
      if (key.startsWith('task:')) {
        const taskId = key.slice(5);
        if (!seenTasks.has(taskId)) out.passedTo.push({ topic, kind: 'task', taskId });
        seenTasks.add(taskId);
      } else out.passedTo.push({ topic, kind: 'reply' });
      continue;
    }
    if (r.handedOff) {
      const key = amendments.resolve(runKey(r.id));
      if (!key.startsWith('task:')) continue;
      const taskId = key.slice(5);
      const task = o.store.getTaskById(taskId);
      if (!task || (task.status !== 'running' && task.status !== 'queued') || seenTasks.has(taskId)) continue;
      amendments.add(key, o.said, now);
      seenTasks.add(taskId);
      out.passedTo.push({ topic: task.title || topic, kind: 'task', taskId });
      continue;
    }
    if (named && r.outcome?.status === 'done' && r.outcome.result && now - r.finishedAt < JUST_FINISHED_MS) {
      out.justFinished.push({ topic, result: r.outcome.result });
    }
  }
  return out;
}

const clip = (s: string, n: number) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > n ? `${one.slice(0, n - 1)}\u2026` : one;
};

/** What the new reply is told about the work it answers alongside, or undefined when there is none. */
export function alongsideContext(a: Alongside): string | undefined {
  if (!a.passedTo.length && !a.justFinished.length) return undefined;
  const lines = ['## Work still running in this chat'];
  for (const p of a.passedTo) {
    lines.push(
      p.kind === 'task'
        ? `- The background task "${clip(p.topic, 120)}" (id ${p.taskId}) is still working on an earlier request from this chat. The user's newest message was passed to it, so it takes the message into account at its next step and posts its own result here.`
        : `- You are still working on the earlier request "${clip(p.topic, 120)}" in this chat (in another reply). The user's newest message was passed to that work, so it takes the message into account at its next step and posts its own result here.`,
    );
  }
  for (const f of a.justFinished) {
    lines.push(`- Your reply to "${clip(f.topic, 100)}" in this chat finished a moment ago and may not be on the user's screen yet. It said: "${clip(f.result, 400)}"`);
  }
  if (a.passedTo.length) {
    lines.push(
      'Answer the newest message on its own, briefly. If it changes or adds to that work, say in a few words that it will be included (it has been passed on). If it is a question or a chat, just answer it; for progress, say what that work is doing now. Do not start that work again, do not do its steps here, and do not say it is finished. If the user asks to stop it, tell them the Stop button stops a reply, and a background task has Cancel on its page in Activity. Do something here only when the message is clearly a separate request.',
    );
  }
  return lines.join('\n');
}
