import { dailyLimits } from './agentExtra.js';
import type { Request, Response } from 'express';
import type { Deps } from '../app.js';
import { AppError, toAppError } from '../errors.js';
import { logger } from '../logger.js';
import { agentIdOf, agentOwnerKey, requesterKey } from '../middleware/auth.js';
import type { ChatRequestBody } from '../schemas.js';
import { buildAgentContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import { isValidTimezone } from '../agent/cron.js';

function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function requestBaseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

/**
 * Agent chat over the same SSE protocol as plain chat, plus `tool` events:
 *   event: tool  data: {phase:'start', id, name, label}
 *   event: tool  data: {phase:'end', id, name, ok, summary, display?}
 */
export async function streamAgentChat(deps: Deps, req: Request, res: Response, body: ChatRequestBody) {
  const { config, usage } = deps;
  const agent = deps.agent!;
  const provider = deps.providers.agent!;
  const owner = agentOwnerKey(req);
  const account = requesterKey(req);
  const timezone = body.timezone && isValidTimezone(body.timezone) ? body.timezone : undefined;
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });
  const incognito = Boolean(body.incognito);
  if (agent.store.usageToday(account, 'chat') >= dailyLimits().chat) throw new AppError('rate_limited', `You've reached today's limit of ${dailyLimits().chat} messages. It resets at midnight UTC.`);
  const character = agentIdOf(req);
  const tools = agent.tools.available(owner, agent.services, { incognito });
  // Fails fast (before streaming) on images the model cannot read, etc.
  const ctx = await buildAgentContext(body, config, {
    store: agent.store,
    owner,
    provider,
    signal: controller.signal,
    persona: { timezone, tools: tools.map((t: { name: string }) => t.name), unavailable: agent.unavailable(owner), character, incognito },
  });
  const model = ctx.hasImages ? config.chat.visionModel : config.chat.model;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);
  const started = Date.now();
  let chars = 0;
  let served: { provider: string; model: string } = { provider: provider.id, model };
  sse(res, 'meta', { provider: provider.id, model, demo: false, agent: true, tools: tools.length, trimmedMessages: ctx.trimmed, summarized: ctx.summarized, incognito });
  agent.store.bumpUsage(account, 'chat');
  const toolCtx = agent.toolContext(owner, controller.signal, body.mode === 'voice' ? 'voice' : 'chat', requestBaseUrl(req), timezone);
  toolCtx.incognito = incognito;
  if (body.conversationId && !incognito) toolCtx.conversationId = body.conversationId;
  // Approval cards and questions are streamed into this conversation; the reply waits for the tap.
  toolCtx.ask = (input) =>
    agent.ask(owner, input, {
      signal: controller.signal,
      timeoutMs: 10 * 60_000,
      onCreated: (p) => sse(res, 'prompt', { id: p.id, kind: p.kind, title: p.title, body: p.body, fields: p.fields, choices: p.choices, tool: p.tool, expiresAt: p.expiresAt }),
    });
  try {
    const result = await runAgent({
      provider,
      model,
      messages: ctx.messages,
      tools,
      ctx: toolCtx,
      maxSteps: config.agent.maxSteps,
      maxOutputTokens: Math.max(config.chat.maxOutputTokens, provider.id === 'pollinations' ? 2048 : 0),
      toolTimeoutMs: config.agent.toolTimeoutMs,
      signal: controller.signal,
      onEvent: (ev) => {
        if (controller.signal.aborted) return;
        if (ev.type === 'delta') {
          chars += ev.text.length;
          sse(res, 'delta', { text: ev.text });
        } else if (ev.type === 'tool_start') sse(res, 'tool', { phase: 'start', id: ev.id, name: ev.name, label: ev.label });
        else if (ev.type === 'served') {
          served = { provider: ev.provider, model: ev.model };
          sse(res, 'served', served);
        } else if (ev.type === 'tool_end') sse(res, 'tool', { phase: 'end', id: ev.id, name: ev.name, ok: ev.ok, summary: ev.summary, display: ev.display, durationMs: ev.durationMs });
      },
    });
    if (controller.signal.aborted) {
      usage.record(req.auth, { kind: 'chat', provider: provider.id, model, status: 'cancelled', durationMs: Date.now() - started, units: chars });
      return;
    }
    if (chars === 0 && result.toolCalls === 0) throw new AppError('provider_unavailable', 'The AI provider returned an empty response.');
    if (chars === 0) {
      // The model used tools but wrote nothing; give the user something honest.
      const text = 'Done.';
      sse(res, 'delta', { text });
    }
    sse(res, 'done', {
      finishReason: result.finishReason === 'length' || result.finishReason === 'max_tokens' ? 'length' : 'stop',
      usage: { inputTokens: result.inputTokens || undefined, outputTokens: result.outputTokens || undefined },
      demo: false,
      steps: result.steps,
      toolCalls: result.toolCalls,
      ...(served.provider !== provider.id || served.model !== model ? { servedBy: served } : {}),
    });
    usage.record(req.auth, { kind: 'chat', provider: served.provider, model: served.model, status: 'ok', inputTokens: result.inputTokens || undefined, outputTokens: result.outputTokens || undefined, units: chars, durationMs: Date.now() - started });
  } catch (err) {
    const e = toAppError(err);
    if (e.code !== 'cancelled') logger.warn('agent chat failed', { code: e.code, provider: provider.id, message: e.message });
    usage.record(req.auth, { kind: 'chat', provider: provider.id, model, status: e.code === 'cancelled' ? 'cancelled' : 'error', durationMs: Date.now() - started, errorCode: e.code });
    if (!res.writableEnded && !controller.signal.aborted) sse(res, 'error', e.toJSON().error);
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
}
