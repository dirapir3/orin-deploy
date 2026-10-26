import express, { Router, type Request } from 'express';
import { BUILT_IN_APPS, isBuiltInApp } from '../agent/apps.js';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { injectShim, siteFrame, sitesRoot } from '../agent/sites.js';
import { z } from 'zod';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { agentOwnerKey, agentOwners, requesterKey } from '../middleware/auth.js';
import { chatRuns } from '../agent/chatRuns.js';
import { parseBody } from './util.js';
import { CHARACTERS } from '../agent/persona.js';
import { saveLogin, toPublic, updateLogin, signToken } from '../agent/vault.js';
import { deleteWsFile, listFiles, MAX_WORKSPACE_BYTES, usedBytes, wipeWorkspace, workspaceDir, writeWsFile } from '../agent/workspace.js';
import { listConnectors } from '../agent/connectors.js';
import { requestBaseUrl } from './agentChat.js';

/** agent-scoped owner (X-Orin-Agent header) */
const owner = (req: Request) => agentOwnerKey(req);
/** account-wide owner: the vault, usage and account data are shared by the four agents */
const account = (req: Request) => requesterKey(req);
const idParam = (req: Request) => String(req.params.id ?? '');

/** Daily limits shown on the Usage screen (chat is enforced; set LIMIT_*_DAY to change). */
export function dailyLimits() {
  return {
    chat: Number(process.env.LIMIT_CHAT_DAY) || 300,
    tasks: Number(process.env.LIMIT_TASKS_DAY) || 60,
  };
}

const VaultBody = z.object({
  name: z.string().trim().min(1).max(80),
  domain: z.string().trim().min(3).max(200),
  username: z.string().max(300).default(''),
  password: z.string().max(500).default(''),
  notes: z.string().max(2000).optional(),
});
// No defaults here: a field left out of an edit keeps its saved value (an empty password also keeps it).
const VaultPatch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  domain: z.string().trim().min(3).max(200).optional(),
  username: z.string().max(300).optional(),
  password: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
});
const AnswerBody = z.object({
  decision: z.enum(['approve', 'deny', 'change', 'answer', 'done']),
  text: z.string().max(4000).optional(),
  // a secure field: goes straight to the Secure Vault, never into the prompt record or to the model
  secret: z.object({ username: z.string().max(300).optional(), value: z.string().min(1).max(4000) }).optional(),
});
const FileBody = z.object({ path: z.string().min(1).max(200), content: z.string().max(1_000_000) });

/** Placeholder catalogue for apps that are not wired up yet, so the Apps page is honest about them. */
const COMING_SOON = [
  { id: 'drive', name: 'Google Drive', description: 'Find and read your Drive files.' },
  { id: 'notion', name: 'Notion', description: 'Search and update your Notion pages.' },
  { id: 'slack', name: 'Slack', description: 'Read and send Slack messages.' },
  { id: 'github', name: 'GitHub', description: 'Issues, pull requests and repositories.' },
  { id: 'spotify', name: 'Spotify', description: 'Play music and manage playlists.' },
  { id: 'outlook', name: 'Outlook', description: 'Microsoft mail and calendar.' },
];

