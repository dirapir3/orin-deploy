import type { ChatChunk, ChatProvider, ChatRequest } from '../types.js';

export const DEMO_PREFIX = '**Demo mode.** This reply was written by a scripted demo responder, not by an AI model.';

/**
 * Clearly labelled demo responder for UI development without API keys.
 * Every response starts with DEMO_PREFIX and the stream metadata marks it as demo.
 * It never pretends to understand images or audio.
 */
export class DemoChatProvider implements ChatProvider {
  readonly id = 'demo';
  readonly displayName = 'Demo responder';
  readonly isDemo = true;
  readonly supportsVision = false;
  private readonly delayMs: number;

  constructor(delayMs = 18) {
    this.delayMs = delayMs;
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
    const isTitle = req.messages[0]?.content.startsWith('TITLE_REQUEST');
    if (isTitle) {
      yield { type: 'delta', text: 'Demo conversation' };
      yield { type: 'finish', reason: 'stop' };
      return;
    }
    const quoted = (lastUser?.content ?? '').slice(0, 160).replace(/\s+/g, ' ').trim();
    const imageNote = lastUser?.images?.length
      ? '\n\nYou attached an image. The demo responder **cannot see images**; nothing was analyzed.'
      : '';
    const text =
      `${DEMO_PREFIX}\n\nYou wrote: "${quoted || '(empty)'}"${imageNote}\n\n` +
      'To get real answers, add an API key to the server `.env` (see the README) and restart it. ' +
      'Meanwhile this reply lets you try streaming, Markdown and the chat controls:\n\n' +
      '- Tap **Stop** while text is streaming\n- Long-press a message to copy or edit it\n\n' +
      '```ts\nconst greeting = (name: string) => `Hello, ${name}!`;\n```';
    const tokens = text.match(/\S+\s*|\s+/g) ?? [];
    for (const tok of tokens) {
      if (req.signal.aborted) return;
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      yield { type: 'delta', text: tok };
    }
    yield { type: 'usage', inputTokens: 0, outputTokens: 0 };
    yield { type: 'finish', reason: 'stop' };
  }
}
