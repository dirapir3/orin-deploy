import { join, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import type { FetchLike } from '../ai/http.js';
import type { ChatProvider, ProviderMessage } from '../ai/types.js';
import { logger } from '../logger.js';
import { AgentStore, type PromptRec, type Task } from './store.js';
import { buildToolRegistry } from './tools/index.js';
import type { AgentServices, AskInput, AskResult, ToolContext, ToolRegistry } from './tools/types.js';
import { runAgent, type AgentEvent } from './loop.js';
import { buildAgentSystemPrompt } from './persona.js';
import { webSearch, fetchReadable, type SearchResult } from './tools/web.js';
import { computeNextRun } from './tools/tasks.js';
import type { LookupFn } from './net.js';
import { createSandboxManager } from './sandbox/index.js';

export interface AgentRuntimeOptions {
  config: AppConfig;
  provider: ChatProvider | null;
  fetchImpl?: FetchLike;
  lookup?: LookupFn;
  store?: AgentStore;
  /** start the background worker + scheduler timers (off in most tests) */
  startBackground?: boolean;
}

/** Human names for tools, for the capabilities list and the "not set up" persona section. */
export const CAPABILITY_NAMES: Record<string, string> = {
  run_code: 'Run code / build apps (sandbox)',
  browse: 'Full headless browser (Chromium; the lightweight browser_open/browser_submit tools work without it)',
  gmail_search: 'Gmail',
  calendar_list_events: 'Google Calendar',
  generate_image: 'Image generation',
};

/**
 * Owns the agent's state and background machinery: tool registry, SQLite store, job queue worker
 * and the cron scheduler.
 */
export class AgentRuntime {
  readonly store: AgentStore;
  readonly tools: ToolRegistry;
  readonly services: AgentServices;
  readonly config: AppConfig;
  private provider: ChatProvider | null;
  /** the user's own AI key (Profile > AI keys), per account; kept in memory only, refreshed by each chat */
  private userProviders = new Map<string, { p: ChatProvider; until: number }>();

  setUserProvider(account: string, p: ChatProvider | null): void {
    if (p) this.userProviders.set(account, { p, until: Date.now() + 12 * 3600_000 });
    else this.userProviders.delete(account);
  }

  /** the provider for one owner's background work: their own key when they set one, else the server's */
  providerFor(owner: string): ChatProvider | null {
    const u = this.userProviders.get(owner.split('#')[0]!);
    if (u && u.until > Date.now()) return u.p;
    return this.provider;
  }
  private timers: NodeJS.Timeout[] = [];
  private running = new Map<string, AbortController>();
  private active = 0;
  private draining: Promise<void> = Promise.resolve();
  private waiters = new Map<string, (r: AskResult) => void>();
  /** how many background tasks run at once (a task waiting for the user must not block the rest) */
  static readonly CONCURRENCY = 3;

  constructor(o: AgentRuntimeOptions) {
    this.config = o.config;
    this.provider = o.provider;
    const dataDir = resolve(o.config.agent.dataDir);
    this.store = o.store ?? new AgentStore(o.config.agent.dataDir === ':memory:' ? ':memory:' : join(dataDir, 'orin-agent.sqlite'));
    this.tools = buildToolRegistry();
    this.services = {
      config: o.config,
      store: this.store,
      fetchImpl: o.fetchImpl ?? fetch,
      lookup: o.lookup,
      mediaDir: o.config.agent.dataDir === ':memory:' ? join(process.cwd(), '.orin-media-test') : join(dataDir, 'media'),
      llm: () => (this.provider ? { provider: this.provider, model: o.config.chat.model, fastModel: o.config.chat.fastModel } : null),
      enqueue: () => this.kick(),
    };
    this.services.sandboxes = createSandboxManager(this.services);
    if (o.startBackground) this.start();
  }

  get enabled(): boolean {
    return Boolean(this.provider);
  }

  private started = false;

  /** Swap the model (admin page saved new keys). Running tasks finish on the old one. */
  setProvider(provider: ChatProvider | null) {
    this.provider = provider;
  }

  /** Starts the worker + scheduler if the agent became usable after a settings change. */
  ensureStarted() {
    if (this.enabled && !this.started) this.start();
  }

  start() {
    this.started = true;
    const requeued = this.store.requeueStale();
    if (requeued) logger.info('requeued tasks interrupted by a restart', { requeued });
    if (this.config.agent.worker) {
      this.timers.push(setInterval(() => this.kick(), this.config.agent.workerPollMs));
      this.timers.push(setInterval(() => this.tickScheduler(), this.config.agent.schedulerTickMs));
      for (const t of this.timers) t.unref();
    }
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.started = false;
    for (const c of this.running.values()) c.abort();
    await this.draining.catch(() => undefined);
    await this.services.sandboxes?.closeAll().catch(() => undefined);
  }

  // ------------------------------------------------------------------ scheduler
  tickScheduler(now = Date.now()): string[] {
    const created: string[] = [];
    // Due reminders are sent to the user's chat (the phone also shows a local notification).
    for (const r of this.store.dueReminders(now)) {
      this.store.markReminderDone(r.id);
      this.store.addInbox(r.owner, 'reminder', 'Reminder', r.text, r.id);
    }
    this.store.expirePrompts(now);
    for (const s of this.store.dueSchedules(now)) {
      const once = !s.cron && !s.intervalSec;
      let next: number;
      if (once) next = s.nextRunAt;
      else {
        try {
          next = computeNextRun(s, now);
        } catch {
          this.store.updateSchedule(s.owner, s.id, { enabled: false });
          continue;
        }
      }
      const skill = s.skillId ? this.store.getSkill(s.owner, s.skillId) : null;
      const task = skill
        ? this.store.createTask(s.owner, 'skill', `${s.title}`, { skillId: skill.id, extra: s.prompt, timezone: s.timezone, saveAsNote: false }, s.id)
        : this.store.createTask(s.owner, 'agent', s.title, { prompt: s.prompt, timezone: s.timezone, saveAsNote: false }, s.id);
      this.store.markScheduleRun(s.id, now, next, task.id);
      // A one-time schedule runs once and then stays in the list, switched off.
      if (once) this.store.updateSchedule(s.owner, s.id, { enabled: false });
      created.push(task.id);
    }
    if (created.length) this.kick();
    return created;
  }

  // ------------------------------------------------------------------ worker
  /** Start running queued tasks, up to CONCURRENCY at once. */
  kick() {
    if (!this.config.agent.worker) return;
    while (this.active < AgentRuntime.CONCURRENCY) {
      const task = this.store.claimNextTask();
      if (!task) break;
      this.active++;
      const p = this.runTask(task).finally(() => {
        this.active--;
        this.kick();
      });
      this.draining = Promise.all([this.draining, p]).then(() => undefined);
    }
  }

  /** Runs queued tasks until the queue is empty (one at a time). Exposed for tests. */
  async drain(): Promise<void> {
    for (;;) {
      const task = this.store.claimNextTask();
      if (!task) return;
      await this.runTask(task);
    }
  }

  // ------------------------------------------------------------------ approvals and questions
  /**
   * Shows the user an approval card or question and waits for the answer. In chat the card is
   * streamed to the open conversation (onCreated); in background tasks it also goes to the inbox
   * so the phone notifies the user.
   */
  ask(owner: string, input: AskInput, o: { signal: AbortSignal; timeoutMs: number; taskId?: string; onCreated?: (p: PromptRec) => void }): Promise<AskResult> {
    const p = this.store.createPrompt(owner, { kind: input.kind, title: input.title, body: input.body, fields: input.fields, choices: input.choices, taskId: o.taskId ?? null, tool: input.tool ?? null, expiresAt: Date.now() + o.timeoutMs });
    if (o.taskId) {
      this.store.addTaskEvent(o.taskId, 'waiting', `Waiting for you: ${input.title}`);
      this.store.addInbox(owner, input.kind === 'approval' ? 'approval' : 'question', input.kind === 'approval' ? `Approve? ${input.title}` : input.title, input.body, p.id);
    }
    o.onCreated?.(p);
    return new Promise<AskResult>((resolve) => {
      let done = false;
      const finish = (r: AskResult) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        o.signal.removeEventListener('abort', onAbort);
        this.waiters.delete(p.id);
        if (o.taskId) this.store.addTaskEvent(o.taskId, 'answered', r.decision === 'answer' ? `You answered: ${r.answer ?? ''}`.slice(0, 200) : `You chose: ${r.decision}`);
        resolve(r);
      };
      const timer = setTimeout(() => {
        this.store.resolvePrompt(p.id, 'expired', 'expired', null);
        finish({ decision: 'expired', answer: null });
      }, o.timeoutMs);
      timer.unref?.();
      const onAbort = () => {
        this.store.resolvePrompt(p.id, 'cancelled', 'cancelled', null);
        finish({ decision: 'cancelled', answer: null });
      };
      if (o.signal.aborted) return onAbort();
      o.signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(p.id, finish);
    });
  }

  /** The user's answer from the app. Returns the updated prompt, or null when it is not pending. */
  answerPrompt(owner: string, id: string, decision: 'approve' | 'deny' | 'change' | 'answer', text?: string): PromptRec | null {
    const p = this.store.getPrompt(owner, id);
    if (!p || p.status !== 'pending') return null;
    const answer = text?.trim() || (decision === 'answer' ? '' : null);
    if (!this.store.resolvePrompt(id, 'answered', decision, answer)) return null;
    const w = this.waiters.get(id);
    if (w) w({ decision, answer });
    else this.store.resolvePrompt(id, 'expired', 'expired', null); // nobody is waiting any more (server restarted)
    return this.store.getPrompt(owner, id);
  }

  cancelTask(owner: string, id: string): boolean {
    const t = this.store.getTask(owner, id);
    if (!t || (t.status !== 'queued' && t.status !== 'running')) return false;
    this.running.get(id)?.abort();
    this.store.finishTask(id, 'cancelled', { error: 'Cancelled by the user.' });
    return true;
  }

  private async runTask(task: Task) {
    const ctrl = new AbortController();
    this.running.set(task.id, ctrl);
    this.store.bumpUsage(task.owner, 'tasks');
    const timeout = setTimeout(() => ctrl.abort(), 45 * 60_000);
    this.store.addTaskEvent(task.id, 'started', 'Started');
    try {
      if (!this.providerFor(task.owner)) throw new Error('No AI model is configured on the server.');
      const tz = typeof task.input.timezone === 'string' ? task.input.timezone : undefined;
      if (task.kind === 'deep_research') {
        const { report, noteId, summary } = await this.deepResearch(task, ctrl.signal);
        this.store.finishTask(task.id, 'done', { result: `${summary}\n\n${report}`.trim(), noteId });
        this.store.addInbox(task.owner, 'task_done', task.title, `${summary}\n\n${report}`.trim(), task.id);
      } else {
        let prompt = String(task.input.prompt ?? '');
        if (task.kind === 'skill') {
          const skill = this.store.getSkill(task.owner, String(task.input.skillId ?? ''));
          if (!skill) throw new Error('The skill no longer exists.');
          prompt = `Run the skill "${skill.name}".\n\nInstructions:\n${skill.instructions}${task.input.extra ? `\n\nExtra context: ${String(task.input.extra)}` : ''}`;
        }
        const text = await this.runAgentTask(task, prompt, tz, ctrl.signal);
        let noteId: string | null = null;
        if (task.input.saveAsNote && text.trim()) noteId = this.store.createNote(task.owner, task.title, text, 'task').id;
        this.store.finishTask(task.id, 'done', { result: text, noteId });
        this.store.addInbox(task.owner, task.scheduleId ? 'schedule_done' : 'task_done', task.title, text, task.id);
      }
      this.store.addTaskEvent(task.id, 'done', 'Finished');
    } catch (e) {
      const msg = ctrl.signal.aborted ? 'Cancelled or timed out.' : (e as Error)?.message ?? String(e);
      this.store.addTaskEvent(task.id, 'error', msg);
      const cancelledByUser = this.store.getTaskById(task.id)?.status === 'cancelled';
      this.store.finishTask(task.id, ctrl.signal.aborted ? 'cancelled' : 'failed', { error: msg });
      if (!cancelledByUser) this.store.addInbox(task.owner, 'task_failed', task.title, `This task did not finish: ${msg}`, task.id);
      logger.warn('background task failed', { taskId: task.id, err: msg });
    } finally {
      clearTimeout(timeout);
      this.running.delete(task.id);
    }
  }

  toolContext(owner: string, signal: AbortSignal, mode: ToolContext['mode'], baseUrl: string, timezone?: string, taskId?: string): ToolContext {
    const ctx: ToolContext = { owner, services: this.services, signal, mode, baseUrl: this.config.agent.publicUrl || baseUrl, timezone, taskId, secrets: new Set() };
    if (taskId) ctx.ask = (input) => this.ask(owner, input, { signal, timeoutMs: 30 * 60_000, taskId });
    return ctx;
  }

  /** Capabilities that exist but are not configured, as {name, needs}. */
  unavailable(owner: string): { name: string; needs: string }[] {
    const seen = new Set<string>();
    const out: { name: string; needs: string }[] = [];
    for (const s of this.tools.status(owner, this.services)) {
      const name = CAPABILITY_NAMES[s.name];
      if (!s.live && name && !seen.has(name) && s.needs) {
        seen.add(name);
        out.push({ name, needs: s.needs });
      }
    }
    return out;
  }

  private async runAgentTask(task: Task, prompt: string, tz: string | undefined, signal: AbortSignal): Promise<string> {
    const provider = this.providerFor(task.owner)!;
    const tools = this.tools.available(task.owner, this.services, { inTask: true });
    const memories = this.store.listMemories(task.owner, 20);
    const system = buildAgentSystemPrompt(undefined, 'task', { character: task.owner.includes('#') ? task.owner.split('#')[1] : 'orin', timezone: tz, memories, tools: tools.map((t) => t.name), unavailable: this.unavailable(task.owner), inTask: true });
    const messages: ProviderMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: prompt },
    ];
    const onEvent = (ev: AgentEvent) => {
      if (ev.type === 'tool_start') this.store.addTaskEvent(task.id, 'tool', ev.label);
      else if (ev.type === 'tool_end') this.store.addTaskEvent(task.id, ev.ok ? 'tool_done' : 'tool_error', ev.summary);
    };
    const res = await runAgent({
      provider,
      model: this.config.chat.model,
      messages,
      tools,
      ctx: this.toolContext(task.owner, signal, 'task', this.config.agent.publicUrl || `http://localhost:${this.config.port}`, tz, task.id),
      maxSteps: this.config.agent.taskMaxSteps,
      maxOutputTokens: Math.max(this.config.chat.maxOutputTokens, 2048),
      toolTimeoutMs: this.config.agent.toolTimeoutMs,
      signal,
      onEvent,
    });
    if (!res.text.trim()) throw new Error('The model returned an empty result.');
    return res.text.trim();
  }

  private async complete(messages: ProviderMessage[], signal: AbortSignal, model: string, maxOutputTokens = 1500): Promise<string> {
    let out = '';
    for await (const c of this.provider!.streamChat({ model, messages, maxOutputTokens, temperature: 0.3, signal })) {
      if (c.type === 'delta') out += c.text;
    }
    return out.trim();
  }

  /** search → read → synthesise, saved as a Markdown note with numbered citations. */
  async deepResearch(task: Task, signal: AbortSignal): Promise<{ report: string; noteId: string; summary: string }> {
    const question = String(task.input.question ?? task.title);
    const depth = String(task.input.depth ?? 'standard');
    const nQueries = depth === 'quick' ? 2 : depth === 'thorough' ? 5 : 3;
    const nSources = depth === 'quick' ? 3 : depth === 'thorough' ? 10 : 6;
    const ev = (type: string, text: string) => this.store.addTaskEvent(task.id, type, text);

    ev('plan', 'Planning searches');
    let queries: string[] = [question];
    try {
      const raw = await this.complete(
        [
          { role: 'system', content: `You plan web research. Return ONLY a JSON array of ${nQueries} short, diverse search queries (strings) that together answer the question. Today is ${new Date().toISOString().slice(0, 10)}.` },
          { role: 'user', content: question },
        ],
        signal,
        this.config.chat.fastModel,
        400,
      );
      const arr = JSON.parse(/\[[\s\S]*\]/.exec(raw)?.[0] ?? '[]') as unknown[];
      const qs = arr.filter((x): x is string => typeof x === 'string' && x.trim().length > 2).slice(0, nQueries);
      if (qs.length) queries = qs;
    } catch {
      /* fall back to the question itself */
    }

    const results: SearchResult[] = [];
    for (const q of queries) {
      if (signal.aborted) throw new Error('cancelled');
      ev('tool', `Searching: ${q}`);
      try {
        const r = await webSearch(this.services, q, signal, 6);
        for (const x of r.results) if (!results.some((y) => y.url === x.url)) results.push(x);
      } catch (e) {
        ev('tool_error', `Search failed: ${(e as Error).message}`);
      }
    }
    if (!results.length) throw new Error('Web search returned no results, so no report could be written.');

    const sources: { n: number; title: string; url: string; text: string }[] = [];
    for (const r of results) {
      if (sources.length >= nSources) break;
      if (signal.aborted) throw new Error('cancelled');
      ev('tool', `Reading ${r.url}`);
      try {
        const page = await fetchReadable(this.services, r.url, signal, 6000);
        if (page.text.length < 200) continue;
        sources.push({ n: sources.length + 1, title: page.title || r.title, url: page.url, text: page.text });
      } catch {
        // Use the snippet when the page cannot be read.
        if (r.snippet) sources.push({ n: sources.length + 1, title: r.title, url: r.url, text: r.snippet });
      }
    }
    ev('tool_done', `Read ${sources.length} sources`);

    ev('write', 'Writing the report');
    const material = sources.map((s) => `[${s.n}] ${s.title}\nURL: ${s.url}\n${s.text.slice(0, depth === 'thorough' ? 3500 : 4500)}`).join('\n\n---\n\n');
    const report = await this.complete(
      [
        {
          role: 'system',
          content:
            'You write clear, accurate research reports in Markdown. Use ONLY the provided sources; cite claims with bracketed numbers like [1] that match the sources. Structure: a title (#), a short "Summary" section (3-5 bullet points), then sections with headings, then "Open questions" if relevant. Do not include a sources list; it is appended automatically. Be honest where sources disagree or are thin.',
        },
        { role: 'user', content: `Question: ${question}\n\nSources:\n\n${material}` },
      ],
      signal,
      this.config.chat.model,
      3000,
    );
    if (!report) throw new Error('The model returned an empty report.');
    const full = `${report}\n\n## Sources\n${sources.map((s) => `${s.n}. [${s.title.replace(/[[\]]/g, '')}](${s.url})`).join('\n')}\n`;
    const note = this.store.createNote(task.owner, `Research: ${question.slice(0, 120)}`, full, 'research');
    const summary = `Report saved to Notes as "${note.title}" (${sources.length} sources).`;
    return { report: full, noteId: note.id, summary };
  }
}
