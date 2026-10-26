import { AppError, providerHttpError } from '../../errors.js';
import { withTimeout, type FetchLike } from '../http.js';
import { readSSE } from '../sse.js';
import { outputCap } from '../outputCap.js';
import type { ChatChunk, ChatProvider, ChatRequest, ProviderMessage } from '../types.js';

interface Options {
  apiKey: string;
  baseUrl: string;
  timeoutMs: number;
  /** null leaves the model's default thinking behaviour. */
  thinkingBudget: number | null;
  fetchImpl?: FetchLike;
}

interface GeminiPart {
  text?: string;
  thought?: boolean;
  inlineData?: { mimeType: string; data: string };
}

interface GeminiStreamChunk {
  candidates?: { content?: { parts?: GeminiPart[] }; finishReason?: string }[];
  promptFeedback?: { blockReason?: string };
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { code?: number; message?: string; status?: string };
}

export function toGeminiContents(messages: ProviderMessage[]) {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n');
  const contents = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [
        ...(m.images ?? []).map((img) => ({ inlineData: { mimeType: img.mimeType, data: img.data } })),
        ...(m.content ? [{ text: m.content }] : []),
      ],
    }))
    .filter((c) => c.parts.length > 0);
  return { system, contents };
}

function mapFinish(reason: string | undefined): string | null {
  if (!reason || reason === 'FINISH_REASON_UNSPECIFIED') return null;
  if (reason === 'STOP') return 'stop';
  if (reason === 'MAX_TOKENS') return 'length';
  return reason.toLowerCase();
}

/**
 * Google Gemini API (generateContent, streamed as SSE). The key is free from Google AI Studio
 * (no card) and the Flash models read both text and images, which is why Orin defaults to it.
 */
export class GeminiChatProvider implements ChatProvider {
  readonly id = 'gemini';
  readonly displayName = 'Google Gemini';
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
    const { system, contents } = toGeminiContents(req.messages);
    const generationConfig: Record<string, unknown> = { maxOutputTokens: Math.min(req.maxOutputTokens, outputCap('generativelanguage.googleapis.com', req.model)) };
    if (req.temperature !== undefined) generationConfig.temperature = req.temperature;
    if (this.opts.thinkingBudget !== null) generationConfig.thinkingConfig = { thinkingBudget: this.opts.thinkingBudget };

    const url = `${this.opts.baseUrl}/models/${encodeURIComponent(req.model)}:streamGenerateContent?alt=sse`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.opts.apiKey },
        body: JSON.stringify({
          ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
          contents,
          generationConfig,
        }),
        signal,
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === 'TimeoutError') throw new AppError('timeout', 'Google Gemini took too long to respond.');
      if (e?.name === 'AbortError') throw new AppError('cancelled', 'The request was cancelled.');
      throw new AppError('provider_unavailable', 'Could not reach Google Gemini. Check the server network connection.');
    }
    if (!res.ok) {
      const snippet = await res.text().catch(() => '');
      // Gemini answers an invalid key with HTTP 400 + API_KEY_INVALID rather than 401.
      if (res.status === 400 && /API_KEY_INVALID|API key not valid/i.test(snippet)) {
        throw new AppError('invalid_api_key', 'Google Gemini rejected the API key. Check GEMINI_API_KEY in server/.env.');
      }
      if (res.status === 429) {
        throw new AppError(
          'provider_rate_limited',
          'The Gemini free tier limit was reached (requests per minute or per day). Wait a minute and try again, or switch to another free provider.',
        );
      }
      throw providerHttpError(res.status, 'Google Gemini', snippet);
    }
    if (!res.body) throw new AppError('provider_unavailable', 'Google Gemini returned an empty stream.');

    let sawText = false;
    let finish: string | null = null;
    for await (const ev of readSSE(res.body, signal)) {
      if (!ev.data) continue;
      let json: GeminiStreamChunk;
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (json.error) {
        if (json.error.code === 429) throw new AppError('provider_rate_limited', 'The Gemini free tier limit was reached. Try again shortly.');
        throw new AppError('provider_unavailable', 'Google Gemini stream error.');
      }
      if (json.promptFeedback?.blockReason) {
        throw new AppError('content_filtered', 'Google Gemini blocked this request under its safety policy.');
      }
      const cand = json.candidates?.[0];
      for (const part of cand?.content?.parts ?? []) {
        if (part.text && !part.thought) {
          sawText = true;
          yield { type: 'delta', text: part.text };
        }
      }
      if (json.usageMetadata) {
        yield {
          type: 'usage',
          inputTokens: json.usageMetadata.promptTokenCount,
          outputTokens: json.usageMetadata.candidatesTokenCount,
        };
      }
      finish = mapFinish(cand?.finishReason) ?? finish;
    }
    if (!sawText && finish && finish !== 'stop' && finish !== 'length') {
      throw new AppError('content_filtered', 'Google Gemini stopped without a reply (safety or recitation filter).');
    }
    if (finish) yield { type: 'finish', reason: finish };
  }
}
