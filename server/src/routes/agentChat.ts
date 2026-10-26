import { dailyLimits } from './agentExtra.js';
import type { Request, Response } from 'express';
import type { Deps } from '../app.js';
import { AppError, toAppError } from '../errors.js';
import { logger } from '../logger.js';
import { agentIdOf, agentOwnerKey, requesterKey } from '../middleware/auth.js';
import type { UserProviders } from '../ai/userKeys.js';
import type { ChatRequestBody } from '../schemas.js';
import { buildAgentContext } from '../agent/context.js';
import { runAgent } from '../agent/loop.js';
import { isValidTimezone } from '../agent/cron.js';
import { chatRuns } from '../agent/chatRuns.js';
import { buildWorkContext } from '../agent/workContext.js';
import { offAppsNotice, withoutOffApps } from '../agent/apps.js';

/** A chat reply keeps working on the server when the app goes away, but not forever. */
const DETACHED_RUN_MS = 50 * 60_000;

export function requestBaseUrl(req: Request): string {
  return `${req.protocol}://${req.get('host') ?? 'localhost'}`;
}

/**
 * Agent chat over the same SSE protocol as plain chat, plus `tool` events:
 *   event: tool  data: {phase:'start', id, name, label}
 *   event: tool  data: {phase:'end', id, name, ok, summary, display?}
 */
