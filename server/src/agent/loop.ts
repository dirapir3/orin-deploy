import { z } from 'zod';
import type { ChatProvider, ProviderMessage, ToolCall } from '../ai/types.js';
import { AppError } from '../errors.js';
import { WorkTracker } from './craft.js';
import { amendmentNote, type Amendment } from './amendments.js';
import { friendlyLabel, friendlySummary } from './friendly.js';
import { MORE_TOOLS } from './quickLane.js';
import { toToolSpec, type ToolContext, type ToolDef, type ToolDisplay } from './tools/types.js';

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; label: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string; display?: ToolDisplay; durationMs: number }
  | { type: 'step'; step: number }
  /** the text just streamed was narration before tool calls ("Let me set that up"), not the reply */
  | { type: 'interim'; text: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'served'; provider: string; model: string };

export interface RunAgentOptions {
  provider: ChatProvider;
  model: string;
  messages: ProviderMessage[];
  tools: ToolDef[];
  ctx: ToolContext;
  maxSteps: number;
  maxOutputTokens: number;
  temperature?: number;
  /** voice calls: the model thinks as little as it can so the first words come sooner */
  fast?: boolean;
  toolTimeoutMs: number;
  signal: AbortSignal;
  onEvent: (ev: AgentEvent) => void;
  /**
   * Called when the step budget runs out while the model still wants tools. It hands the work on
   * (a background task that picks up from these messages) and returns the line to tell the user.
   * Without it the last step answers without tools, honestly saying what is and isn't done.
   */
  handoff?: (messages: ProviderMessage[]) => Promise<string | null>;
  /** Called after every round of tool results with the transcript so far (background tasks save it, so a restart resumes from here). */
  onCheckpoint?: (messages: ProviderMessage[], steps: number) => void;
  /**
   * Messages the user sent in the chat while this work runs (agent/amendments.ts). Taken before
   * every step, and once more before the final answer, so a change they ask for lands in this work.
   */
  takeNotes?: () => Amendment[];
  /**
   * Quick lane (agent/quickLane.ts): the run starts with a short prompt and a few tools. When the model
   * calls more_tools, the full prompt and these tools are swapped in for the rest of the reply.
   */
  escalate?: { tools: ToolDef[]; system: () => string; model?: string; firstByteMs?: number };
  /** move on to the next model when one sends nothing at all for this long (a stalled model held one reply for 235 s) */
  firstByteMs?: number;
  /**
   * When every model fails with a passing error (rate limit, overloaded, timeout) before a step sent
   * anything, wait and try that step again instead of ending the work, up to this many ms of waiting
   * in total (0 = never). Free keys hit per-minute limits mid-job; a one-minute wait saves the job.
   */
  providerWaitMs?: number;
  /** told before each such wait (the UI can say "waiting for the AI") */
  onProviderWait?: (ms: number, error: AppError) => void;
}

