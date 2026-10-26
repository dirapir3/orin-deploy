import { AppError } from '../../errors.js';
import { providerFetch, withTimeout, type FetchLike } from '../http.js';
import { readSSE } from '../sse.js';
import { outputCap } from '../outputCap.js';
import type { ChatChunk, ChatProvider, ChatRequest } from '../types.js';

interface Options {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

/** Anthropic Messages API (streaming). Supports text + image input. */
export class AnthropicChatProvider implements ChatProvider {
  readonly id = 'anthropic';
  readonly displayName = 'Anthropic';
  readonly isDemo = false;
  readonly supportsVision = true;
  private readonly opts: Options;
  private readonly fetchImpl: FetchLike;

  constructor(opts: Options) {
    this.opts = opts;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const signal = withTimeout(req.signal, this.opts.timeoutMs);
    const system = req.messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n');
    const messages = req.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: [
          ...(m.images ?? []).map((img) => ({
            type: 'image',
            source: { type: 'base64', media_type: img.mimeType, data: img.data },
          })),
          ...(m.content ? [{ type: 'text', text: m.content }] : []),
        ],
      }));

    const res = await providerFetch(this.fetchImpl, this.displayName, `${this.opts.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: req.model,
        max_tokens: Math.min(req.maxOutputTokens, outputCap(this.opts.baseUrl, req.model)),
        system: system || undefined,
        messages,
        stream: true,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      }),
      signal,
    });
    if (!res.body) throw new AppError('provider_unavailable', 'Anthropic returned an empty stream.');

    for await (const ev of readSSE(res.body, signal)) {
      if (!ev.data) continue;
      let json: {
        type?: string;
        delta?: { type?: string; text?: string; stop_reason?: string };
        message?: { usage?: { input_tokens?: number } };
        usage?: { output_tokens?: number };
        error?: { type?: string; message?: string };
      };
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      switch (json.type) {
        case 'message_start':
          yield { type: 'usage', inputTokens: json.message?.usage?.input_tokens };
          break;
        case 'content_block_delta':
          if (json.delta?.type === 'text_delta' && json.delta.text) yield { type: 'delta', text: json.delta.text };
          break;
        case 'message_delta':
          if (json.usage?.output_tokens !== undefined) yield { type: 'usage', outputTokens: json.usage.output_tokens };
          if (json.delta?.stop_reason) yield { type: 'finish', reason: json.delta.stop_reason };
          break;
        case 'error':
          if (json.error?.type === 'overloaded_error') throw new AppError('provider_unavailable', 'Anthropic is overloaded right now.');
          if (json.error?.type === 'rate_limit_error') throw new AppError('provider_rate_limited', 'Anthropic is rate limiting requests.');
          throw new AppError('provider_unavailable', 'Anthropic stream error.');
      }
    }
  }
}
