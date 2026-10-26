import type { AgentStore, Task } from './store.js';

/**
 * One shared picture of the user's work for chat AND voice (task "Sesame-style UI", Oct 26).
 * A call and the text chat are the same conversation (same id, same history), and work started in
 * either one shows up here, so the user can start something by typing and ask about it on a call,
 * or the other way round. Kept free of I/O so it is easy to test.
 */

export interface ActiveReply {
  conversationId: string | null;
  topic: string;
  startedAt: number;
  step: string | null;
}

const DAY = 24 * 60 * 60 * 1000;

function ago(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60000));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h} h ago` : `${Math.round(h / 24)} d ago`;
}

function clip(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

function where(convOf: string | null | undefined, current: string | null): string {
  if (!convOf) return '';
  return current && convOf === current ? ' [started in THIS conversation]' : ' [started in another chat]';
}

function lastStep(t: Task): string | null {
  for (let i = t.events.length - 1; i >= 0; i--) {
    const e = t.events[i]!;
    if (e.text && e.type !== 'error') return clip(e.text, 90);
  }
  return null;
}

export function buildWorkContext(
  store: Pick<AgentStore, 'listTasks' | 'listPrompts'>,
  owner: string,
  o: { conversationId: string | null; mode: 'chat' | 'voice'; replies?: ActiveReply[]; now?: number },
): string {
  const now = o.now ?? Date.now();
  const conv = o.conversationId;
  const lines: string[] = [];

  for (const r of o.replies ?? []) {
    lines.push(`- Still working on a reply${where(r.conversationId, conv)}: "${clip(r.topic, 120)}", started ${ago(now - r.startedAt)}${r.step ? `; now: ${r.step}` : ''}.`);
  }

  const tasks = store.listTasks(owner, { limit: 30 });
  const running = tasks.filter((t) => t.status === 'queued' || t.status === 'running');
  const recent = tasks.filter((t) => (t.status === 'done' || t.status === 'failed' || t.status === 'cancelled') && now - (t.finishedAt ?? t.createdAt) < DAY);
  // this conversation's tasks first, then the rest
  const rank = (t: Task) => (conv && t.input.conversationId === conv ? 0 : 1);
  for (const t of [...running].sort((a, b) => rank(a) - rank(b)).slice(0, 6)) {
    const step = lastStep(t);
    lines.push(`- Background task ${t.status === 'queued' ? 'waiting to start' : 'RUNNING'}: "${clip(t.title, 100)}" (id ${t.id})${where(t.input.conversationId as string | undefined, conv)}, started ${ago(now - (t.startedAt ?? t.createdAt))}${step ? `; latest step: ${step}` : ''}.`);
  }
  for (const t of [...recent].sort((a, b) => rank(a) - rank(b)).slice(0, 5)) {
    const out = t.status === 'done' ? `result: ${clip(t.result ?? '', 260)}` : t.status === 'failed' ? `failed: ${clip(t.error ?? 'unknown error', 160)}` : 'cancelled';
    lines.push(`- Background task finished ${ago(now - (t.finishedAt ?? t.createdAt))}: "${clip(t.title, 100)}" (id ${t.id})${where(t.input.conversationId as string | undefined, conv)}; ${out}`);
  }

  const waiting = store.listPrompts(owner, 'pending', 10);
  for (const p of waiting.slice(0, 4)) {
    lines.push(`- Waiting on the user (${p.kind === 'approval' ? 'needs their OK' : p.kind === 'secret' ? 'needs a key or password in the secure field' : p.kind === 'step' ? 'needs them to do a step' : 'has a question'}): "${clip(p.title, 100)}". The card is on their screen.`);
  }

  const head = [
    '## Shared work and conversation (text chat and voice calls)',
    o.mode === 'voice'
      ? 'You are on a voice call that is part of the same conversation as the text chat: the earlier messages above include what the user typed and what you wrote, and what is said on this call is saved into that chat. Refer to earlier typed messages naturally; never say you cannot see the text chat.'
      : 'Some earlier turns in this conversation may have been spoken on a voice call (they are part of the history above); treat them like typed messages.',
  ];
  if (!lines.length) {
    return [...head, 'No background work is running or finished in the last day.'].join('\n');
  }
  return [
    ...head,
    'Work in progress and recent results (same list in chat and on calls):',
    ...lines,
    'When the user asks how something is going or what came of it, answer from this list (use task_status with the id for more detail). Do not start a second copy of work that is already running; continue or report on it instead. A result already given in another chat can be summarised here.',
  ].join('\n');
}
