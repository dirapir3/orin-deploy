import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/**
 * Server-side agent state in one SQLite file (Node's built-in node:sqlite, no native build step):
 * memories, notes, reminders, background tasks, schedules, skills, conversation summaries and
 * connector tokens. Every row belongs to an owner: `u:<supabase user id>` or `g:<guest id>`.
 */

export interface Memory {
  id: string;
  owner: string;
  text: string;
  tags: string;
  createdAt: number;
  updatedAt: number;
}
export interface Note {
  id: string;
  owner: string;
  title: string;
  body: string;
  source: string;
  createdAt: number;
  updatedAt: number;
}
export interface Reminder {
  id: string;
  owner: string;
  text: string;
  dueAt: number;
  status: 'scheduled' | 'done' | 'cancelled';
  createdAt: number;
}
export type TaskStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
export type TaskKind = 'agent' | 'deep_research' | 'skill';
export interface TaskEvent {
  t: number;
  type: string;
  text: string;
}
export interface Task {
  id: string;
  owner: string;
  kind: TaskKind;
  title: string;
  input: Record<string, unknown>;
  status: TaskStatus;
  result: string | null;
  error: string | null;
  events: TaskEvent[];
  noteId: string | null;
  scheduleId: string | null;
  acked: boolean;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
}
export interface Schedule {
  id: string;
  owner: string;
  title: string;
  prompt: string;
  skillId: string | null;
  cron: string | null;
  intervalSec: number | null;
  timezone: string;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt: number | null;
  lastTaskId: string | null;
  createdAt: number;
}
export interface Skill {
  id: string;
  owner: string;
  name: string;
  description: string;
  instructions: string;
  createdAt: number;
  updatedAt: number;
}
export interface VaultRow {
  id: string;
  owner: string;
  name: string;
  domain: string;
  usernameEnc: string;
  passwordEnc: string;
  notesEnc: string;
  createdAt: number;
  updatedAt: number;
}
export type PromptKind = 'approval' | 'question' | 'secret' | 'step';
/** extra card details kept with a prompt (JSON column meta) */
export interface PromptMeta {
  headline?: string;
  content?: string;
  url?: string;
  secret?: { name: string; domain: string; what: 'login' | 'password' | 'api_key' };
}
export type PromptStatus = 'pending' | 'answered' | 'expired' | 'cancelled';
export interface PromptRec {
  id: string;
  owner: string;
  kind: PromptKind;
  title: string;
  body: string;
  fields: { label: string; value: string }[];
  choices: string[];
  headline: string | null;
  content: string | null;
  url: string | null;
  secret: PromptMeta['secret'] | null;
  taskId: string | null;
  tool: string | null;
  status: PromptStatus;
  decision: string | null;
  answer: string | null;
  createdAt: number;
  answeredAt: number | null;
  expiresAt: number;
}
export interface InboxItem {
  id: string;
  owner: string;
  kind: string;
  title: string;
  text: string;
  refId: string | null;
  createdAt: number;
}
export interface Connection {
  owner: string;
  provider: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
  email: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, tags TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS memories_owner ON memories(owner, updated_at);
CREATE TABLE IF NOT EXISTS notes (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'chat', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS notes_owner ON notes(owner, updated_at);
CREATE TABLE IF NOT EXISTS reminders (id TEXT PRIMARY KEY, owner TEXT NOT NULL, text TEXT NOT NULL, due_at INTEGER NOT NULL, status TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS reminders_owner ON reminders(owner, due_at);
CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, input TEXT NOT NULL, status TEXT NOT NULL, result TEXT, error TEXT, events TEXT NOT NULL DEFAULT '[]', note_id TEXT, schedule_id TEXT, acked INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, started_at INTEGER, finished_at INTEGER);
CREATE INDEX IF NOT EXISTS tasks_owner ON tasks(owner, created_at);
CREATE INDEX IF NOT EXISTS tasks_status ON tasks(status, created_at);
CREATE TABLE IF NOT EXISTS schedules (id TEXT PRIMARY KEY, owner TEXT NOT NULL, title TEXT NOT NULL, prompt TEXT NOT NULL, skill_id TEXT, cron TEXT, interval_sec INTEGER, timezone TEXT NOT NULL, enabled INTEGER NOT NULL, next_run_at INTEGER NOT NULL, last_run_at INTEGER, last_task_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS schedules_due ON schedules(enabled, next_run_at);
CREATE TABLE IF NOT EXISTS skills (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, description TEXT NOT NULL, instructions TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS summaries (conversation_id TEXT NOT NULL, owner TEXT NOT NULL, upto INTEGER NOT NULL, summary TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (owner, conversation_id));
CREATE TABLE IF NOT EXISTS connections (owner TEXT NOT NULL, provider TEXT NOT NULL, access_token TEXT NOT NULL, refresh_token TEXT NOT NULL, expires_at INTEGER NOT NULL, scope TEXT NOT NULL, email TEXT NOT NULL, PRIMARY KEY (owner, provider));
CREATE TABLE IF NOT EXISTS oauth_states (state TEXT PRIMARY KEY, owner TEXT NOT NULL, provider TEXT NOT NULL, created_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS vault (id TEXT PRIMARY KEY, owner TEXT NOT NULL, name TEXT NOT NULL, domain TEXT NOT NULL, username_enc TEXT NOT NULL, password_enc TEXT NOT NULL, notes_enc TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS vault_owner ON vault(owner, name);
CREATE TABLE IF NOT EXISTS prompts (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '[]', choices TEXT NOT NULL DEFAULT '[]', task_id TEXT, tool TEXT, status TEXT NOT NULL, decision TEXT, answer TEXT, created_at INTEGER NOT NULL, answered_at INTEGER, expires_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS prompts_owner ON prompts(owner, status, created_at);
CREATE TABLE IF NOT EXISTS inbox (id TEXT PRIMARY KEY, owner TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL, text TEXT NOT NULL, ref_id TEXT, created_at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS inbox_owner ON inbox(owner, created_at);
CREATE TABLE IF NOT EXISTS usage_daily (owner TEXT NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, count INTEGER NOT NULL, PRIMARY KEY (owner, day, kind));
`;

type Row = Record<string, unknown>;
const s = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const n = (v: unknown) => Number(v ?? 0);
const nn = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const sn = (v: unknown) => (v === null || v === undefined ? null : String(v));

function parseJson<T>(v: unknown, fallback: T): T {
  try {
    return JSON.parse(String(v)) as T;
  } catch {
    return fallback;
  }
}

const toMemory = (r: Row): Memory => ({ id: s(r.id), owner: s(r.owner), text: s(r.text), tags: s(r.tags), createdAt: n(r.created_at), updatedAt: n(r.updated_at) });
const toNote = (r: Row): Note => ({ id: s(r.id), owner: s(r.owner), title: s(r.title), body: s(r.body), source: s(r.source), createdAt: n(r.created_at), updatedAt: n(r.updated_at) });
const toVault = (r: Row): VaultRow => ({ id: s(r.id), owner: s(r.owner), name: s(r.name), domain: s(r.domain), usernameEnc: s(r.username_enc), passwordEnc: s(r.password_enc), notesEnc: s(r.notes_enc), createdAt: n(r.created_at), updatedAt: n(r.updated_at) });
const toPrompt = (r: Row): PromptRec => {
  const meta = parseJson<PromptMeta>(r.meta ?? '{}', {});
  return {
  id: s(r.id),
  owner: s(r.owner),
  kind: s(r.kind) as PromptKind,
  title: s(r.title),
  body: s(r.body),
  fields: parseJson(r.fields, []),
  choices: parseJson(r.choices, []),
  headline: meta.headline ?? null,
  content: meta.content ?? null,
  url: meta.url ?? null,
  secret: meta.secret ?? null,
  taskId: sn(r.task_id),
  tool: sn(r.tool),
  status: s(r.status) as PromptStatus,
  decision: sn(r.decision),
  answer: sn(r.answer),
  createdAt: n(r.created_at),
  answeredAt: nn(r.answered_at),
  expiresAt: n(r.expires_at),
  };
};
const toReminder = (r: Row): Reminder => ({ id: s(r.id), owner: s(r.owner), text: s(r.text), dueAt: n(r.due_at), status: s(r.status) as Reminder['status'], createdAt: n(r.created_at) });
const toTask = (r: Row): Task => ({
  id: s(r.id),
  owner: s(r.owner),
  kind: s(r.kind) as TaskKind,
  title: s(r.title),
  input: parseJson(r.input, {}),
  status: s(r.status) as TaskStatus,
  result: sn(r.result),
  error: sn(r.error),
  events: parseJson(r.events, []),
  noteId: sn(r.note_id),
  scheduleId: sn(r.schedule_id),
  acked: n(r.acked) === 1,
  createdAt: n(r.created_at),
  startedAt: nn(r.started_at),
  finishedAt: nn(r.finished_at),
});
const toSchedule = (r: Row): Schedule => ({
  id: s(r.id),
  owner: s(r.owner),
  title: s(r.title),
  prompt: s(r.prompt),
  skillId: sn(r.skill_id),
  cron: sn(r.cron),
  intervalSec: nn(r.interval_sec),
  timezone: s(r.timezone),
  enabled: n(r.enabled) === 1,
  nextRunAt: n(r.next_run_at),
  lastRunAt: nn(r.last_run_at),
  lastTaskId: sn(r.last_task_id),
  createdAt: n(r.created_at),
});
const toSkill = (r: Row): Skill => ({ id: s(r.id), owner: s(r.owner), name: s(r.name), description: s(r.description), instructions: s(r.instructions), createdAt: n(r.created_at), updatedAt: n(r.updated_at) });

export class AgentStore {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;');
    this.db.exec(SCHEMA);
    // added after the first release: card details for prompts (headline, full content, page link, secret field)
    const cols = this.all('PRAGMA table_info(prompts)').map((c) => s(c.name));
    if (!cols.includes('meta')) this.db.exec("ALTER TABLE prompts ADD COLUMN meta TEXT NOT NULL DEFAULT '{}'");
  }

  private all(sql: string, ...params: (string | number | null)[]): Row[] {
    return this.db.prepare(sql).all(...params) as Row[];
  }
  private get(sql: string, ...params: (string | number | null)[]): Row | undefined {
    return this.db.prepare(sql).get(...params) as Row | undefined;
  }
  private run(sql: string, ...params: (string | number | null)[]): number {
    return Number(this.db.prepare(sql).run(...params).changes);
  }

  // ---- memories
  addMemory(owner: string, text: string, tags = ''): Memory {
    const now = Date.now();
    // Same fact again: refresh it instead of storing a duplicate.
    const dup = this.get('SELECT * FROM memories WHERE owner = ? AND lower(text) = lower(?)', owner, text);
    if (dup) {
      this.run('UPDATE memories SET updated_at = ? WHERE id = ?', now, s(dup.id));
      return { ...toMemory(dup), updatedAt: now };
    }
    const m: Memory = { id: randomUUID(), owner, text, tags, createdAt: now, updatedAt: now };
    this.run('INSERT INTO memories (id, owner, text, tags, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', m.id, owner, text, tags, now, now);
    return m;
  }
  listMemories(owner: string, limit = 200): Memory[] {
    return this.all('SELECT * FROM memories WHERE owner = ? ORDER BY updated_at DESC LIMIT ?', owner, limit).map(toMemory);
  }
  /** Keyword search; empty query returns the most recent. */
  searchMemories(owner: string, query: string, limit = 10): Memory[] {
    const words = query.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);
    const all = this.listMemories(owner, 500);
    if (!words.length) return all.slice(0, limit);
    return all
      .map((m) => {
        const t = `${m.text} ${m.tags}`.toLowerCase();
        return { m, score: words.reduce((acc, w) => acc + (t.includes(w) ? 1 : 0), 0) };
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || b.m.updatedAt - a.m.updatedAt)
      .slice(0, limit)
      .map((x) => x.m);
  }
  deleteMemory(owner: string, id: string): boolean {
    return this.run('DELETE FROM memories WHERE owner = ? AND id = ?', owner, id) > 0;
  }
  /** Forget by id or by matching text; returns the removed memories. */
  forgetMemories(owner: string, idOrText: string): Memory[] {
    const byId = this.get('SELECT * FROM memories WHERE owner = ? AND id = ?', owner, idOrText);
    let targets: Memory[];
    if (byId) targets = [toMemory(byId)];
    else {
      const q = idOrText.toLowerCase();
      const contains = this.listMemories(owner, 500).filter((m) => m.text.toLowerCase().includes(q));
      targets = contains.length ? contains.slice(0, 5) : this.searchMemories(owner, idOrText, 1);
    }
    for (const m of targets) this.deleteMemory(owner, m.id);
    return targets;
  }
  clearMemories(owner: string): number {
    return this.run('DELETE FROM memories WHERE owner = ?', owner);
  }

  // ---- notes
  createNote(owner: string, title: string, body: string, source = 'chat'): Note {
    const now = Date.now();
    const note: Note = { id: randomUUID(), owner, title: title.slice(0, 200), body, source, createdAt: now, updatedAt: now };
    this.run('INSERT INTO notes (id, owner, title, body, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', note.id, owner, note.title, body, source, now, now);
    return note;
  }
  updateNote(owner: string, id: string, patch: { title?: string; body?: string; append?: string }): Note | null {
    const cur = this.getNote(owner, id);
    if (!cur) return null;
    const title = (patch.title ?? cur.title).slice(0, 200);
    const body = patch.body !== undefined ? patch.body : patch.append ? `${cur.body}\n\n${patch.append}` : cur.body;
    const now = Date.now();
    this.run('UPDATE notes SET title = ?, body = ?, updated_at = ? WHERE owner = ? AND id = ?', title, body, now, owner, id);
    return { ...cur, title, body, updatedAt: now };
  }
  getNote(owner: string, id: string): Note | null {
    const r = this.get('SELECT * FROM notes WHERE owner = ? AND id = ?', owner, id);
    return r ? toNote(r) : null;
  }
  findNoteByTitle(owner: string, title: string): Note | null {
    const r = this.get('SELECT * FROM notes WHERE owner = ? AND lower(title) = lower(?) ORDER BY updated_at DESC LIMIT 1', owner, title);
    return r ? toNote(r) : null;
  }
  listNotes(owner: string, query = '', limit = 100): Note[] {
    if (query) {
      const q = `%${query.toLowerCase()}%`;
      return this.all('SELECT * FROM notes WHERE owner = ? AND (lower(title) LIKE ? OR lower(body) LIKE ?) ORDER BY updated_at DESC LIMIT ?', owner, q, q, limit).map(toNote);
    }
    return this.all('SELECT * FROM notes WHERE owner = ? ORDER BY updated_at DESC LIMIT ?', owner, limit).map(toNote);
  }
  deleteNote(owner: string, id: string): boolean {
    return this.run('DELETE FROM notes WHERE owner = ? AND id = ?', owner, id) > 0;
  }

  // ---- reminders
  createReminder(owner: string, text: string, dueAt: number): Reminder {
    const r: Reminder = { id: randomUUID(), owner, text, dueAt, status: 'scheduled', createdAt: Date.now() };
    this.run('INSERT INTO reminders (id, owner, text, due_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?)', r.id, owner, text, dueAt, r.status, r.createdAt);
    return r;
  }
  listReminders(owner: string, status?: Reminder['status']): Reminder[] {
    return (status
      ? this.all('SELECT * FROM reminders WHERE owner = ? AND status = ? ORDER BY due_at ASC', owner, status)
      : this.all('SELECT * FROM reminders WHERE owner = ? ORDER BY due_at DESC LIMIT 200', owner)
    ).map(toReminder);
  }
  setReminderStatus(owner: string, id: string, status: Reminder['status']): boolean {
    return this.run('UPDATE reminders SET status = ? WHERE owner = ? AND id = ?', status, owner, id) > 0;
  }
  deleteReminder(owner: string, id: string): boolean {
    return this.run('DELETE FROM reminders WHERE owner = ? AND id = ?', owner, id) > 0;
  }

  // ---- tasks (persistent job queue)
  createTask(owner: string, kind: TaskKind, title: string, input: Record<string, unknown>, scheduleId: string | null = null): Task {
    const now = Date.now();
    const id = randomUUID();
    this.run(
      'INSERT INTO tasks (id, owner, kind, title, input, status, events, schedule_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      owner,
      kind,
      title.slice(0, 200),
      JSON.stringify(input),
      'queued',
      JSON.stringify([{ t: now, type: 'queued', text: 'Queued' }]),
      scheduleId,
      now,
    );
    return this.getTaskById(id)!;
  }
  getTaskById(id: string): Task | null {
    const r = this.get('SELECT * FROM tasks WHERE id = ?', id);
    return r ? toTask(r) : null;
  }
  getTask(owner: string, id: string): Task | null {
    const r = this.get('SELECT * FROM tasks WHERE owner = ? AND id = ?', owner, id);
    return r ? toTask(r) : null;
  }
  listTasks(owner: string, opts: { status?: string; unacked?: boolean; limit?: number } = {}): Task[] {
    const where = ['owner = ?'];
    const params: (string | number)[] = [owner];
    if (opts.status) {
      where.push(`status IN (${opts.status.split(',').map(() => '?').join(',')})`);
      params.push(...opts.status.split(','));
    }
    if (opts.unacked) where.push("acked = 0 AND status IN ('done','failed')");
    params.push(opts.limit ?? 50);
    return this.all(`SELECT * FROM tasks WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT ?`, ...params).map(toTask);
  }
  /** Atomically claims the oldest queued task. */
  claimNextTask(): Task | null {
    const r = this.get("SELECT id FROM tasks WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1");
    if (!r) return null;
    const changed = this.run("UPDATE tasks SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'", Date.now(), s(r.id));
    return changed ? this.getTaskById(s(r.id)) : null;
  }
  addTaskEvent(id: string, type: string, text: string) {
    const t = this.getTaskById(id);
    if (!t) return;
    const events = [...t.events, { t: Date.now(), type, text: text.slice(0, 500) }].slice(-100);
    this.run('UPDATE tasks SET events = ? WHERE id = ?', JSON.stringify(events), id);
  }
  finishTask(id: string, status: 'done' | 'failed' | 'cancelled', fields: { result?: string; error?: string; noteId?: string | null }) {
    this.run(
      'UPDATE tasks SET status = ?, result = ?, error = ?, note_id = COALESCE(?, note_id), finished_at = ? WHERE id = ? AND status IN (\'queued\', \'running\')',
      status,
      fields.result ?? null,
      fields.error ?? null,
      fields.noteId ?? null,
      Date.now(),
      id,
    );
  }
  ackTask(owner: string, id: string): boolean {
    return this.run('UPDATE tasks SET acked = 1 WHERE owner = ? AND id = ?', owner, id) > 0;
  }
  /** Tasks left running by a crash/restart go back to the queue. */
  requeueStale(): number {
    return this.run("UPDATE tasks SET status = 'queued' WHERE status = 'running'");
  }

  // ---- schedules
  createSchedule(owner: string, v: Omit<Schedule, 'id' | 'owner' | 'createdAt' | 'lastRunAt' | 'lastTaskId'>): Schedule {
    const id = randomUUID();
    const now = Date.now();
    this.run(
      'INSERT INTO schedules (id, owner, title, prompt, skill_id, cron, interval_sec, timezone, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      owner,
      v.title.slice(0, 200),
      v.prompt,
      v.skillId,
      v.cron,
      v.intervalSec,
      v.timezone,
      v.enabled ? 1 : 0,
      v.nextRunAt,
      now,
    );
    return this.getSchedule(owner, id)!;
  }
  getSchedule(owner: string, id: string): Schedule | null {
    const r = this.get('SELECT * FROM schedules WHERE owner = ? AND id = ?', owner, id);
    return r ? toSchedule(r) : null;
  }
  listSchedules(owner: string): Schedule[] {
    return this.all('SELECT * FROM schedules WHERE owner = ? ORDER BY created_at DESC', owner).map(toSchedule);
  }
  dueSchedules(now: number): Schedule[] {
    return this.all('SELECT * FROM schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at ASC LIMIT 50', now).map(toSchedule);
  }
  markScheduleRun(id: string, ranAt: number, nextRunAt: number, taskId: string) {
    this.run('UPDATE schedules SET last_run_at = ?, next_run_at = ?, last_task_id = ? WHERE id = ?', ranAt, nextRunAt, taskId, id);
  }
  updateSchedule(owner: string, id: string, patch: Partial<Pick<Schedule, 'title' | 'prompt' | 'enabled' | 'nextRunAt' | 'cron' | 'intervalSec' | 'timezone'>>): Schedule | null {
    const cur = this.getSchedule(owner, id);
    if (!cur) return null;
    const next = { ...cur, ...patch };
    this.run(
      'UPDATE schedules SET title = ?, prompt = ?, enabled = ?, next_run_at = ?, cron = ?, interval_sec = ?, timezone = ? WHERE owner = ? AND id = ?',
      next.title,
      next.prompt,
      next.enabled ? 1 : 0,
      next.nextRunAt,
      next.cron,
      next.intervalSec,
      next.timezone,
      owner,
      id,
    );
    return next;
  }
  deleteSchedule(owner: string, id: string): boolean {
    return this.run('DELETE FROM schedules WHERE owner = ? AND id = ?', owner, id) > 0;
  }

  // ---- skills
  upsertSkill(owner: string, v: { id?: string; name: string; description: string; instructions: string }): Skill {
    const now = Date.now();
    const existing = v.id ? this.getSkill(owner, v.id) : this.findSkill(owner, v.name);
    if (existing) {
      this.run('UPDATE skills SET name = ?, description = ?, instructions = ?, updated_at = ? WHERE owner = ? AND id = ?', v.name, v.description, v.instructions, now, owner, existing.id);
      return { ...existing, name: v.name, description: v.description, instructions: v.instructions, updatedAt: now };
    }
    const id = randomUUID();
    this.run('INSERT INTO skills (id, owner, name, description, instructions, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, owner, v.name, v.description, v.instructions, now, now);
    return this.getSkill(owner, id)!;
  }
  getSkill(owner: string, id: string): Skill | null {
    const r = this.get('SELECT * FROM skills WHERE owner = ? AND id = ?', owner, id);
    return r ? toSkill(r) : null;
  }
  findSkill(owner: string, nameOrId: string): Skill | null {
    const r = this.get('SELECT * FROM skills WHERE owner = ? AND (id = ? OR lower(name) = lower(?))', owner, nameOrId, nameOrId);
    return r ? toSkill(r) : null;
  }
  listSkills(owner: string): Skill[] {
    return this.all('SELECT * FROM skills WHERE owner = ? ORDER BY updated_at DESC', owner).map(toSkill);
  }
  deleteSkill(owner: string, id: string): boolean {
    return this.run('DELETE FROM skills WHERE owner = ? AND id = ?', owner, id) > 0;
  }

  // ---- rolling conversation summaries
  getSummary(owner: string, conversationId: string): { upto: number; summary: string } | null {
    const r = this.get('SELECT upto, summary FROM summaries WHERE owner = ? AND conversation_id = ?', owner, conversationId);
    return r ? { upto: n(r.upto), summary: s(r.summary) } : null;
  }
  setSummary(owner: string, conversationId: string, upto: number, summary: string) {
    this.run(
      'INSERT INTO summaries (conversation_id, owner, upto, summary, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(owner, conversation_id) DO UPDATE SET upto = excluded.upto, summary = excluded.summary, updated_at = excluded.updated_at',
      conversationId,
      owner,
      upto,
      summary,
      Date.now(),
    );
  }

  // ---- connectors
  saveConnection(c: Connection) {
    this.run(
      'INSERT INTO connections (owner, provider, access_token, refresh_token, expires_at, scope, email) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(owner, provider) DO UPDATE SET access_token = excluded.access_token, refresh_token = CASE WHEN excluded.refresh_token = \'\' THEN connections.refresh_token ELSE excluded.refresh_token END, expires_at = excluded.expires_at, scope = excluded.scope, email = excluded.email',
      c.owner,
      c.provider,
      c.accessToken,
      c.refreshToken,
      c.expiresAt,
      c.scope,
      c.email,
    );
  }
  getConnection(owner: string, provider: string): Connection | null {
    const r = this.get('SELECT * FROM connections WHERE owner = ? AND provider = ?', owner, provider);
    return r
      ? { owner, provider, accessToken: s(r.access_token), refreshToken: s(r.refresh_token), expiresAt: n(r.expires_at), scope: s(r.scope), email: s(r.email) }
      : null;
  }
  deleteConnection(owner: string, provider: string): boolean {
    return this.run('DELETE FROM connections WHERE owner = ? AND provider = ?', owner, provider) > 0;
  }
  createOAuthState(owner: string, provider: string): string {
    const state = randomUUID();
    this.run('DELETE FROM oauth_states WHERE created_at < ?', Date.now() - 15 * 60_000);
    this.run('INSERT INTO oauth_states (state, owner, provider, created_at) VALUES (?, ?, ?, ?)', state, owner, provider, Date.now());
    return state;
  }
  consumeOAuthState(state: string): { owner: string; provider: string } | null {
    const r = this.get('SELECT * FROM oauth_states WHERE state = ? AND created_at > ?', state, Date.now() - 15 * 60_000);
    this.run('DELETE FROM oauth_states WHERE state = ?', state);
    return r ? { owner: s(r.owner), provider: s(r.provider) } : null;
  }


  // ---- secure vault (values are encrypted by the caller; this layer never sees plaintext)
  insertVault(owner: string, v: { name: string; domain: string; usernameEnc: string; passwordEnc: string; notesEnc: string }): VaultRow {
    const now = Date.now();
    const id = randomUUID();
    this.run('INSERT INTO vault (id, owner, name, domain, username_enc, password_enc, notes_enc, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', id, owner, v.name, v.domain, v.usernameEnc, v.passwordEnc, v.notesEnc, now, now);
    return this.getVault(owner, id)!;
  }
  updateVault(owner: string, id: string, v: Partial<{ name: string; domain: string; usernameEnc: string; passwordEnc: string; notesEnc: string }>): VaultRow | null {
    const cur = this.getVault(owner, id);
    if (!cur) return null;
    const m = { ...cur, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) } as VaultRow;
    this.run('UPDATE vault SET name = ?, domain = ?, username_enc = ?, password_enc = ?, notes_enc = ?, updated_at = ? WHERE owner = ? AND id = ?', m.name, m.domain, m.usernameEnc, m.passwordEnc, m.notesEnc, Date.now(), owner, id);
    return this.getVault(owner, id);
  }
  getVault(owner: string, id: string): VaultRow | null {
    const r = this.get('SELECT * FROM vault WHERE owner = ? AND id = ?', owner, id);
    return r ? toVault(r) : null;
  }
  findVault(owner: string, nameOrId: string): VaultRow | null {
    const r = this.get('SELECT * FROM vault WHERE owner = ? AND (id = ? OR lower(name) = lower(?)) LIMIT 1', owner, nameOrId, nameOrId);
    return r ? toVault(r) : null;
  }
  listVault(owner: string): VaultRow[] {
    return this.all('SELECT * FROM vault WHERE owner = ? ORDER BY lower(name)', owner).map(toVault);
  }
  deleteVault(owner: string, id: string): boolean {
    return this.run('DELETE FROM vault WHERE owner = ? AND id = ?', owner, id) > 0;
  }

  // ---- prompts (approvals and questions the agent asks the user)
  createPrompt(owner: string, v: { kind: PromptKind; title: string; body: string; fields?: { label: string; value: string }[]; choices?: string[]; taskId?: string | null; tool?: string | null; expiresAt: number } & PromptMeta): PromptRec {
    const id = randomUUID();
    const meta: PromptMeta = {
      ...(v.headline ? { headline: v.headline.slice(0, 300) } : {}),
      ...(v.content ? { content: v.content.slice(0, 30_000) } : {}),
      ...(v.url ? { url: v.url.slice(0, 2000) } : {}),
      ...(v.secret ? { secret: v.secret } : {}),
    };
    this.run(
      'INSERT INTO prompts (id, owner, kind, title, body, fields, choices, task_id, tool, status, created_at, expires_at, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id, owner, v.kind, v.title.slice(0, 200), v.body.slice(0, 4000), JSON.stringify((v.fields ?? []).map((f) => ({ label: f.label.slice(0, 80), value: f.value.slice(0, 2000) }))), JSON.stringify(v.choices ?? []), v.taskId ?? null, v.tool ?? null, 'pending', Date.now(), v.expiresAt, JSON.stringify(meta),
    );
    return this.getPromptById(id)!;
  }
  getPromptById(id: string): PromptRec | null {
    const r = this.get('SELECT * FROM prompts WHERE id = ?', id);
    return r ? toPrompt(r) : null;
  }
  getPrompt(owner: string, id: string): PromptRec | null {
    const r = this.get('SELECT * FROM prompts WHERE owner = ? AND id = ?', owner, id);
    return r ? toPrompt(r) : null;
  }
  listPrompts(owner: string, status?: PromptStatus, limit = 50): PromptRec[] {
    return (status
      ? this.all('SELECT * FROM prompts WHERE owner = ? AND status = ? ORDER BY created_at DESC LIMIT ?', owner, status, limit)
      : this.all('SELECT * FROM prompts WHERE owner = ? ORDER BY created_at DESC LIMIT ?', owner, limit)
    ).map(toPrompt);
  }
  resolvePrompt(id: string, status: PromptStatus, decision: string | null, answer: string | null): boolean {
    return this.run("UPDATE prompts SET status = ?, decision = ?, answer = ?, answered_at = ? WHERE id = ? AND status = 'pending'", status, decision, answer, Date.now(), id) > 0;
  }
  expirePrompts(now = Date.now()): number {
    return this.run("UPDATE prompts SET status = 'expired', answered_at = ? WHERE status = 'pending' AND expires_at <= ?", now, now);
  }

  // ---- inbox (messages the agent sends to the user's chat: task results, reminders, questions)
  addInbox(owner: string, kind: string, title: string, text: string, refId: string | null = null): InboxItem {
    const id = randomUUID();
    const now = Date.now();
    this.run('INSERT INTO inbox (id, owner, kind, title, text, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, owner, kind, title.slice(0, 200), text.slice(0, 20_000), refId, now);
    return { id, owner, kind, title: title.slice(0, 200), text: text.slice(0, 20_000), refId, createdAt: now };
  }
  listInbox(owner: string, since = 0, limit = 100): InboxItem[] {
    return this.all('SELECT * FROM inbox WHERE owner = ? AND created_at > ? ORDER BY created_at ASC LIMIT ?', owner, since, limit).map((r) => ({
      id: s(r.id), owner: s(r.owner), kind: s(r.kind), title: s(r.title), text: s(r.text), refId: sn(r.ref_id), createdAt: n(r.created_at),
    }));
  }
  /** Reminders whose time has come (still scheduled). */
  dueReminders(now: number): Reminder[] {
    return this.all("SELECT * FROM reminders WHERE status = 'scheduled' AND due_at <= ? LIMIT 100", now).map(toReminder);
  }
  markReminderDone(id: string) {
    this.run("UPDATE reminders SET status = 'done' WHERE id = ?", id);
  }

  // ---- daily usage counters
  bumpUsage(owner: string, kind: string, by = 1, day = new Date().toISOString().slice(0, 10)): number {
    this.run('INSERT INTO usage_daily (owner, day, kind, count) VALUES (?, ?, ?, ?) ON CONFLICT(owner, day, kind) DO UPDATE SET count = count + excluded.count', owner, day, kind, by);
    return this.usageToday(owner, kind, day);
  }
  usageToday(owner: string, kind: string, day = new Date().toISOString().slice(0, 10)): number {
    return n(this.get('SELECT count FROM usage_daily WHERE owner = ? AND day = ? AND kind = ?', owner, day, kind)?.count);
  }

  // ---- whole-account data
  exportOwner(owner: string) {
    return {
      memories: this.listMemories(owner, 10_000),
      notes: this.listNotes(owner, '', 10_000),
      reminders: this.listReminders(owner),
      tasks: this.listTasks(owner, { limit: 1000 }),
      schedules: this.listSchedules(owner),
      skills: this.listSkills(owner),
      vault: this.listVault(owner).map((v) => ({ id: v.id, name: v.name, domain: v.domain, note: 'login details are encrypted and not exported' })),
      inbox: this.listInbox(owner, 0, 10_000),
      connections: ['google'].filter((p) => this.getConnection(owner, p)),
    };
  }
  deleteOwner(owner: string): number {
    let total = 0;
    for (const t of ['memories', 'notes', 'reminders', 'tasks', 'schedules', 'skills', 'summaries', 'connections', 'oauth_states', 'vault', 'prompts', 'inbox', 'usage_daily']) {
      total += this.run(`DELETE FROM ${t} WHERE owner = ?`, owner);
    }
    return total;
  }

  close() {
    this.db.close();
  }
}
