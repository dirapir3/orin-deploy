import { Router, type Request } from 'express';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { requesterKey } from '../middleware/auth.js';
import { parseBody } from './util.js';

/**
 * Chat history across devices. The app's local database stays the source of truth on each device; signed-in
 * devices push their chats here and pull the other devices' chats, so the side-menu search (and the chat
 * list) covers every device. One small file per workspace, kept under a size cap (oldest chats drop off
 * first) so durable storage stays within the free tier: about one 600 KB chunk per account.
 * Ghost (temporary) chats are never sent. Message text only: images and document text stay on the device.
 */

export const MAX_CHAT_FILE = 560_000; // under one durable chunk (~600 KB) after JSON
export const MAX_MSG_CHARS = 6000;
const MAX_TOMBSTONES = 2000;

export interface SyncConv {
  id: string;
  title: string;
  titleSource?: string;
  pinned?: boolean;
  agent?: string;
  createdAt: number;
  updatedAt: number;
  lastMessageAt: number;
}
export interface SyncMsg {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  status?: string;
  model?: string | null;
  createdAt: number;
  updatedAt: number;
  /** when this server copy last changed (for pulls) */
  at?: number;
}
interface ChatFile {
  v: 1;
  convs: Record<string, SyncConv & { at: number }>;
  msgs: Record<string, SyncMsg & { at: number }>;
  /** id -> { kind, at } */
  gone: Record<string, { kind: 'conversation' | 'message'; at: number }>;
}

