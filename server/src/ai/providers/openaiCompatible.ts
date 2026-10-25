import { AppError } from '../../errors.js';
import { providerFetch, withTimeout, type FetchLike } from '../http.js';
import { readSSE } from '../sse.js';
import type {
  ChatChunk,
  ChatProvider,
  ChatRequest,
  ProviderMessage,
  SpeechRequest,
  TranscribeRequest,
  VoiceInfo,
  VoiceProvider,
} from '../types.js';

interface ChatOptions {
  id: string;
  displayName: string;
  apiKey: string;
  baseUrl: string;
  supportsVision: boolean;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  timeoutMs: number;
  /** Extra headers, e.g. OpenRouter's optional attribution headers. */
  extraHeaders?: Record<string, string>;
  /** false for endpoints that reject `tools` (default true). */
  supportsTools?: boolean;
  /** some endpoints (e.g. Pollinations) reject stream_options */
  streamOptions?: boolean;
  /**
   * Max requests in flight at once from this server. Pollinations' anonymous tier answers a
   * second concurrent request with 429 instead of queuing it, so we queue locally.
   */
  maxConcurrent?: number;
  /** How many times to retry a 429 (before any output) with backoff. Default 0. */
  rateLimitRetries?: number;
  /** Base backoff for rateLimitRetries, doubled each attempt. Default 2000 ms. */
  rateLimitBackoffMs?: number;
  fetchImpl?: FetchLike;
}

/** Tiny FIFO semaphore. */
class Gate {
  private active = 0;
  private readonly waiters: (() => void)[] = [];
  constructor(private readonly max: number) {}
  async acquire(signal: AbortSignal): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = this.waiters.indexOf(go);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(new AppError('cancelled', 'The request was cancelled.'));
      };
      const go = () => {
        signal.removeEventListener('abort', onAbort);
        this.active++;
        resolve();
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.push(go);
    });
  }
  release(): void {
    this.active = Math.max(0, this.active - 1);
    const next = this.waiters.shift();
    if (next) next();
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new AppError('cancelled', 'The request was cancelled.'));
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new AppError('cancelled', 'The request was cancelled.'));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function authHeaders(apiKey: string): Record<string, string> {
  // Local servers such as Ollama need no key; send no Authorization header then.
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

export function toOpenAIMessage(m: ProviderMessage): Record<string, unknown> {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId ?? '', content: m.content };
  if (m.role === 'assistant' && m.toolCalls?.length) {
    return {
      role: 'assistant',
      content: m.content || null,
      tool_calls: m.toolCalls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments || '{}' },
        ...(c.extra ? { extra_content: c.extra } : {}),
      })),
    };
  }
  if (!m.images?.length) return { role: m.role, content: m.content };
  return {
    role: m.role,
    content: [
      ...(m.content ? [{ type: 'text', text: m.content }] : []),
      ...m.images.map((img) => ({ type: 'image_url', image_url: { url: `data:${img.mimeType};base64,${img.data}` } })),
    ],
  };
}

/** Works with OpenAI and any server implementing the OpenAI Chat Completions API (Groq, OpenRouter, Together, Ollama, vLLM...). */
export class OpenAICompatibleChatProvider implements ChatProvider {
  readonly isDemo = false;
  readonly id: string;
  readonly displayName: string;
  readonly supportsVision: boolean;
  readonly supportsTools: boolean;
  private readonly opts: ChatOptions;
  private readonly fetchImpl: FetchLike;

  constructor(opts: ChatOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.displayName = opts.displayName;
    this.supportsVision = opts.supportsVision;
    this.supportsTools = opts.supportsTools ?? true;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.gate = opts.maxConcurrent && opts.maxConcurrent > 0 ? new Gate(opts.maxConcurrent) : null;
  }

