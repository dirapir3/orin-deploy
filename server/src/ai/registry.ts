import type { AppConfig, ChainEntry } from '../config.js';
import { FallbackChatProvider, type FallbackCandidate } from './fallback.js';
import { keyId, sharedKeyHealth } from './keyHealth.js';
import type { FetchLike } from './http.js';
import { AnthropicChatProvider } from './providers/anthropic.js';
import { DemoChatProvider } from './providers/demo.js';
import { GeminiChatProvider } from './providers/gemini.js';
import { OpenAICompatibleChatProvider, OpenAICompatibleVoiceProvider } from './providers/openaiCompatible.js';
import { GeminiVoiceProvider } from './providers/geminiVoice.js';
import { DeepgramVoiceProvider, ElevenLabsVoiceProvider, SplitVoiceProvider } from './providers/voiceExtra.js';
import type { ChatProvider, VoiceProvider } from './types.js';

export interface Providers {
  /** null when no provider is ready and demo mode is off */
  chat: ChatProvider | null;
  /** Optional server speech upgrade. The app's default voice path is on-device and needs none. */
  voice: VoiceProvider | null;
  /**
   * Tool-capable provider for the agent runtime (null when no configured provider can call tools).
   * For Gemini and Anthropic this uses their OpenAI-compatible endpoints, which support function calling.
   */
  agent: ChatProvider | null;
}

/** gemini-2.5-flash thinks by default and the thinking counts against the output budget; turn it off unless asked. */
export function geminiThinkingBudget(model: string, configured: number | null): number | null {
  if (configured !== null) return configured;
  return /gemini-2\.5-flash/.test(model) ? 0 : null;
}

/**
 * One concrete provider for one entry of the chain and one key.
 * `forAgent` = must support tool calling (Gemini/Anthropic switch to their OpenAI-compatible APIs).
 */
export function entryProvider(entry: ChainEntry, apiKey: string, forAgent: boolean, fetchImpl?: FetchLike): ChatProvider {
  const common = { displayName: entry.displayName, timeoutMs: entry.timeoutMs, fetchImpl };
  switch (entry.provider) {
    case 'gemini':
      if (forAgent) {
        return new OpenAICompatibleChatProvider({ ...common, id: 'gemini', apiKey, baseUrl: `${entry.baseUrl}/openai`, supportsVision: true, maxTokensParam: 'max_tokens' });
      }
      return new GeminiChatProvider({ apiKey, baseUrl: entry.baseUrl, timeoutMs: entry.timeoutMs, thinkingBudget: geminiThinkingBudget(entry.model, entry.thinkingBudget), fetchImpl });
    case 'anthropic':
      if (forAgent) {
        return new OpenAICompatibleChatProvider({ ...common, id: 'anthropic', apiKey, baseUrl: entry.baseUrl, supportsVision: true, maxTokensParam: 'max_tokens', streamOptions: false });
      }
      return new AnthropicChatProvider({ apiKey, baseUrl: entry.baseUrl, timeoutMs: entry.timeoutMs, fetchImpl });
    case 'pollinations':
      return new OpenAICompatibleChatProvider({
        ...common,
        id: 'pollinations',
        apiKey,
        baseUrl: entry.baseUrl,
        supportsVision: false,
        maxTokensParam: 'max_tokens',
        // The anonymous tier queues requests; allow for that.
        timeoutMs: Math.max(entry.timeoutMs, 120_000),
        extraHeaders: { Referer: 'https://orin.app' },
        // Anonymous tier: one request at a time per IP; a second concurrent one gets 429.
        maxConcurrent: apiKey ? 4 : 1,
        rateLimitRetries: 3,
      });
    case 'azure':
      // Azure's v1 API: <endpoint>/openai/v1/chat/completions, key in the api-key header, model = deployment.
      return new OpenAICompatibleChatProvider({
        ...common,
        id: 'azure',
        apiKey: '',
        baseUrl: entry.baseUrl,
        supportsVision: entry.supportsVision,
        maxTokensParam: entry.maxTokensParam,
        extraHeaders: { 'api-key': apiKey },
      });
    default:
      return new OpenAICompatibleChatProvider({
        ...common,
        id: entry.provider,
        apiKey,
        baseUrl: entry.baseUrl,
        supportsVision: entry.supportsVision,
        maxTokensParam: entry.maxTokensParam,
        supportsTools: entry.caps.tools,
        timeoutMs: entry.provider === 'ollama' ? Math.max(entry.timeoutMs, 120_000) : entry.timeoutMs,
        extraHeaders: entry.provider === 'openrouter' ? { 'X-Title': 'Orin' } : undefined,
      });
  }
}

/** Gemini and Anthropic use different classes for chat and agent; everything else can share one instance. */
const sharedForAgent = (entry: ChainEntry) => entry.provider !== 'gemini' && entry.provider !== 'anthropic';