/** errors that pass with time: rate limits per minute, overloaded models, a timeout, a dropped connection */
export function isPassingProviderError(e: unknown): e is AppError {
  if (!(e instanceof AppError)) return false;
  if (e.code === 'cancelled' || e.code === 'invalid_api_key' || e.code === 'provider_bad_request' || e.code === 'validation_error') return false;
  // a used-up daily quota does not come back in minutes; a per-minute "quota" (Google's wording for
  // free keys) does, so only the daily one ends the job at once
  if (/daily quota/i.test(e.message) && !/All AI providers failed/.test(e.message)) return false;
  if (e.code === 'provider_rate_limited') return true;
  return e.code === 'provider_unavailable' || e.code === 'timeout' || e.retryable;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new AppError('cancelled', 'Cancelled.'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AppError('cancelled', 'Cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });

const OUTPUT_LIMIT_NOTE =
  'Your last reply was cut off by the output limit before anything was sent, so nothing happened. ' +
  'Do it again in smaller pieces: write a big file in parts (sandbox_write_file with the first part, then ' +
  'sandbox_write_file with append: true for each next part, about 300 lines each), or keep each tool call short.';
const PROVIDER_WAITS = [8_000, 20_000, 40_000, 60_000];
const EMPTY_NOTE = 'Your last reply was empty. Carry on: call the next tool you need, or give your final answer.';
const BUDGET_NOTE =
  'Step budget reached. Answer now without calling tools: say plainly what is finished (with links or files) and ' +
  'what is not. Never ask the user to say "continue" or to ask again.';

export interface RunAgentResult {
  text: string;
  steps: number;
  toolCalls: number;
  finishReason: string;
  inputTokens: number;
  outputTokens: number;
  displays: ToolDisplay[];
  /** provider/model that answered the last step (differs from the primary when the fallback chain stepped in) */
  servedBy?: { provider: string; model: string };
  /** true when the step budget ran out and the work was handed on to a background task */
  handedOff?: boolean;
  /**
   * What the user should keep as the reply: the final step's text, without the narration written
   * before tool calls. Falls back to the last narration when the final step wrote nothing (the
   * answer came before a trailing tool call), and is empty when the model wrote nothing at all.
   */
  reply: string;
  /** tools that ended with ok=false, in order (names), so callers never claim plain success */
  failedTools: string[];
}

function parseArgs(raw: string): unknown {
  if (!raw.trim()) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // Some models wrap JSON in code fences.
    const m = /\{[\s\S]*\}/.exec(raw);
    if (m) return JSON.parse(m[0]);
    throw new Error('Arguments were not valid JSON.');
  }
}

/** Tools that change or read a shared computer/project state, so a batch of them must keep its order. */
export const STATEFUL_TOOL = /^(sandbox_|computer_|upload_to_computer|deliver_project|publish_site|preview_site|unpublish_site|build_|deploy|git_|apk_|write_file|delete_file|code_map|run_checks|scaffold_project|github_)/;

/**
 * Some open models leak their chat-format tokens into the tool name ("sandbox_write_file<|channel|>json",
 * "functions.sandbox_run", "<tool>run_checks"): keep only the name so the call still runs.
 */
export function cleanToolName(name: string): string {
  let n = (name ?? '').trim();
  n = n.replace(/<\|[^|]*\|>.*$/s, '').replace(/<\/?[a-z_]+>/gi, '');
  n = n.replace(/^(functions|function|tools|tool|default_api)[.:]/i, '');
  n = n.replace(/[^A-Za-z0-9_.-].*$/s, '');
  return n || name;
}

export async function executeTool(tool: ToolDef | undefined, call: ToolCall, ctx: ToolContext, timeoutMs: number) {
  if (!tool) return { ok: false, content: `Error: unknown tool "${call.name}". Use only the tools provided.`, summary: 'Unknown tool' };
  let args: unknown;
  try {
    args = parseArgs(call.arguments);
  } catch (e) {
    return { ok: false, content: `Error: ${(e as Error).message} Call ${call.name} again with valid JSON arguments.`, summary: 'Bad arguments' };
  }
  const parsed = tool.schema.safeParse(args);
  if (!parsed.success) {
    return { ok: false, content: `Error: invalid arguments for ${call.name}: ${z.prettifyError(parsed.error)}. Fix them and try again.`, summary: 'Bad arguments' };
  }
  // Risky actions wait for the user's approval first (outside the tool timeout).
  const card = tool.approval?.(parsed.data, ctx) ?? null;
  if (card) {
    if (!ctx.ask) {
      return { ok: false, content: `Error: ${call.name} needs the user's approval, but nobody can answer right now. Do not retry; tell the user what you would do and ask them to confirm in chat.`, summary: 'Needs approval' };
    }
    const r = await ctx.ask({ kind: 'approval', title: card.title, body: card.body, headline: card.headline, content: card.content, fields: card.fields, tool: call.name });
    if (r.decision === 'change') {
      return { ok: false, content: `The user did not approve yet and asked for changes: "${r.answer ?? ''}". Apply the changes and call ${call.name} again (they will be asked again).`, summary: 'Changes requested' };
    }
    if (r.decision !== 'approve') {
      const why = r.decision === 'deny' ? 'The user declined' : r.decision === 'expired' ? 'The user did not answer in time' : 'The request was cancelled';
      return { ok: false, content: `${why}. ${call.name} did NOT run. Do not retry unless the user asks.`, summary: r.decision === 'deny' ? 'Declined' : 'Not approved' };
    }
  }
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort(ctx.signal.reason);
  ctx.signal.addEventListener('abort', onAbort, { once: true });
  if (tool.timeoutMs) timeoutMs = tool.timeoutMs;
  const timer = setTimeout(() => ctrl.abort(new AppError('timeout', 'tool timeout')), timeoutMs);
  try {
    const res = await Promise.race([
      tool.handler(parsed.data, { ...ctx, signal: ctrl.signal }),
      new Promise<never>((_, reject) => ctrl.signal.addEventListener('abort', () => reject(ctrl.signal.reason ?? new Error('aborted')), { once: true })),
    ]);
    let content = res.content;
    for (const sec of ctx.secrets ?? []) if (sec.length >= 3) content = content.split(sec).join('[hidden]');
    return { ok: res.ok !== false, content, summary: res.summary ?? (res.ok === false ? 'Failed' : 'Done'), display: res.display };
  } catch (e) {
    if (ctx.signal.aborted) throw e;
    const msg = e instanceof AppError && e.code === 'timeout' && ctrl.signal.aborted ? `timed out after ${Math.round(timeoutMs / 1000)}s` : (e as Error)?.message ?? String(e);
    return { ok: false, content: `Error: ${call.name} failed: ${msg}. Tell the user honestly or try another approach.`, summary: `Failed: ${msg}`.slice(0, 80) };
  } finally {
    clearTimeout(timer);
    ctx.signal.removeEventListener('abort', onAbort);
  }
}

/** Short text with no code, list or table: progress talk, not an answer. */
export function isNarration(t: string): boolean {
  const s = t.trim();
  return s.length > 0 && s.length <= 400 && s.split('\n').filter((l) => l.trim()).length <= 3 && !/```|^\s*[-*\d]+[.)]?\s|\|.*\|/m.test(s);
}

/**
 * The tool-calling loop: stream the model's answer; when it asks for tools, run them (in parallel),
 * feed results back (errors included, so the model can recover) and continue, up to maxSteps.
 */
export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
  let specs = o.tools.map(toToolSpec);
  let byName = new Map(o.tools.map((t) => [t.name, t]));
  let escalate = o.escalate;
  let model = o.model;
  let firstByteMs = o.firstByteMs;
  const messages = [...o.messages];
  let text = '';
  let steps = 0;
  let toolCalls = 0;
  let finishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  const displays: ToolDisplay[] = [];
  let servedBy: { provider: string; model: string } | undefined;
  let finalText = '';
  let lastInterim = '';
  let kept = '';
  const failedTools: string[] = [];

  // what this run built, checked and failed (agent/craft.ts): no unverified build or hidden failure at the end
  const tracker = new WorkTracker((o.escalate?.tools ?? o.tools).map((t) => t.name));
  // tools that look at pictures (design_spec, match_design) use the same model as the turn
  if (!o.ctx.runLlm) o.ctx.runLlm = { provider: o.provider, model: o.escalate?.model ?? model };
  const lastUserMsg = [...o.messages].reverse().find((m) => m.role === 'user');
  if (lastUserMsg && typeof lastUserMsg.content === 'string') tracker.noteRequest(lastUserMsg.content);
  // a run resumed after a restart (or continued in the background) keeps what it already built and checked
  for (const m of o.messages) {
    for (const c of m.role === 'assistant' ? (m.toolCalls ?? []) : []) {
      const res = o.messages.find((x) => x.role === 'tool' && x.toolCallId === c.id)?.content ?? '';
      let a: unknown = {};
      try { a = JSON.parse(c.arguments || '{}'); } catch { /* keep {} */ }
      tracker.record(c.name, a, !/^(error|failed|not run yet)/i.test(res.trim()), res);
    }
  }
  let recoveries = 0;
  let emptyNudges = 0;
  let handedOff = false;
  let maxSteps = o.maxSteps;
  let amendRounds = 0;
  let providerWaits = 0;
  let waitedMs = 0;
  /** what the user said mid-work goes in as their own words (a user-side turn: Gemini drops mid-chat system messages) */
  const takeNotes = (): boolean => {
    let notes: Amendment[] = [];
    try {
      notes = o.takeNotes?.() ?? [];
    } catch {
      notes = [];
    }
    if (!notes.length) return false;
    messages.push({ role: 'user', content: amendmentNote(notes) });
    return true;
  };
  while (steps < maxSteps) {
    if (o.signal.aborted) throw new AppError('cancelled', 'Cancelled.');
    takeNotes();
    steps++;
    o.onEvent({ type: 'step', step: steps });
    // with a handoff the last step still gets tools; if it uses them, the work moves to the background
    const last = steps === maxSteps && !o.handoff;
    let stepText = '';
    const calls: ToolCall[] = [];
    finishReason = 'stop';
    try {
      for await (const chunk of o.provider.streamChat({
        model,
        messages: last ? [...messages, { role: 'system', content: BUDGET_NOTE }] : messages,
        maxOutputTokens: o.maxOutputTokens,
        temperature: o.temperature,
        signal: o.signal,
        fast: o.fast,
        tools: last || !specs.length ? undefined : specs,
        firstByteMs,
      })) {
        if (chunk.type === 'delta') {
          stepText += chunk.text;
          o.onEvent({ type: 'delta', text: chunk.text });
        } else if (chunk.type === 'tool_call') calls.push(chunk.call);
        else if (chunk.type === 'usage') {
          inputTokens += chunk.inputTokens ?? 0;
          outputTokens += chunk.outputTokens ?? 0;
        } else if (chunk.type === 'finish') finishReason = chunk.reason;
        else if (chunk.type === 'served') {
          servedBy = { provider: chunk.provider, model: chunk.model };
          o.onEvent({ type: 'served', provider: chunk.provider, model: chunk.model });
        }
      }
    } catch (e) {
      // Every model failed before this step sent anything, with an error that passes (a per-minute
      // limit, an overloaded model): wait and redo the step instead of throwing away the work so far.
      const budget = o.providerWaitMs ?? 0;
      if (o.signal.aborted || stepText || calls.length || !isPassingProviderError(e) || waitedMs >= budget) throw e;
      const wait = Math.min(PROVIDER_WAITS[Math.min(providerWaits, PROVIDER_WAITS.length - 1)]!, budget - waitedMs);
      providerWaits++;
      waitedMs += wait;
      console.warn(`[agent] step ${steps}: ${e.code} (${e.message.slice(0, 120)}); waiting ${Math.round(wait / 1000)}s and trying the step again`);
      o.onProviderWait?.(wait, e);
      await sleep(wait, o.signal);
      steps--;
      continue;
    }
    text += stepText;
    if (!calls.length && !stepText.trim() && (finishReason === 'length' ? recoveries < 2 : emptyNudges < 1)) {
      // Nothing came back: usually the output limit cut off a big tool call (finish "length"),
      // sometimes a thinking model ends a turn with only thoughts. Tell it and try again; these
      // retries don't use up the step budget.
      if (finishReason === 'length') recoveries++;
      else emptyNudges++;
      maxSteps++;
      messages.push({ role: 'system', content: finishReason === 'length' ? OUTPUT_LIMIT_NOTE : EMPTY_NOTE });
      continue;
    }
    if (!calls.length) {
      const gate = last || o.signal.aborted ? null : tracker.gate(stepText);
      if (gate) {
        // Not done yet: the build was never looked at, or a failure is being reported as success.
        // What it wrote becomes progress narration and it goes back to work (outside the step budget).
        if (stepText.trim()) {
          messages.push({ role: 'assistant', content: stepText });
          lastInterim = stepText;
          o.onEvent({ type: 'interim', text: /\s$/.test(stepText) ? stepText : `${stepText}\n\n` });
          if (!/\s$/.test(stepText)) text += '\n\n';
        }
        // as a user-side note: Gemini drops mid-chat system messages, and a chat ending on the model's own turn is a 400
        messages.push({ role: 'user', content: `[Note from the Orin system, not from the user] ${gate}` });
        maxSteps++;
        continue;
      }
      // The user wrote while this answer was being written: it becomes progress narration and the
      // work takes their message into account first (a few rounds at most, outside the step budget).
      if (!last && !o.signal.aborted && amendRounds < 3 && o.takeNotes) {
        const before = messages.length;
        messages.push({ role: 'assistant', content: stepText || '(still working)' });
        if (takeNotes()) {
          amendRounds++;
          if (stepText.trim()) {
            lastInterim = stepText;
            o.onEvent({ type: 'interim', text: /\s$/.test(stepText) ? stepText : `${stepText}\n\n` });
            if (!/\s$/.test(stepText)) text += '\n\n';
          }
          maxSteps++;
          continue;
        }
        messages.length = before;
      }
      finalText = stepText;
      break;
    }
    // the calls came through but the turn was cut off: the last one may be incomplete
    const cutOff = finishReason === 'length';

    // Keep ids unique even when a model reuses them.
    const seen = new Set<string>();
    for (const c of calls) {
      if (!c.id || seen.has(c.id)) c.id = `call_${steps}_${Math.random().toString(36).slice(2, 8)}`;
      seen.add(c.id);
      c.name = cleanToolName(c.name);
    }
    // quick lane: more_tools (or calling a full-toolkit tool directly) opens the full prompt and toolkit for the rest of this reply (no step spent)
    if (escalate && calls.some((c) => c.name === MORE_TOOLS || (!byName.has(c.name) && escalate!.tools.some((t) => t.name === c.name)))) {
      const more = byName.get(MORE_TOOLS);
      specs = escalate.tools.map(toToolSpec);
      byName = new Map(escalate.tools.map((t) => [t.name, t]));
      if (more) byName.set(MORE_TOOLS, more);
      const sysAt = messages.findIndex((m) => m.role === 'system');
      if (sysAt >= 0) messages[sysAt] = { role: 'system', content: escalate.system() };
      if (escalate.model) model = escalate.model;
      firstByteMs = escalate.firstByteMs;
      escalate = undefined;
      maxSteps++;
    }
    messages.push({ role: 'assistant', content: stepText, toolCalls: calls });
    if (stepText && !/\s$/.test(stepText)) {
      text += '\n\n';
      o.onEvent({ type: 'delta', text: '\n\n' });
    }
    if (stepText.trim()) {
      // Short lines before tool calls are progress narration ("Setting it up now"): shown as the
      // working line, kept out of the reply. Longer text is real content (an answer written before
      // a trailing tool call) and stays in the reply.
      if (isNarration(stepText)) {
        lastInterim = stepText;
        o.onEvent({ type: 'interim', text: /\s$/.test(stepText) ? stepText : `${stepText}\n\n` });
      } else kept += /\s$/.test(stepText) ? stepText : `${stepText}\n\n`;
    }
    toolCalls += calls.length;
    const runCall = async (call: ToolCall) => {
        const tool = byName.get(call.name);
        let label = `Using ${call.name}…`;
        let args: unknown = {};
        try {
          args = parseArgs(call.arguments);
          if (tool) label = tool.label(args as never);
        } catch {
          /* label stays generic */
        }
        o.onEvent({ type: 'tool_start', id: call.id, name: call.name, label: friendlyLabel(call.name, args, label), args });
        const started = Date.now();
        // shipping (publishing a site, building an APK) waits until the screens were looked at, once per run
        const held = tracker.preflight(call.name, args);
        const r = held ? ({ ok: true, content: held, summary: 'Checking the design first' } as Awaited<ReturnType<typeof executeTool>>) : await executeTool(tool, call, o.ctx, o.toolTimeoutMs);
        if (r.display) displays.push(r.display);
        if (!r.ok) failedTools.push(call.name);
        o.onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: r.ok, summary: friendlySummary(call.name, r.ok, r.summary), display: r.display, durationMs: Date.now() - started });
        return { call, r, args };
    };
    // Steps on one computer usually depend on each other (write a file, then run it): run those one
    // after another in the order the model gave them. Independent calls (searches, reads) stay parallel.
    const serial = calls.filter((c) => STATEFUL_TOOL.test(c.name)).length > 1;
    const results: Awaited<ReturnType<typeof runCall>>[] = [];
    if (serial) for (const call of calls) results.push(await runCall(call));
    else results.push(...(await Promise.all(calls.map(runCall))));
    const recovery: string[] = [];
    for (const { call, r, args } of results) {
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.content.slice(0, 24_000) });
      const note = tracker.record(call.name, args, r.ok, r.content);
      if (note && !recovery.includes(note)) recovery.push(note);
    }
    if (recovery.length) messages.push({ role: 'system', content: recovery.join('\n') });
    if (cutOff) messages.push({ role: 'system', content: OUTPUT_LIMIT_NOTE });
    finishReason = 'tool_calls';
    try {
      o.onCheckpoint?.(messages, steps);
    } catch {
      /* a failed checkpoint never stops the work */
    }
  }

  if (finishReason === 'tool_calls' && o.handoff && !o.signal.aborted) {
    // Out of steps with work still going: hand it on instead of stopping halfway.
    const note = await o.handoff(messages).catch(() => null);
    if (note) {
      handedOff = true;
      const sep = text && !/\s$/.test(text) ? '\n\n' : '';
      text += sep + note;
      o.onEvent({ type: 'delta', text: sep + note });
      finalText = note;
      finishReason = 'handoff';
    } else {
      // could not hand it on: one last step without tools, saying honestly where things stand
      let stepText = '';
      for await (const chunk of o.provider.streamChat({
        model,
        messages: [...messages, { role: 'system', content: BUDGET_NOTE }],
        maxOutputTokens: o.maxOutputTokens,
        temperature: o.temperature,
        signal: o.signal,
        fast: o.fast,
      })) {
        if (chunk.type === 'delta') {
          stepText += chunk.text;
          o.onEvent({ type: 'delta', text: chunk.text });
        } else if (chunk.type === 'usage') {
          inputTokens += chunk.inputTokens ?? 0;
          outputTokens += chunk.outputTokens ?? 0;
        }
      }
      text += stepText;
      finalText = stepText;
      finishReason = 'stop';
    }
  }
  const reply = (kept + finalText).trim() || lastInterim.trim();
  return { text, steps, toolCalls, finishReason, inputTokens, outputTokens, displays, servedBy, reply, failedTools, handedOff };
}