  private readonly gate: Gate | null;

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    if (this.gate) await this.gate.acquire(req.signal);
    try {
      const retries = this.opts.rateLimitRetries ?? 0;
      for (let attempt = 0; ; attempt++) {
        let yielded = false;
        try {
          for await (const chunk of this.streamChatOnce(req)) {
            yielded = true;
            yield chunk;
          }
          return;
        } catch (err) {
          const e = err as AppError;
          if (yielded || attempt >= retries || !(e instanceof AppError) || e.code !== 'provider_rate_limited' || e.retryable === false) throw err;
          await sleep((this.opts.rateLimitBackoffMs ?? 2000) * 2 ** attempt, req.signal);
        }
      }
    } finally {
      this.gate?.release();
    }
  }

  private async *streamChatOnce(req: ChatRequest): AsyncIterable<ChatChunk> {
    const signal = withTimeout(req.signal, this.opts.timeoutMs);
    const body: Record<string, unknown> = {
      model: req.model,
      messages: req.messages.map((m) => {
        const out = toOpenAIMessage(m);
        // Gemini 3 rejects tool-call turns without a thought signature. Calls made by another
        // provider (after a fallback) have none, so use Google's documented skip value.
        if (this.opts.baseUrl.includes('generativelanguage.googleapis.com') && Array.isArray(out.tool_calls)) {
          out.tool_calls = (out.tool_calls as Record<string, unknown>[]).map((tc) =>
            tc.extra_content ? tc : { ...tc, extra_content: { google: { thought_signature: 'skip_thought_signature_validator' } } },
          );
        }
        return out;
      }),
      stream: true,
      [this.opts.maxTokensParam]: req.maxOutputTokens,
    };
    if (this.opts.streamOptions !== false) body.stream_options = { include_usage: true };
    // OpenAI reasoning models (o-series, gpt-5/gpt-6) reject a custom temperature.
    if (req.temperature !== undefined && !/^(o\d|gpt-5|gpt-6)/.test(req.model)) body.temperature = req.temperature;
    if (req.tools?.length && this.supportsTools) {
      body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
      body.tool_choice = 'auto';
    }

    const res = await providerFetch(this.fetchImpl, this.displayName, `${this.opts.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(this.opts.apiKey), ...(this.opts.extraHeaders ?? {}) },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.body) throw new AppError('provider_unavailable', `${this.displayName} returned an empty stream.`);

    // Tool calls arrive in fragments keyed by index; assemble them and emit once complete.
    const pending = new Map<number, { id: string; name: string; arguments: string; extra?: Record<string, unknown> }>();
    const think = new ThinkFilter();
    const flushTools = function* (): Generator<ChatChunk> {
      for (const [, c] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        if (c.name) yield { type: 'tool_call', call: { id: c.id || `call_${Math.random().toString(36).slice(2, 10)}`, name: c.name, arguments: c.arguments, ...(c.extra ? { extra: c.extra } : {}) } };
      }
      pending.clear();
    };
    for await (const ev of readSSE(res.body, signal)) {
      if (!ev.data || ev.data === '[DONE]') continue;
      let json: {
        choices?: {
          // `reasoning` / `reasoning_content` (gpt-oss, DeepSeek...) are private thinking: never shown.
          delta?: {
            content?: string | null;
            reasoning?: string | null;
            reasoning_content?: string | null;
            tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string }; extra_content?: Record<string, unknown> }[];
          };
          finish_reason?: string | null;
        }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
        error?: { message?: string };
      };
      try {
        json = JSON.parse(ev.data);
      } catch {
        continue;
      }
      if (json.error) throw new AppError('provider_unavailable', `${this.displayName} stream error.`);
      const choice = json.choices?.[0];
      for (const tc of choice?.delta?.tool_calls ?? []) {
        let idx = tc.index ?? 0;
        // Gemini's OpenAI endpoint sends parallel calls without distinct indexes; a new id is a new call.
        if (tc.id) {
          const same = [...pending.entries()].find(([, c]) => c.id === tc.id);
          const prev = pending.get(idx);
          if (same) idx = same[0];
          else if (prev && prev.id && prev.id !== tc.id) idx = Math.max(...pending.keys()) + 1;
        }
        const cur = pending.get(idx) ?? { id: '', name: '', arguments: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.arguments += tc.function.arguments;
        if (tc.extra_content) cur.extra = { ...(cur.extra ?? {}), ...tc.extra_content };
        pending.set(idx, cur);
      }
      const raw = choice?.delta?.content;
      const text = raw ? think.push(raw) : '';
      if (text) yield { type: 'delta', text };
      if (choice?.finish_reason) {
        yield* flushTools();
        yield { type: 'finish', reason: choice.finish_reason };
      }
      if (json.usage) {
        yield { type: 'usage', inputTokens: json.usage.prompt_tokens, outputTokens: json.usage.completion_tokens };
      }
    }
    const tail = think.flush();
    if (tail) yield { type: 'delta', text: tail };
    yield* flushTools();
  }
}

/** Removes inline <think>...</think> blocks some open models put in `content`. */
export class ThinkFilter {
  private inThink = false;
  private buf = '';
  flush(): string {
    const rest = this.inThink ? '' : this.buf;
    this.buf = '';
    return rest;
  }
  push(chunk: string): string {
    this.buf += chunk;
    let out = '';
    for (;;) {
      if (this.inThink) {
        const end = this.buf.indexOf('</think>');
        if (end === -1) {
          this.buf = this.buf.slice(-8);
          return out;
        }
        this.buf = this.buf.slice(end + 8).replace(/^\s+/, '');
        this.inThink = false;
      } else {
        const start = this.buf.indexOf('<think>');
        if (start === -1) {
          // keep a possible partial "<think" at the end
          const lt = this.buf.lastIndexOf('<');
          if (lt !== -1 && '<think>'.startsWith(this.buf.slice(lt))) {
            out += this.buf.slice(0, lt);
            this.buf = this.buf.slice(lt);
          } else {
            out += this.buf;
            this.buf = '';
          }
          return out;
        }
        out += this.buf.slice(0, start);
        this.buf = this.buf.slice(start + 7);
        this.inThink = true;
      }
    }
  }
}

/** Voices documented for OpenAI's speech endpoint at time of writing; override with TTS_VOICES. */
const OPENAI_TTS_VOICES: Record<string, string[]> = {
  'tts-1': ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
  'tts-1-hd': ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'],
  default: ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'],
};

interface VoiceOptions {
  id: string;
  apiKey: string;
  baseUrl: string;
  sttModel: string;
  ttsModel: string;
  voices: string[];
  defaultVoice: string;
  timeoutMs: number;
  fetchImpl?: FetchLike;
}

export class OpenAICompatibleVoiceProvider implements VoiceProvider {
  readonly id: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  private readonly opts: VoiceOptions;
  private readonly fetchImpl: FetchLike;

  constructor(opts: VoiceOptions) {
    this.opts = opts;
    this.id = opts.id;
    this.sttModel = opts.sttModel;
    this.ttsModel = opts.ttsModel;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  get supportsTts(): boolean {
    return this.ttsModel.length > 0;
  }

  voices(): VoiceInfo[] {
    if (!this.supportsTts) return [];
    const ids = this.opts.voices.length
      ? this.opts.voices
      : (OPENAI_TTS_VOICES[this.ttsModel] ?? OPENAI_TTS_VOICES.default ?? []);
    return ids.map((id) => ({ id, name: id.charAt(0).toUpperCase() + id.slice(1) }));
  }

  defaultVoice(): string {
    const list = this.voices();
    return list.find((v) => v.id === this.opts.defaultVoice)?.id ?? list[0]?.id ?? 'alloy';
  }

  async transcribe(req: TranscribeRequest): Promise<{ text: string }> {
    const form = new FormData();
    form.append('model', this.sttModel);
    form.append('file', new Blob([new Uint8Array(req.audio)], { type: req.mimeType }), req.filename);
    form.append('response_format', 'json');
    if (req.language) form.append('language', req.language);
    const res = await providerFetch(this.fetchImpl, 'Speech-to-text provider', `${this.opts.baseUrl}/audio/transcriptions`, {
      method: 'POST',
      headers: authHeaders(this.opts.apiKey),
      body: form,
      signal: withTimeout(req.signal, this.opts.timeoutMs),
    });
    const json = (await res.json()) as { text?: string };
    return { text: (json.text ?? '').trim() };
  }

  async speak(req: SpeechRequest): Promise<{ audio: Buffer; mimeType: string }> {
    if (!this.supportsTts) {
      throw new AppError('voice_not_configured', 'This server has speech-to-text only. Orin speaks replies with the voices on your device.');
    }
    const body: Record<string, unknown> = {
      model: this.ttsModel,
      input: req.text,
      voice: req.voice,
      response_format: 'mp3',
    };
    // Only the newer gpt-4o*-tts models accept style instructions.
    if (req.instructions && this.ttsModel.includes('gpt-4o')) body.instructions = req.instructions;
    const res = await providerFetch(this.fetchImpl, 'Text-to-speech provider', `${this.opts.baseUrl}/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(this.opts.apiKey) },
      body: JSON.stringify(body),
      signal: withTimeout(req.signal, this.opts.timeoutMs),
    });
    const audio = Buffer.from(await res.arrayBuffer());
    if (audio.length === 0) throw new AppError('provider_unavailable', 'Text-to-speech returned no audio.');
    return { audio, mimeType: 'audio/mpeg' };
  }
}
