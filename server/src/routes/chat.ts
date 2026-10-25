import { Router, type Request, type Response } from 'express';
import { buildContext } from '../ai/context.js';
import { cleanTitle, fallbackTitle } from '../ai/prompt.js';
import { completeText } from '../ai/types.js';
import type { Deps } from '../app.js';
import { AppError, toAppError } from '../errors.js';
import { logger } from '../logger.js';
import { ChatRequestSchema, TitleRequestSchema } from '../schemas.js';
import { parseBody } from './util.js';
import { requesterKey } from '../middleware/auth.js';
import { streamAgentChat } from './agentChat.js';
import { AI_HEADER, requestAi, type UserProviders } from '../ai/userKeys.js';

function sse(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

export function chatRouter(deps: Deps) {
  const r = Router();
  const { config, providers, usage } = deps;

  r.post('/', async (req: Request, res: Response, next) => {
    let body;
    let user: UserProviders | null = null;
    try {
      body = parseBody(ChatRequestSchema, req.body);
      // the user's own key (Profile > AI keys), read from the vault; the server's keys are the backup
      user = requestAi(deps, requesterKey(req), req.get(AI_HEADER));
      if (!providers.chat && !user) {
        throw new AppError(
          'provider_not_configured',
          deps.config.chat.provider !== 'none' && !deps.config.chat.ready
            ? `${deps.config.chat.displayName} is selected but its API key is missing in server/.env. Add the key and restart the server.`
            : 'No AI model is connected yet. The quickest free option: get a free Gemini key at aistudio.google.com, put GEMINI_API_KEY in server/.env and restart. Or run Ollama locally with AI_PROVIDER=ollama (no key).',
        );
      }
    } catch (err) {
      return next(err);
    }
    if (deps.agent && (deps.agent.enabled || (config.agent.enabled && user?.agent)) && (user?.agent ?? providers.agent) && body.agent !== false) {
      return streamAgentChat(deps, req, res, body, user).catch(next);
    }
    const provider = user?.chat ?? providers.chat!;
    let ctx;
    try {
      ctx = buildContext(body, config, { allowImages: provider.supportsVision || provider.isDemo });
    } catch (err) {
      return next(err);
    }
    const model = provider.isDemo ? 'demo' : ctx.hasImages ? config.chat.visionModel : config.chat.model;

    const controller = new AbortController();
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 15_000);

    const started = Date.now();
    let inputTokens: number | undefined;
    let outputTokens: number | undefined;
    let finishReason = 'stop';
    let chars = 0;
    let served: { provider: string; model: string } = { provider: provider.id, model };
    sse(res, 'meta', { provider: provider.id, model, demo: provider.isDemo, trimmedMessages: ctx.trimmed });
    try {
      for await (const chunk of provider.streamChat({
        messages: ctx.messages,
        model,
        maxOutputTokens: config.chat.maxOutputTokens,
        signal: controller.signal,
      })) {
        if (controller.signal.aborted) break;
        if (chunk.type === 'delta') {
          chars += chunk.text.length;
          sse(res, 'delta', { text: chunk.text });
        } else if (chunk.type === 'usage') {
          inputTokens = chunk.inputTokens ?? inputTokens;
          outputTokens = chunk.outputTokens ?? outputTokens;
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason;
        } else if (chunk.type === 'served') {
          served = { provider: chunk.provider, model: chunk.model };
          sse(res, 'served', served);
        }
      }
      if (controller.signal.aborted) {
        usage.record(req.auth, { kind: 'chat', provider: provider.id, model, status: 'cancelled', durationMs: Date.now() - started, units: chars });
        return;
      }
      if (chars === 0) throw new AppError('provider_unavailable', 'The AI provider returned an empty response.');
      sse(res, 'done', {
        finishReason: finishReason === 'length' || finishReason === 'max_tokens' ? 'length' : finishReason,
        usage: { inputTokens, outputTokens },
        demo: provider.isDemo,
        ...(served.provider !== provider.id || served.model !== model ? { servedBy: served } : {}),
      });
      usage.record(req.auth, {
        kind: 'chat',
        provider: served.provider,
        model: served.model,
        status: 'ok',
        inputTokens,
        outputTokens,
        units: chars,
        durationMs: Date.now() - started,
      });
    } catch (err) {
      const e = toAppError(err);
      if (e.code !== 'cancelled') logger.warn('chat stream failed', { code: e.code, provider: provider.id });
      usage.record(req.auth, { kind: 'chat', provider: provider.id, model, status: e.code === 'cancelled' ? 'cancelled' : 'error', durationMs: Date.now() - started, errorCode: e.code });
      if (!res.writableEnded && !controller.signal.aborted) sse(res, 'error', e.toJSON().error);
    } finally {
      clearInterval(heartbeat);
      if (!res.writableEnded) res.end();
    }
  });

  r.post('/title', async (req, res, next) => {
    try {
      const body = parseBody(TitleRequestSchema, req.body);
      const firstUser = body.messages.find((m) => m.role === 'user')?.content ?? '';
      const fallback = fallbackTitle(firstUser);
      let provider = providers.chat;
      try {
        provider = requestAi(deps, requesterKey(req), req.get(AI_HEADER))?.chat ?? provider;
      } catch {
        // an unreadable key never blocks a title
      }
      if (!provider || provider.isDemo) return res.json({ title: fallback, source: 'fallback' });
      const started = Date.now();
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 12_000);
        const raw = await completeText(provider, {
          model: config.chat.titleModel,
          // reasoning models (Pollinations' GPT-OSS) spend tokens thinking before the title
          maxOutputTokens: provider.id === 'pollinations' ? 600 : 24,
          temperature: 0.3,
          signal: controller.signal,
          messages: [
            {
              role: 'system',
              content:
                'Write a short title (2 to 6 words) for this conversation. Reply with the title only, no quotes, no punctuation at the end.' +
                (body.language ? ` Write it in the language with code "${body.language}".` : ' Use the language of the conversation.'),
            },
            { role: 'user', content: body.messages.map((m) => `${m.role}: ${m.content.slice(0, 2000)}`).join('\n') },
          ],
        });
        clearTimeout(timer);
        const title = cleanTitle(raw);
        usage.record(req.auth, { kind: 'title', provider: provider.id, model: config.chat.titleModel, status: 'ok', durationMs: Date.now() - started });
        return res.json(title ? { title, source: 'ai' } : { title: fallback, source: 'fallback' });
      } catch (err) {
        const e = toAppError(err);
        usage.record(req.auth, { kind: 'title', provider: provider.id, model: config.chat.titleModel, status: 'error', durationMs: Date.now() - started, errorCode: e.code });
        return res.json({ title: fallback, source: 'fallback' });
      }
    } catch (err) {
      next(err);
    }
  });

  return r;
}