function candidates(config: AppConfig, forAgent: boolean, fetchImpl: FetchLike | undefined, cache: Map<string, ChatProvider>): FallbackCandidate[] {
  const out: FallbackCandidate[] = [];
  for (const entry of config.chat.chain) {
    if (forAgent && !entry.caps.tools) continue;
    const keys = entry.keys.length ? entry.keys : [''];
    keys.forEach((key, i) => {
      const label = keys.length > 1 ? `${entry.provider} key ${i + 1}/${keys.length}` : entry.provider;
      const cacheKey = `${label}|${forAgent && !sharedForAgent(entry) ? 'agent' : 'chat'}`;
      let provider = cache.get(cacheKey);
      if (!provider) {
        provider = entryProvider(entry, key, forAgent, fetchImpl);
        cache.set(cacheKey, provider);
      }
      out.push({ provider, group: entry.provider, label, model: entry.model, fastModel: entry.fastModel, visionModel: entry.visionModel, supportsVision: entry.supportsVision, altModels: entry.altModels, keyId: keyId(key) || undefined });
    });
  }
  return out;
}

function wrap(list: FallbackCandidate[]): ChatProvider | null {
  if (list.length === 0) return null;
  if (list.length === 1 && !list[0]!.altModels?.length) return list[0]!.provider;
  return new FallbackChatProvider(list, { health: sharedKeyHealth });
}

export function buildChatProvider(config: AppConfig, fetchImpl?: FetchLike, cache = new Map<string, ChatProvider>()): ChatProvider | null {
  const c = config.chat;
  if (c.ready && c.chain.length) {
    const p = wrap(candidates(config, false, fetchImpl, cache));
    if (p) return p;
  }
  if (c.demoMode) return new DemoChatProvider(config.env === 'test' ? 0 : 18);
  return null;
}

/** The provider the agent loop uses (must support tool calling), or null. */
export function buildAgentProvider(
  config: AppConfig,
  chat: ChatProvider | null,
  fetchImpl?: FetchLike,
  cache = new Map<string, ChatProvider>(),
): ChatProvider | null {
  const c = config.chat;
  if (!config.agent.enabled || !chat || chat.isDemo || !c.ready) return null;
  // The primary must be able to use tools, so the agent and plain chat start from the same model.
  if (!c.caps.tools) return null;
  return wrap(candidates(config, true, fetchImpl, cache));
}

/** Gemini keys from the chat chain (rotation pool), used for voice when no other speech provider is set. */
export function geminiVoiceKeys(config: AppConfig): string[] {
  if (process.env.GEMINI_VOICE === 'off') return [];
  const keys = config.chat.chain.filter((e) => e.provider === 'gemini').flatMap((e) => e.keys);
  return [...new Set(keys.filter(Boolean))];
}

export function buildVoiceProvider(config: AppConfig, fetchImpl?: FetchLike): VoiceProvider | null {
  const v = config.voice;
  const timeoutMs = config.chat.timeoutMs;
  const openaiLike = (id: string, apiKey: string, baseUrl: string, stt: string, tts: string) =>
    new OpenAICompatibleVoiceProvider({ id, apiKey, baseUrl, sttModel: stt, ttsModel: tts, voices: v.voices, defaultVoice: v.defaultVoice, timeoutMs, fetchImpl });
  const eleven = () => {
    const p = new ElevenLabsVoiceProvider({ apiKey: v.elevenlabs.apiKey, voiceId: v.elevenlabs.voiceId, timeoutMs, fetchImpl });
    if (config.env !== 'test') void p.loadVoices();
    return p;
  };
  const deepgram = () => new DeepgramVoiceProvider({ apiKey: v.deepgram.apiKey, timeoutMs, fetchImpl });

  let stt: VoiceProvider | null = null;
  if (v.provider === 'elevenlabs' && v.apiKey) stt = eleven();
  else if (v.provider === 'deepgram' && v.apiKey) stt = deepgram();
  else if (v.provider !== 'none' && v.apiKey) stt = openaiLike(v.provider, v.apiKey, v.baseUrl, v.sttModel, v.ttsModel);

  let tts: VoiceProvider | null;
  switch (v.tts.provider) {
    case 'elevenlabs':
      tts = v.elevenlabs.apiKey ? eleven() : null;
      break;
    case 'deepgram':
      tts = v.deepgram.apiKey ? deepgram() : null;
      break;
    case 'openai':
      tts = v.tts.openaiKey ? openaiLike('openai', v.tts.openaiKey, 'https://api.openai.com/v1', 'gpt-4o-mini-transcribe', 'gpt-4o-mini-tts') : null;
      break;
    default:
      tts = null;
  }
  // The user's Gemini keys can do both directions (Flash speech-to-text, Gemini TTS voices per character).
  const geminiKeys = geminiVoiceKeys(config);
  const gemini = geminiKeys.length ? new GeminiVoiceProvider({ keys: geminiKeys, fetchImpl, tts: v.geminiTts }) : null;
  if (!stt && gemini) stt = gemini;
  if ((!tts || !tts.supportsTts) && !stt?.supportsTts && gemini) tts = gemini;
  if (stt && tts && tts.id !== stt.id) return new SplitVoiceProvider(stt, tts);
  if (stt) return stt;
  // Voice out only: speech-to-text then fails clearly with voice_not_configured from the TTS-only provider's caller.
  return tts;
}

export function buildProviders(config: AppConfig, fetchImpl?: FetchLike): Providers {
  const cache = new Map<string, ChatProvider>();
  const chat = buildChatProvider(config, fetchImpl, cache);
  return { chat, voice: buildVoiceProvider(config, fetchImpl), agent: buildAgentProvider(config, chat, fetchImpl, cache) };
}
