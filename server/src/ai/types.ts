export type Role = 'system' | 'user' | 'assistant' | 'tool';

/** A function the model may call (JSON Schema parameters). */
export interface ToolSpec {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolCall {
  id: string;
  name: string;
  /** Raw JSON string as produced by the model. */
  arguments: string;
  /** Provider-specific data that must be echoed back (e.g. Gemini thought_signature in extra_content). */
  extra?: Record<string, unknown>;
}

export interface ImageInput {
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  /** Base64 without the data: prefix */
  data: string;
}

export interface ProviderMessage {
  role: Role;
  content: string;
  images?: ImageInput[];
  /** assistant turns that requested tools */
  toolCalls?: ToolCall[];
  /** tool result turns */
  toolCallId?: string;
  name?: string;
}

export interface ChatRequest {
  messages: ProviderMessage[];
  model: string;
  maxOutputTokens: number;
  temperature?: number;
  signal: AbortSignal;
  tools?: ToolSpec[];
  /** A voice call: answering quickly matters more than thinking long (Gemini thinks minimally). */
  fast?: boolean;
}

export type ChatChunk =
  | { type: 'delta'; text: string }
  | { type: 'usage'; inputTokens?: number; outputTokens?: number }
  | { type: 'finish'; reason: string }
  | { type: 'tool_call'; call: ToolCall }
  /** Emitted by the fallback chain before the first chunk: which provider/model actually answered. */
  | { type: 'served'; provider: string; model: string };

export interface ChatProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isDemo: boolean;
  readonly supportsVision: boolean;
  /** true when the provider accepts `tools` and can return tool calls. */
  readonly supportsTools?: boolean;
  streamChat(req: ChatRequest): AsyncIterable<ChatChunk>;
}

export interface VoiceInfo {
  id: string;
  name: string;
}

export interface TranscribeRequest {
  audio: Buffer;
  mimeType: string;
  filename: string;
  language?: string;
  /**
   * Voice call barge-in: what the assistant was saying while this was recorded (its voice can be
   * heard at the start) and about where the person starts talking, in seconds. Providers that
   * can't use these ignore them; the app also strips leading echo itself.
   */
  ignore?: string;
  speechAt?: number;
  signal: AbortSignal;
}

export interface SpeechRequest {
  text: string;
  voice: string;
  instructions?: string;
  signal: AbortSignal;
}

export interface VoiceProvider {
  readonly id: string;
  readonly sttModel: string;
  readonly ttsModel: string;
  /** false for speech-to-text-only providers (e.g. Groq Whisper); the app then speaks on-device. */
  readonly supportsTts: boolean;
  voices(): VoiceInfo[];
  defaultVoice(): string;
  transcribe(req: TranscribeRequest): Promise<{ text: string; durationSec?: number }>;
  speak(req: SpeechRequest): Promise<{ audio: Buffer; mimeType: string }>;
  /** Voice as it is made: resolves at the first audio (Gemini TTS). Optional. */
  speakStream?(req: SpeechRequest): Promise<import('./providers/geminiVoice.js').SpeechStream>;
  /** Epoch ms until which every TTS/STT model is resting after its quota ran out (0 = available). */
  restingUntil?(kind: 'tts' | 'stt'): number;
  /** The provider attempts behind the last call (model;status;ms), for Server-Timing. */
  lastTrace?: string[];
}

/** Collects a streaming response into a single string (used for titles). */
export async function completeText(provider: ChatProvider, req: ChatRequest): Promise<string> {
  let out = '';
  for await (const chunk of provider.streamChat(req)) {
    if (chunk.type === 'delta') out += chunk.text;
  }
  return out;
}