export async function streamAgentChat(deps: Deps, req: Request, res: Response, body: ChatRequestBody, user: UserProviders | null = null) {
  const { config, usage } = deps;
  const agent = deps.agent!;
  // the user's own key first (its model is pinned inside), the server's keys as backup
  const provider = user?.agent ?? deps.providers.agent!;
  const owner = agentOwnerKey(req);
  const account = requesterKey(req);
  const timezone = body.timezone && isValidTimezone(body.timezone) ? body.timezone : undefined;
  if (agent.store.usageToday(account, 'chat') >= dailyLimits().chat) throw new AppError('rate_limited', `You've reached today's limit of ${dailyLimits().chat} messages. It resets at midnight UTC.`);
  const incognito = Boolean(body.incognito);
  const conversationId = body.conversationId && !incognito ? body.conversationId : null;
  // The run belongs to the server, not to this connection: closing the app or losing the network
  // does not stop it (the app can pick it up again, see chatRuns.ts). Stop goes through
  // POST /v1/agent/runs/:id/cancel.
  const run = chatRuns.create(owner, account, body.replyId ?? null, conversationId);
  run.incognito = incognito;
  const controller = run.controller;
  const sse = (_res: Response, event: string, data: unknown) => run.emit(event, data);
  const limit = setTimeout(() => controller.abort(), DETACHED_RUN_MS);
  limit.unref?.();
  const character = agentIdOf(req);
  run.topic = [...body.messages].reverse().find((m) => m.role === 'user')?.content.slice(0, 160) ?? '';
  // One work picture for text and voice: running/recent tasks, other replies still working, cards waiting.
  let work: string | undefined;
  if (!incognito) {
    try {
      work = buildWorkContext(agent.store, owner, { conversationId, mode: body.mode === 'voice' ? 'voice' : 'chat', replies: chatRuns.listActive(owner, run.id) });
    } catch {
      work = undefined;
    }
  }
  // apps the user turned off for this character on the Apps page are not offered (chat and calls)
  const appsOff = agent.store.appsOff(owner);
  const tools = withoutOffApps(agent.tools.available(owner, agent.services, { incognito }), appsOff);
  // Fails fast (before streaming) on images the model cannot read, etc.
  let ctx: Awaited<ReturnType<typeof buildAgentContext>>;
  try {
    ctx = await buildAgentContext(body, config, {
      store: agent.store,
      owner,
      provider,
      signal: controller.signal,
      persona: { timezone, tools: tools.map((t: { name: string }) => t.name), unavailable: [...agent.unavailable(owner), ...offAppsNotice(appsOff)], character, incognito, work },
    });
  } catch (err) {
    clearTimeout(limit);
    run.end();
    throw err;
  }
  const model = ctx.hasImages ? config.chat.visionModel : config.chat.model;

  res.status(200);
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
  run.attach(res, 0);
  const started = Date.now();
  let chars = 0;
  let served: { provider: string; model: string } = { provider: provider.id, model };
  sse(res, 'meta', { runId: run.id, provider: provider.id, model, demo: false, agent: true, tools: tools.length, trimmedMessages: ctx.trimmed, summarized: ctx.summarized, incognito });
  agent.store.bumpUsage(account, 'chat');
  const toolCtx = agent.toolContext(owner, controller.signal, body.mode === 'voice' ? 'voice' : 'chat', requestBaseUrl(req), timezone);
  toolCtx.incognito = incognito;
  if (conversationId) toolCtx.conversationId = conversationId;
  // Approval cards and questions are streamed into this conversation; the reply waits for the tap.
  toolCtx.ask = (input) =>
    agent.ask(owner, input, {
      signal: controller.signal,
      timeoutMs: 10 * 60_000,
      linkId: `reply:${run.id}`,
      onCreated: (p) => sse(res, 'prompt', { id: p.id, kind: p.kind, title: p.title, body: p.body, headline: p.headline, content: p.content, url: p.url, secret: p.secret, fields: p.fields, choices: p.choices, tool: p.tool, expiresAt: p.expiresAt }),
    });
  try {
    const result = await runAgent({
      provider,
      model,
      messages: ctx.messages,
      tools,
      ctx: toolCtx,
      maxSteps: body.mode === 'voice' ? Math.min(config.agent.maxSteps, 12) : config.agent.maxSteps,
      maxOutputTokens: config.agent.maxOutputTokens,
      toolTimeoutMs: config.agent.toolTimeoutMs,
      signal: controller.signal,
      // out of steps with work still going: carry on as a background task instead of stopping
      handoff: incognito
        ? undefined
        : async (msgs) => {
            const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
            const title = lastUser.replace(/\s+/g, ' ').trim().slice(0, 80) || 'Carrying on';
            run.handedOff = true; // Activity lists the background task from here on, not this reply
            return agent.continueInBackground(owner, { title, prompt: lastUser, messages: msgs, conversationId, timezone });
          },
      onEvent: (ev) => {
        if (controller.signal.aborted) return;
        if (ev.type === 'delta') {
          chars += ev.text.length;
          sse(res, 'delta', { text: ev.text });
        } else if (ev.type === 'interim') sse(res, 'interim', { text: ev.text });
        else if (ev.type === 'tool_start') {
          run.noteStep(ev.label || ev.name.replace(/_/g, ' '));
          sse(res, 'tool', { phase: 'start', id: ev.id, name: ev.name, label: ev.label });
        } else if (ev.type === 'served') {
          served = { provider: ev.provider, model: ev.model };
          sse(res, 'served', served);
        } else if (ev.type === 'tool_end') sse(res, 'tool', { phase: 'end', id: ev.id, name: ev.name, ok: ev.ok, summary: ev.summary, display: ev.display, durationMs: ev.durationMs });
      },
    });
    if (controller.signal.aborted) {
      run.outcome = { status: 'cancelled' };
      usage.record(req.auth, { kind: 'chat', provider: provider.id, model, status: 'cancelled', durationMs: Date.now() - started, units: chars });
      return;
    }
    if (chars === 0 && result.toolCalls === 0) throw new AppError('provider_unavailable', 'The AI provider returned an empty response.');
    // The reply the app keeps: the final answer without the narration written between tool calls.
    // When the model wrote nothing after using tools, say honestly how it went instead of a bare "Done."
    let reply = result.reply;
    if (!reply) {
      reply = result.failedTools.length ? "Some steps didn't work, and I stopped before finishing. Ask me to try again, or tell me what to change." : 'Done.';
      if (chars === 0) sse(res, 'delta', { text: reply });
    }
    run.outcome = { status: !result.reply && result.failedTools.length ? 'failed' : 'done', result: reply };
    deliverIfAway(reply);
    sse(res, 'done', {
      finishReason: result.finishReason === 'length' || result.finishReason === 'max_tokens' ? 'length' : 'stop',
      usage: { inputTokens: result.inputTokens || undefined, outputTokens: result.outputTokens || undefined },
      demo: false,
      steps: result.steps,
      toolCalls: result.toolCalls,
      reply,
      ...(served.provider !== provider.id || served.model !== model ? { servedBy: served } : {}),
    });
    usage.record(req.auth, { kind: 'chat', provider: served.provider, model: served.model, status: 'ok', inputTokens: result.inputTokens || undefined, outputTokens: result.outputTokens || undefined, units: chars, durationMs: Date.now() - started });
  } catch (err) {
    const e = toAppError(err);
    if (e.code !== 'cancelled') logger.warn('agent chat failed', { code: e.code, provider: provider.id, message: e.message });
    usage.record(req.auth, { kind: 'chat', provider: provider.id, model, status: e.code === 'cancelled' ? 'cancelled' : 'error', durationMs: Date.now() - started, errorCode: e.code });
    run.outcome = controller.signal.aborted ? { status: 'cancelled' } : { status: 'failed', error: e.message };
    if (!controller.signal.aborted) {
      deliverIfAway(`I ran into a problem and couldn't finish: ${e.message}`);
      sse(res, 'error', e.toJSON().error);
    }
  } finally {
    clearTimeout(limit);
    run.end(); // ends every attached stream
    if (!res.writableEnded) res.end();
  }

  /** Nobody is watching (app closed or in the background): put the reply in the inbox for the phone. */
  function deliverIfAway(text: string) {
    if (run.attached || !conversationId) return;
    try {
      agent.store.addInbox(owner, 'reply', 'Reply', text, conversationId, run.replyId ?? undefined);
    } catch (err) {
      logger.warn('could not save a reply for later', { err: String(err) });
    }
  }
}
