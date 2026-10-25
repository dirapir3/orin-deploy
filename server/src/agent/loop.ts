import { z } from 'zod';
import type { ChatProvider, ProviderMessage, ToolCall } from '../ai/types.js';
import { AppError } from '../errors.js';
import { toToolSpec, type ToolContext, type ToolDef, type ToolDisplay } from './tools/types.js';

export type AgentEvent =
  | { type: 'delta'; text: string }
  | { type: 'tool_start'; id: string; name: string; label: string; args: unknown }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; summary: string; display?: ToolDisplay; durationMs: number }
  | { type: 'step'; step: number }
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
  toolTimeoutMs: number;
  signal: AbortSignal;
  onEvent: (ev: AgentEvent) => void;
}

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
    const r = await ctx.ask({ kind: 'approval', title: card.title, body: card.body, fields: card.fields, tool: call.name });
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

/**
 * The tool-calling loop: stream the model's answer; when it asks for tools, run them (in parallel),
 * feed results back (errors included, so the model can recover) and continue, up to maxSteps.
 */
export async function runAgent(o: RunAgentOptions): Promise<RunAgentResult> {
  const specs = o.tools.map(toToolSpec);
  const byName = new Map(o.tools.map((t) => [t.name, t]));
  const messages = [...o.messages];
  let text = '';
  let steps = 0;
  let toolCalls = 0;
  let finishReason = 'stop';
  let inputTokens = 0;
  let outputTokens = 0;
  const displays: ToolDisplay[] = [];
  let servedBy: { provider: string; model: string } | undefined;

  while (steps < o.maxSteps) {
    if (o.signal.aborted) throw new AppError('cancelled', 'Cancelled.');
    steps++;
    o.onEvent({ type: 'step', step: steps });
    const last = steps === o.maxSteps;
    let stepText = '';
    const calls: ToolCall[] = [];
    for await (const chunk of o.provider.streamChat({
      model: o.model,
      messages: last ? [...messages, { role: 'system', content: 'Tool budget reached. Answer now with what you have, without calling tools.' }] : messages,
      maxOutputTokens: o.maxOutputTokens,
      temperature: o.temperature,
      signal: o.signal,
      tools: last || !specs.length ? undefined : specs,
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
    text += stepText;
    if (!calls.length) break;

    // Keep ids unique even when a model reuses them.
    const seen = new Set<string>();
    for (const c of calls) {
      if (!c.id || seen.has(c.id)) c.id = `call_${steps}_${Math.random().toString(36).slice(2, 8)}`;
      seen.add(c.id);
    }
    messages.push({ role: 'assistant', content: stepText, toolCalls: calls });
    if (stepText && !/\s$/.test(stepText)) {
      text += '\n\n';
      o.onEvent({ type: 'delta', text: '\n\n' });
    }
    toolCalls += calls.length;
    const results = await Promise.all(
      calls.map(async (call) => {
        const tool = byName.get(call.name);
        let label = `Using ${call.name}…`;
        let args: unknown = {};
        try {
          args = parseArgs(call.arguments);
          if (tool) label = tool.label(args as never);
        } catch {
          /* label stays generic */
        }
        o.onEvent({ type: 'tool_start', id: call.id, name: call.name, label, args });
        const started = Date.now();
        const r = await executeTool(tool, call, o.ctx, o.toolTimeoutMs);
        if (r.display) displays.push(r.display);
        o.onEvent({ type: 'tool_end', id: call.id, name: call.name, ok: r.ok, summary: r.summary, display: r.display, durationMs: Date.now() - started });
        return { call, r };
      }),
    );
    for (const { call, r } of results) {
      messages.push({ role: 'tool', toolCallId: call.id, name: call.name, content: r.content.slice(0, 24_000) });
    }
    finishReason = 'tool_calls';
  }
  return { text, steps, toolCalls, finishReason, inputTokens, outputTokens, displays, servedBy };
}