const Conv = z.object({
  id: z.string().min(1).max(100),
  title: z.string().max(300).default(''),
  titleSource: z.string().max(20).optional(),
  pinned: z.boolean().optional(),
  agent: z.string().max(20).optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  lastMessageAt: z.number(),
});
const Msg = z.object({
  id: z.string().min(1).max(100),
  conversationId: z.string().min(1).max(100),
  role: z.enum(['user', 'assistant', 'system']),
  content: z.string().max(200_000),
  status: z.string().max(20).optional(),
  model: z.string().max(100).nullable().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
const SyncBody = z.object({
  conversations: z.array(Conv).max(500).default([]),
  messages: z.array(Msg).max(3000).default([]),
  deletions: z.array(z.object({ id: z.string().min(1).max(100), kind: z.enum(['conversation', 'message']) })).max(2000).default([]),
  /** server time of the last pull this device made (0 = everything) */
  since: z.number().default(0),
});

export function chatFilePath(dataDir: string, owner: string, testRun = ''): string {
  const root = dataDir === ':memory:' ? join(tmpdir(), `orin-chats-test-${process.pid}-${testRun}`) : join(dataDir, 'chats');
  return join(root, `${createHash('sha256').update(`chats:${owner}`).digest('hex').slice(0, 24)}.json`);
}

function load(path: string): ChatFile {
  try {
    if (existsSync(path)) {
      const j = JSON.parse(readFileSync(path, 'utf8')) as ChatFile;
      if (j && j.v === 1) return { v: 1, convs: j.convs ?? {}, msgs: j.msgs ?? {}, gone: j.gone ?? {} };
    }
  } catch {
    /* a broken file starts over; the devices still hold their chats and push them again */
  }
  return { v: 1, convs: {}, msgs: {}, gone: {} };
}

function save(path: string, f: ChatFile) {
  mkdirSync(join(path, '..'), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(f));
  renameSync(tmp, path);
}

/** Drops the chats with the oldest last message until the file fits under the cap. */
export function fitCap(f: ChatFile, cap = MAX_CHAT_FILE): number {
  let size = Buffer.byteLength(JSON.stringify(f));
  if (size <= cap) return 0;
  const byConv = new Map<string, string[]>();
  for (const m of Object.values(f.msgs)) byConv.set(m.conversationId, [...(byConv.get(m.conversationId) ?? []), m.id]);
  const order = Object.values(f.convs).sort((a, b) => a.lastMessageAt - b.lastMessageAt);
  let dropped = 0;
  for (const c of order) {
    if (size <= cap) break;
    if (c.pinned && order.some((o) => !o.pinned && f.convs[o.id])) continue; // pinned chats go last
    for (const id of byConv.get(c.id) ?? []) delete f.msgs[id];
    delete f.convs[c.id];
    dropped++;
    size = Buffer.byteLength(JSON.stringify(f));
  }
  // still too big (pinned only, or messages without a chat): drop the oldest messages
  if (size > cap) {
    for (const m of Object.values(f.msgs).sort((a, b) => a.createdAt - b.createdAt)) {
      if (size <= cap) break;
      delete f.msgs[m.id];
      size -= Buffer.byteLength(JSON.stringify(m)) + 2;
    }
  }
  return dropped;
}

export function mergeSync(f: ChatFile, body: z.infer<typeof SyncBody>, now: number) {
  for (const d of body.deletions) {
    f.gone[d.id] = { kind: d.kind, at: now };
    if (d.kind === 'conversation') {
      delete f.convs[d.id];
      for (const m of Object.values(f.msgs)) if (m.conversationId === d.id) delete f.msgs[m.id];
    } else delete f.msgs[d.id];
  }
  for (const c of body.conversations) {
    if (f.gone[c.id]?.kind === 'conversation') continue; // deleted on another device: stays deleted
    const have = f.convs[c.id];
    if (have && have.updatedAt > c.updatedAt) continue;
    f.convs[c.id] = { ...c, title: c.title.slice(0, 120), at: now };
  }
  for (const m of body.messages) {
    if (f.gone[m.id] || f.gone[m.conversationId]?.kind === 'conversation') continue;
    if (m.content.length === 0 && m.role !== 'user') continue;
    const have = f.msgs[m.id];
    if (have && have.updatedAt > m.updatedAt) continue;
    f.msgs[m.id] = { ...m, content: m.content.slice(0, MAX_MSG_CHARS), at: now };
  }
  // tombstones: keep the newest
  const ids = Object.keys(f.gone);
  if (ids.length > MAX_TOMBSTONES) for (const id of ids.sort((a, b) => f.gone[a]!.at - f.gone[b]!.at).slice(0, ids.length - MAX_TOMBSTONES)) delete f.gone[id];
  return fitCap(f);
}

export function changesSince(f: ChatFile, since: number) {
  const conversations = Object.values(f.convs).filter((c) => c.at > since);
  const messages = Object.values(f.msgs).filter((m) => m.at > since);
  const deletions = Object.entries(f.gone)
    .filter(([, g]) => g.at > since)
    .map(([id, g]) => ({ id, kind: g.kind }));
  return { conversations, messages, deletions };
}

/** Finds words in every synced chat; newest first, one line of where it matched. */
export function searchChats(f: ChatFile, q: string, limit = 30) {
  const words = q.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 8);
  if (!words.length) return [];
  const hits = new Map<string, { conversationId: string; title: string; agent?: string; lastMessageAt: number; snippet: string; messageId?: string }>();
  const snip = (text: string, w: string) => {
    const i = text.toLowerCase().indexOf(w);
    const s = Math.max(0, i - 50);
    return `${s > 0 ? '…' : ''}${text.slice(s, i + w.length + 70).replace(/\s+/g, ' ').trim()}${i + w.length + 70 < text.length ? '…' : ''}`;
  };
  for (const c of Object.values(f.convs)) {
    const t = c.title.toLowerCase();
    if (words.every((w) => t.includes(w))) hits.set(c.id, { conversationId: c.id, title: c.title, agent: c.agent, lastMessageAt: c.lastMessageAt, snippet: '' });
  }
  for (const m of Object.values(f.msgs).sort((a, b) => b.createdAt - a.createdAt)) {
    const c = f.convs[m.conversationId];
    if (!c || (hits.get(c.id)?.snippet ?? '') !== '') continue;
    const text = m.content.toLowerCase();
    if (!words.every((w) => text.includes(w))) continue;
    hits.set(c.id, { conversationId: c.id, title: c.title, agent: c.agent, lastMessageAt: c.lastMessageAt, snippet: snip(m.content, words[0]!), messageId: m.id });
  }
  return [...hits.values()].sort((a, b) => b.lastMessageAt - a.lastMessageAt).slice(0, limit);
}

export function chatSyncRouter(deps: Deps): Router {
  const r = Router();
  const dataDir = deps.agent!.services.config.agent.dataDir;
  const run = randomUUID().slice(0, 8); // in-memory test apps each get their own folder
  const file = (req: Request) => chatFilePath(dataDir, requesterKey(req), run);
  // one write at a time per file (requests for one workspace can overlap)
  const queues = new Map<string, Promise<unknown>>();
  const serial = <T>(key: string, fn: () => T): Promise<T> => {
    const p = (queues.get(key) ?? Promise.resolve()).then(fn, fn);
    queues.set(
      key,
      p.catch(() => undefined),
    );
    return p;
  };

  r.post('/agent/chats/sync', async (req, res, next) => {
    try {
      const body = parseBody(SyncBody, req.body);
      const path = file(req);
      const out = await serial(path, () => {
        const f = load(path);
        const now = Date.now();
        const changed = body.conversations.length + body.messages.length + body.deletions.length > 0;
        const dropped = changed ? mergeSync(f, body, now) : 0;
        if (changed) save(path, f);
        return { ...changesSince(f, body.since), now, dropped, stored: { conversations: Object.keys(f.convs).length, messages: Object.keys(f.msgs).length } };
      });
      res.json(out);
    } catch (e) {
      next(e);
    }
  });

  r.get('/agent/chats/search', (req, res) => {
    const q = String(req.query.q ?? '').slice(0, 200);
    const f = load(file(req));
    res.json({ results: searchChats(f, q) });
  });

  r.get('/agent/chats/:id', (req, res) => {
    const f = load(file(req));
    const c = f.convs[String(req.params.id)];
    if (!c) return res.status(404).json({ error: { code: 'not_found', message: 'That chat is not saved on the server.' } });
    res.json({ conversation: c, messages: Object.values(f.msgs).filter((m) => m.conversationId === c.id).sort((a, b) => a.createdAt - b.createdAt) });
  });

  /** Sign out / wipe: forget this workspace's synced chats. */
  r.delete('/agent/chats', (req, res) => {
    const path = file(req);
    rmSync(path, { force: true });
    res.json({ ok: true });
  });

  return r;
}