export function agentExtraRouter(deps: Deps): Router {
  const r = Router();
  const agent = deps.agent!;
  const st = agent.store;

  // ---- sites the agent published (public, no sign-in). Each response runs in a CSP sandbox, an
  // opaque origin, so a published page can never read the app's storage, cookies or tokens.
  const sites = sitesRoot(agent.services);
  mkdirSync(sites, { recursive: true });
  // The sandboxed page has an opaque origin ("null"), so its own CSS, scripts, images and fetches
  // are cross-origin requests: they need CORP cross-origin and CORS *. Published sites are public
  // content and are served without credentials, so this exposes nothing.
  r.use(
    '/sites',
    (req, res, next) => {
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'none'");
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.removeHeader('Access-Control-Allow-Credentials');
      res.setHeader('Cache-Control', 'no-cache');
      if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD');
        res.status(204).end();
        return;
      }
      next();
    },
    // HTML pages get a small storage shim (localStorage etc. throw in the sandbox)
    (req, res, next) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      let rel: string;
      try {
        rel = decodeURIComponent(req.path);
      } catch {
        return next();
      }
      if (rel.endsWith('/')) rel += 'index.html';
      if (!/\.html?$/i.test(rel) || rel.split('/').some((s) => s.startsWith('.'))) return next();
      const base = resolve(sites);
      const abs = resolve(base, `.${rel}`);
      if (!abs.startsWith(base + sep) || !existsSync(abs) || !statSync(abs).isFile()) return next();
      res.setHeader('Vary', 'Sec-Fetch-Dest');
      // A browser opening the link directly gets Orin's frame around the sandboxed page, so the
      // site's saved data survives a reload; the frame then loads this same URL as an iframe.
      if (req.get('sec-fetch-dest') === 'document') {
        const slug = rel.split('/')[1] ?? '';
        res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'");
        res.type('html').send(siteFrame(slug));
        return;
      }
      res.setHeader('Content-Security-Policy', "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; default-src * data: blob: 'unsafe-inline' 'unsafe-eval'; frame-ancestors 'self'");
      res.type('html').send(injectShim(readFileSync(abs, 'utf8')));
    },
    express.static(sites, { dotfiles: 'deny', index: 'index.html', redirect: true, fallthrough: true }),
  );

  // ---- characters
  r.get('/agent/characters', (_req, res) => res.json({ characters: CHARACTERS.map(({ id, name, tagline, voice, color }) => ({ id, name, tagline, voice, color })) }));

  // ---- Secure Vault (passwords are write-only: never returned)
  r.get('/agent/vault', (req, res) => res.json({ logins: st.listVault(account(req)).map(toPublic) }));
  r.post('/agent/vault', (req, res) => {
    const b = parseBody(VaultBody, req.body);
    if (st.listVault(account(req)).length >= 100) throw new AppError('validation_error', 'The vault holds up to 100 logins.');
    res.status(201).json({ login: toPublic(saveLogin(st, account(req), b)) });
  });
  r.post('/agent/vault/:id', (req, res) => {
    const row = updateLogin(st, account(req), idParam(req), parseBody(VaultPatch, req.body));
    if (!row) throw new AppError('not_found', 'Login not found.');
    res.json({ login: toPublic(row) });
  });
  r.delete('/agent/vault/:id', (req, res) => {
    if (!st.deleteVault(account(req), idParam(req))) throw new AppError('not_found', 'Login not found.');
    res.json({ ok: true });
  });

  // ---- approvals and questions
  r.get('/agent/prompts', (req, res) => {
    st.expirePrompts();
    const status = req.query.status === 'all' ? undefined : 'pending';
    res.json({ prompts: st.listPrompts(owner(req), status, 50) });
  });
  r.post('/agent/prompts/:id', (req, res) => {
    const b = parseBody(AnswerBody, req.body);
    const o = owner(req);
    const waiting = st.getPrompt(o, idParam(req));
    if (!waiting || waiting.status !== 'pending') throw new AppError('not_found', 'This request is no longer waiting for an answer.');
    const allowed: Record<string, string[]> = {
      approval: ['approve', 'deny', 'change'],
      question: ['answer', 'deny'],
      secret: ['answer', 'deny'],
      step: ['done', 'deny'],
    };
    if (!(allowed[waiting.kind] ?? []).includes(b.decision)) throw new AppError('validation_error', 'That answer does not fit this request.');
    let text = b.text;
    if (waiting.kind === 'secret' && b.decision === 'answer') {
      const spec = waiting.secret;
      const value = b.secret?.value.trim();
      if (!spec || !value) throw new AppError('validation_error', 'Type it into the secure field first.');
      const acc = account(req);
      const existing = st.findVault(acc, spec.name);
      const username = b.secret?.username?.trim();
      if (existing) updateLogin(st, acc, existing.id, { domain: spec.domain, password: value, ...(username !== undefined && spec.what === 'login' ? { username } : {}) });
      else {
        if (st.listVault(acc).length >= 100) throw new AppError('validation_error', 'The vault holds up to 100 logins.');
        saveLogin(st, acc, { name: spec.name, domain: spec.domain, username: spec.what === 'login' ? (username ?? '') : '', password: value, notes: spec.what === 'api_key' ? 'API key' : undefined });
      }
      text = `Saved to your Secure Vault as "${spec.name}"`;
    } else if (b.decision === 'answer' && !text?.trim()) throw new AppError('validation_error', 'Type an answer first.');
    const p = agent.answerPrompt(o, idParam(req), b.decision, text);
    if (!p) throw new AppError('not_found', 'This request is no longer waiting for an answer.');
    res.json({ prompt: p });
  });

  // ---- one poll for the phone: new inbox items + pending prompts + running task count
  r.get('/agent/sync', (req, res) => {
    const o = owner(req);
    st.expirePrompts();
    res.json({
      items: st.listInbox(o, Number(req.query.since) || 0, 100),
      prompts: st.listPrompts(o, 'pending', 20),
      running: st.listTasks(o, { status: 'queued,running', limit: 50 }).length,
      now: Date.now(),
    });
  });

  /** The chat a task result belongs to (tasks started from a chat remember it). */
  const conversationOf = (kind: string, refId: string | null): string | null => {
    if (!refId) return null;
    if (kind === 'reply') return refId; // a chat reply that finished while the app was away
    let taskId: string | null = null;
    if (kind.startsWith('task_') || kind === 'schedule_done') taskId = refId;
    else if (kind === 'approval' || kind === 'question') taskId = st.getPromptById(refId)?.taskId ?? null;
    if (!taskId) return null;
    const c = st.getTaskById(taskId)?.input.conversationId;
    return typeof c === 'string' ? c : null;
  };

  // Everything on the Agent page for all four agents in one request.
  r.get('/agent/overview', (req, res) => {
    const acc = account(req);
    st.expirePrompts();
    const tasks: unknown[] = [];
    const schedules: unknown[] = [];
    const skills: unknown[] = [];
    const reminders: unknown[] = [];
    const prompts: unknown[] = [];
    agentOwners(acc).forEach((o, i) => {
      const agentId = CHARACTERS[i]!.id;
      for (const t of st.listTasks(o, { limit: 60 })) tasks.push({ ...t, owner: undefined, agent: agentId });
      for (const x of st.listSchedules(o)) schedules.push({ ...x, owner: undefined, agent: agentId });
      for (const x of st.listSkills(o)) skills.push({ ...x, owner: undefined, agent: agentId });
      for (const x of st.listReminders(o)) reminders.push({ ...x, owner: undefined, agent: agentId });
      for (const p of st.listPrompts(o, 'pending', 20)) prompts.push({ ...p, owner: undefined, agent: agentId });
    });
    (tasks as { createdAt: number }[]).sort((a, b) => b.createdAt - a.createdAt);
    res.json({ tasks, schedules, skills, reminders, prompts, now: Date.now() });
  });

  // all four agents in one poll (items and prompts carry their agent id)
  // ---- chat replies that keep working while the app is away (see agent/chatRuns.ts)
  // Pick a reply up again: every event after the first `after` ones, then live ones until it ends.
  r.get('/agent/runs/:id/events', (req, res) => {
    const run = chatRuns.get(String(req.params.id), account(req));
    if (!run) throw new AppError('not_found', 'That reply is no longer available.');
    const after = Math.max(0, Number.parseInt(String(req.query.after ?? '0'), 10) || 0);
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    run.attach(res, after);
  });
  r.get('/agent/runs/:id', (req, res) => {
    const run = chatRuns.get(String(req.params.id), account(req));
    if (!run) throw new AppError('not_found', 'That reply is no longer available.');
    res.json({ id: run.id, done: run.done, events: run.events.length });
  });
  // Stop a reply (the Stop button); closing the app does not stop it.
  r.post('/agent/runs/:id/cancel', (req, res) => {
    const run = chatRuns.get(String(req.params.id), account(req));
    if (run && !run.done) run.controller.abort();
    res.json({ ok: true });
  });

  r.get('/agent/sync-all', (req, res) => {
    const acc = account(req);
    const since = Number(req.query.since) || 0;
    st.expirePrompts();
    const items: unknown[] = [];
    const prompts: unknown[] = [];
    let running = 0;
    agentOwners(acc).forEach((o, i) => {
      const id = CHARACTERS[i]!.id;
      for (const x of st.listInbox(o, since, 100)) items.push({ ...x, owner: undefined, agent: id, conversationId: conversationOf(x.kind, x.refId) });
      for (const p of st.listPrompts(o, 'pending', 20)) prompts.push({ ...p, owner: undefined, agent: id });
      running += st.listTasks(o, { status: 'queued,running', limit: 50 }).length + chatRuns.active(o);
    });
    res.json({ items, prompts, running, now: Date.now() });
  });

  // ---- reminders created from the app
  r.post('/agent/reminders', (req, res) => {
    const b = parseBody(z.object({ text: z.string().trim().min(1).max(500), dueAt: z.number().int().positive() }), req.body);
    res.status(201).json({ reminder: st.createReminder(owner(req), b.text, b.dueAt) });
  });

  // ---- inbox: messages from the agent to the user's chat
  r.get('/agent/inbox', (req, res) => res.json({ items: st.listInbox(owner(req), Number(req.query.since) || 0, 100), now: Date.now() }));

  // ---- workspace files (artifacts)
  r.get('/agent/files', (req, res) => {
    const root = workspaceDir(agent.services, owner(req));
    // downloads/ (big single files like an APK) has its own 100 MB limit, so it is not in the 20 MB bar.
    res.json({ files: listFiles(root), usedBytes: usedBytes(root), limitBytes: MAX_WORKSPACE_BYTES });
  });
  r.post('/agent/files', (req, res) => {
    const b = parseBody(FileBody, req.body);
    try {
      res.status(201).json({ file: writeWsFile(workspaceDir(agent.services, owner(req)), b.path, b.content) });
    } catch (e) {
      throw new AppError('validation_error', (e as Error).message);
    }
  });
  r.post('/agent/files/link', (req, res) => {
    const path = String((req.body as { path?: string })?.path ?? '');
    const files = listFiles(workspaceDir(agent.services, owner(req)));
    if (!files.some((f) => f.path === path)) throw new AppError('not_found', 'File not found.');
    const token = signToken(JSON.stringify({ o: owner(req), p: path }), 3600);
    const base = agent.config.agent.publicUrl || requestBaseUrl(req);
    res.json({ url: `${base}/v1/files/${token}/${encodeURIComponent(path.split('/').pop() ?? 'file')}` });
  });
  r.delete('/agent/files', (req, res) => {
    const path = String(req.query.path ?? '');
    let ok: boolean;
    try {
      ok = deleteWsFile(workspaceDir(agent.services, owner(req)), path);
    } catch {
      ok = false;
    }
    if (!ok) throw new AppError('not_found', 'File not found.');
    res.json({ ok: true });
  });

  // ---- apps catalogue (real + coming soon)
  r.get('/agent/apps', (req, res) => {
    const off = st.appsOff(owner(req));
    res.json({ builtIn: BUILT_IN_APPS.map((a) => ({ id: a.id, name: a.name, what: a.what, enabled: !off.includes(a.id) })), apps: [...listConnectors(agent.services, st, owner(req)).map((c) => ({ ...c, status: c.connected ? 'connected' : c.configured ? 'available' : 'needs_setup' })), ...COMING_SOON.map((c) => ({ ...c, configured: false, connected: false, account: null, needs: [], tools: [], status: 'coming_soon' }))] });
  });

  // turn a built-in app on or off for this character (its tools stop being offered everywhere)
  r.patch('/agent/apps/:id', (req, res) => {
    const id = String(req.params.id);
    const enabled = (req.body as { enabled?: unknown } | undefined)?.enabled;
    if (!isBuiltInApp(id)) return void res.status(404).json({ error: { message: 'No such built-in app' } });
    if (typeof enabled !== 'boolean') return void res.status(400).json({ error: { message: 'enabled must be true or false' } });
    st.setAppEnabled(owner(req), id, enabled);
    res.json({ ok: true, id, enabled });
  });

  // ---- usage
  r.get('/agent/usage', (req, res) => {
    const acc = account(req);
    const all = agentOwners(acc);
    const limits = dailyLimits();
    const sum = (f: (o: string) => number) => all.reduce((n, o) => n + f(o), 0);
    res.json({
      day: new Date().toISOString().slice(0, 10),
      chat: { used: st.usageToday(acc, 'chat'), limit: limits.chat },
      tasks: { used: sum((o) => st.usageToday(o, 'tasks')), limit: limits.tasks },
      storage: { used: sum((o) => listFiles(workspaceDir(agent.services, o)).reduce((n, f) => n + f.size, 0)), limit: MAX_WORKSPACE_BYTES },
      memories: sum((o) => st.listMemories(o, 10_000).length),
      notes: sum((o) => st.listNotes(o, '', 10_000).length),
      logins: st.listVault(acc).length,
      schedules: sum((o) => st.listSchedules(o).length),
      rateLimitPerMinute: req.auth?.kind === 'user' ? deps.config.access.rateLimitMax : deps.config.access.rateLimitGuestMax,
    });
  });

  // ---- Orin's computer (cloud sandbox): what is running and what it did, for the Activity tab
  r.get('/agent/sandbox', (req, res) => {
    const m = agent.services.sandboxes;
    const o = owner(req);
    const needs = m ? m.needs() : 'a sandbox provider (E2B_API_KEY)';
    res.json({ enabled: needs === null, needs, provider: m?.providerId() ?? null, session: m?.status(o) ?? null, events: m?.activity(o) ?? [] });
  });
  r.post('/agent/sandbox/stop', async (req, res) => {
    const m = agent.services.sandboxes;
    res.json({ ok: true, closed: m ? await m.close(owner(req), 'you stopped it') : false });
  });

  // ---- account data
  r.get('/agent/export', (req, res) => {
    const acc = account(req);
    res.setHeader('Content-Disposition', 'attachment; filename="orin-export.json"');
    const agents = Object.fromEntries(agentOwners(acc).map((o, i) => [CHARACTERS[i]!.id, { ...st.exportOwner(o), files: listFiles(workspaceDir(agent.services, o)) }]));
    res.json({ exportedAt: new Date().toISOString(), vault: st.listVault(acc).map((v) => ({ name: v.name, domain: v.domain })), agents });
  });
  r.delete('/agent/data', (req, res) => {
    let rows = 0;
    for (const o of agentOwners(account(req))) {
      for (const t of st.listTasks(o, { status: 'queued,running' })) agent.cancelTask(o, t.id);
      rows += st.deleteOwner(o);
      wipeWorkspace(agent.services, o);
    }
    res.json({ ok: true, deletedRows: rows });
  });

  return r;
}
