import { z } from 'zod';
import { openEnv } from './admin/secretBox.js';

const bool = (def: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined || v === '' ? def : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())));

const int = (def: number) =>
  z
    .string()
    .optional()
    .transform((v, ctx) => {
      if (v === undefined || v === '') return def;
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) {
        ctx.addIssue({ code: 'custom', message: `Expected a non-negative number, got "${v}"` });
        return z.NEVER;
      }
      return n;
    });

const str = (def = '') => z.string().optional().transform((v) => (v === undefined || v === '' ? def : v.trim()));

export const CHAT_PROVIDERS = [
  'auto',
  'pollinations',
  'gemini',
  'groq',
  'openrouter',
  'ollama',
  'openai',
  'openai_compatible',
  'anthropic',
  'deepseek',
  'mistral',
  'xai',
  'together',
  'fireworks',
  'cerebras',
  'perplexity',
  'cohere',
  'huggingface',
  'azure',
  'demo',
] as const;

/** Splits a key pool pasted as "key1,key2" (commas, spaces or new lines). */
export function splitKeyPool(raw: string | undefined): string[] {
  return (raw ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

const EnvSchema = z.object({
  PORT: int(8787),
  NODE_ENV: str('development'),
  CORS_ORIGINS: str(''),
  TRUST_PROXY: bool(false),

  AI_PROVIDER: z.enum(CHAT_PROVIDERS).optional().default('auto'),
  // Free options
  GEMINI_API_KEY: str(),
  GEMINI_BASE_URL: str('https://generativelanguage.googleapis.com/v1beta'),
  GEMINI_THINKING_BUDGET: str(''),
  // Other Gemini models (same key) to try, in order, when the main one is overloaded (503) or rate limited (429).
  GEMINI_FALLBACK_MODELS: str('gemini-flash-latest,gemini-3-flash-preview,gemini-3.5-flash-lite,gemini-flash-lite-latest'),
  GROQ_API_KEY: str(),
  GROQ_BASE_URL: str('https://api.groq.com/openai/v1'),
  OPENROUTER_API_KEY: str(),
  OPENROUTER_BASE_URL: str('https://openrouter.ai/api/v1'),
  OLLAMA_BASE_URL: str('http://localhost:11434'),
  // Paid / generic options (kept as optional upgrades)
  AI_API_KEY: str(),
  OPENAI_API_KEY: str(),
  ANTHROPIC_API_KEY: str(),
  ANTHROPIC_BASE_URL: str('https://api.anthropic.com/v1'),
  AI_BASE_URL: str(''),
  AI_CHAT_MODEL: str(''),
  AI_VISION_MODEL: str(''),
  AI_TITLE_MODEL: str(''),
  AI_SUPPORTS_VISION: str(''),
  AI_MAX_TOKENS_PARAM: str(''),
  AI_MAX_OUTPUT_TOKENS: str(''),
  AI_TIMEOUT_MS: int(60000),
  AI_DEMO_MODE: bool(false),
  AI_FAST_MODEL: str(''),
  /** comma-separated provider ids tried after the primary; empty = every keyed provider; off = none */
  AI_FALLBACK_ORDER: str(''),

  // More providers (all optional; several keys per provider allowed, comma-separated)
  DEEPSEEK_API_KEY: str(),
  MISTRAL_API_KEY: str(),
  XAI_API_KEY: str(),
  TOGETHER_API_KEY: str(),
  FIREWORKS_API_KEY: str(),
  CEREBRAS_API_KEY: str(),
  PERPLEXITY_API_KEY: str(),
  COHERE_API_KEY: str(),
  HF_TOKEN: str(),
  AZURE_OPENAI_API_KEY: str(),
  AZURE_OPENAI_ENDPOINT: str(''),
  AZURE_OPENAI_DEPLOYMENT: str(''),
  CUSTOM_BASE_URL: str(''),
  CUSTOM_API_KEY: str(),
  CUSTOM_MODEL: str(''),
  // Per-provider model overrides
  GEMINI_MODEL: str(''),
  OPENAI_MODEL: str(''),
  ANTHROPIC_MODEL: str(''),
  GROQ_MODEL: str(''),
  OPENROUTER_MODEL: str(''),
  DEEPSEEK_MODEL: str(''),
  MISTRAL_MODEL: str(''),
  XAI_MODEL: str(''),
  TOGETHER_MODEL: str(''),
  FIREWORKS_MODEL: str(''),
  CEREBRAS_MODEL: str(''),
  PERPLEXITY_MODEL: str(''),
  COHERE_MODEL: str(''),
  HF_MODEL: str(''),
  OLLAMA_MODEL: str(''),

  // Keyless default: Pollinations (OpenAI-compatible, no account needed)
  POLLINATIONS_ENABLED: bool(true),
  POLLINATIONS_BASE_URL: str('https://text.pollinations.ai/openai'),
  POLLINATIONS_MODEL: str('openai'),
  POLLINATIONS_TOKEN: str(),
  POLLINATIONS_IMAGE_URL: str('https://image.pollinations.ai'),
  IMAGE_PROVIDER: z.enum(['auto', 'pollinations', 'gemini', 'openai', 'none']).optional().default('auto'),

  // Agent runtime
  AGENT_ENABLED: bool(true),
  AGENT_MAX_STEPS: int(30),
  AGENT_TOOL_TIMEOUT_MS: int(45000),
  TASK_MAX_STEPS: int(40),
  /** How many background tasks one long job may hand itself on to when it runs out of steps. */
  AGENT_MAX_CONTINUATIONS: int(4),
  /**
   * Output token budget for one agent step (tool calls included). Big: thinking models such as
   * Gemini 3.5 Flash spend part of it thinking, and one file written through a tool call can be
   * 10k+ tokens. With the old 2048 the call was cut off and the model returned nothing at all.
   */
  AGENT_MAX_OUTPUT_TOKENS: int(32768),
  DATA_DIR: str('./data'),
  PUBLIC_URL: str(''),
  WORKER_ENABLED: bool(true),
  WORKER_POLL_MS: int(1000),
  SCHEDULER_TICK_MS: int(15000),
  SCHEDULE_MIN_INTERVAL_SEC: int(60),

  // Optional upgrades / adapters (disabled until configured)
  TAVILY_API_KEY: str(),
  BRAVE_API_KEY: str(),
  SERPER_API_KEY: str(),
  EXA_API_KEY: str(),
  E2B_API_KEY: str(),
  CODE_SANDBOX: z.enum(['auto', 'e2b', 'docker', 'none']).optional().default('auto'),
  BROWSER_ENABLED: bool(false),
  BROWSER_EXECUTABLE: str(''),
  GOOGLE_CLIENT_ID: str(),
  GOOGLE_CLIENT_SECRET: str(),
  GOOGLE_REDIRECT_URL: str(''),

  VOICE_PROVIDER: z.enum(['auto', 'groq', 'openai', 'openai_compatible', 'elevenlabs', 'deepgram', 'none']).optional().default('auto'),
  TTS_PROVIDER: z.enum(['auto', 'openai', 'elevenlabs', 'deepgram', 'none']).optional().default('auto'),
  ELEVENLABS_API_KEY: str(),
  ELEVENLABS_VOICE_ID: str(''),
  DEEPGRAM_API_KEY: str(),
  VOICE_API_KEY: str(),
  VOICE_BASE_URL: str(''),
  STT_MODEL: str(''),
  TTS_MODEL: str(''),
  TTS_VOICES: str(''),
  TTS_DEFAULT_VOICE: str('coral'),
  /** 'off': Gemini keys only do speech-to-text; replies are spoken by the phone/browser voice (saves Gemini quota). */
  GEMINI_TTS: z.enum(['on', 'off']).optional().default('on'),

  REALTIME_ENABLED: bool(false),
  REALTIME_MODEL: str('gpt-realtime'),

  SUPABASE_URL: str(),
  SUPABASE_SERVICE_ROLE_KEY: str(),
  SUPABASE_JWT_SECRET: str(),

  ALLOW_GUESTS: bool(true),
  RATE_LIMIT_WINDOW_MS: int(60000),
  RATE_LIMIT_MAX: int(40),
  RATE_LIMIT_GUEST_MAX: int(15),
  MAX_UPLOAD_MB: int(10),
  MAX_IMAGE_MB: int(8),
  MAX_AUDIO_MB: int(20),
});

/** Concrete provider after `auto` has been resolved. `none` means chat is not configured. */
export type ChatProviderKind = Exclude<(typeof CHAT_PROVIDERS)[number], 'auto'> | 'none';
export type VoiceProviderKind = 'groq' | 'openai' | 'openai_compatible' | 'elevenlabs' | 'deepgram' | 'none';
export type TtsProviderKind = 'openai' | 'elevenlabs' | 'deepgram' | 'none';
export type ProviderId = Exclude<ChatProviderKind, 'none' | 'demo'>;

/** One provider + its key pool and models, as used by the fallback chain. */
export interface ChainEntry {
  provider: ProviderId;
  displayName: string;
  keys: string[];
  baseUrl: string;
  model: string;
  fastModel: string;
  visionModel: string;
  supportsVision: boolean;
  caps: ProviderCaps;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  timeoutMs: number;
  thinkingBudget: number | null;
  /** Same-provider models to try when `model` is overloaded or rate limited (Gemini). */
  altModels?: string[];
}

export interface AppConfig {
  port: number;
  env: string;
  corsOrigins: string[];
  trustProxy: boolean;
  chat: {
    provider: ChatProviderKind;
    /** Human readable provider name used in errors and the health endpoint. */
    displayName: string;
    /** true when this provider is usable (has its key, or needs none like Ollama). */
    ready: boolean;
    /** true when the provider costs nothing to start with (free tier or local). */
    free: boolean;
    apiKey: string;
    baseUrl: string;
    model: string;
    visionModel: string;
    titleModel: string;
    /** cheaper/faster model for titles, summaries and planning */
    fastModel: string;
    supportsVision: boolean;
    caps: ProviderCaps;
    maxTokensParam: 'max_tokens' | 'max_completion_tokens';
    maxOutputTokens: number;
    timeoutMs: number;
    demoMode: boolean;
    /** Gemini only: thinking budget, or null to leave the model default. */
    thinkingBudget: number | null;
    /** Which free keys are present (for the setup hints in /v1/health). */
    keysPresent: { gemini: boolean; groq: boolean; openrouter: boolean; openai: boolean; anthropic: boolean };
    pollinations: { enabled: boolean; baseUrl: string; model: string; token: string; imageUrl: string };
    /** true when AI_PROVIDER=auto picked the provider */
    autoSelected: boolean;
    /** primary first, then fallbacks in order (Pollinations last when enabled); empty when not ready */
    chain: ChainEntry[];
    /** every provider that is set up (has its key / endpoint), for the admin page tests */
    available: ChainEntry[];
  };
  agent: {
    enabled: boolean;
    maxSteps: number;
    taskMaxSteps: number;
    maxContinuations: number;
    /** output token budget per agent step (each provider caps it to what it accepts) */
    maxOutputTokens: number;
    toolTimeoutMs: number;
    dataDir: string;
    publicUrl: string;
    worker: boolean;
    workerPollMs: number;
    schedulerTickMs: number;
    scheduleMinIntervalSec: number;
  };
  integrations: {
    imageProvider: 'pollinations' | 'gemini' | 'openai' | 'none';
    geminiKey: string;
    openaiKey: string;
    tavilyKey: string;
    braveKey: string;
    serperKey: string;
    exaKey: string;
    e2bKey: string;
    codeSandbox: 'e2b' | 'docker' | 'none';
    browserEnabled: boolean;
    browserExecutable: string;
    google: { clientId: string; clientSecret: string; redirectUrl: string };
  };
  voice: {
    provider: VoiceProviderKind;
    apiKey: string;
    baseUrl: string;
    sttModel: string;
    /** Empty when the provider has no text-to-speech (the app then uses on-device TTS). */
    ttsModel: string;
    voices: string[];
    defaultVoice: string;
    /** who speaks replies: 'same' = the speech-to-text provider (if it has TTS) */
    tts: { provider: TtsProviderKind | 'same'; openaiKey: string };
    elevenlabs: { apiKey: string; voiceId: string };
    deepgram: { apiKey: string };
    /** false: the Gemini voice fallback does speech-to-text only (GEMINI_TTS=off) */
    geminiTts: boolean;
  };
  realtime: { enabled: boolean; model: string; apiKey: string };
  supabase: { url: string; serviceRoleKey: string; jwtSecret: string };
  access: {
    allowGuests: boolean;
    rateLimitWindowMs: number;
    rateLimitMax: number;
    rateLimitGuestMax: number;
    maxUploadBytes: number;
    maxImageBytes: number;
    maxAudioBytes: number;
  };
}

export interface ProviderCaps {
  tools: boolean;
  vision: boolean;
  audio: boolean;
  imageGen: boolean;
  /** approximate context window in tokens */
  maxContext: number;
}

interface Preset {
  displayName: string;
  baseUrl: string;
  model: string;
  /** cheaper/faster model used for titles, summaries and planning */
  fastModel: string;
  caps: ProviderCaps;
  /** higher = stronger; `auto` picks the strongest configured provider */
  tier: number;
  visionModel?: string;
  supportsVision: boolean;
  maxTokensParam: 'max_tokens' | 'max_completion_tokens';
  maxOutputTokens: number;
  free: boolean;
  needsKey: boolean;
}

/**
 * Defaults per provider. Free-tier model line-ups change often, so every value can be
 * overridden with AI_CHAT_MODEL / AI_VISION_MODEL / AI_BASE_URL.
 */
export const PRESETS: Record<Exclude<ChatProviderKind, 'none' | 'demo'>, Preset> = {
  pollinations: {
    displayName: 'Pollinations (free, no key)',
    baseUrl: 'https://text.pollinations.ai/openai',
    // "openai" is Pollinations' alias for openai-fast (GPT-OSS 20B): supports tools, no vision.
    model: 'openai',
    fastModel: 'openai',
    caps: { tools: true, vision: false, audio: false, imageGen: true, maxContext: 32_000 },
    tier: 30,
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: true,
    needsKey: false,
  },
  gemini: {
    fastModel: 'gemini-flash-lite-latest',
    caps: { tools: true, vision: true, audio: true, imageGen: true, maxContext: 1_000_000 },
    tier: 80,
    displayName: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    model: 'gemini-3.5-flash',
    supportsVision: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: true,
    needsKey: true,
  },
  groq: {
    fastModel: 'llama-3.1-8b-instant',
    caps: { tools: true, vision: true, audio: false, imageGen: false, maxContext: 131_072 },
    tier: 60,
    displayName: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    model: 'openai/gpt-oss-120b',
    visionModel: 'meta-llama/llama-4-scout-17b-16e-instruct',
    supportsVision: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: true,
    needsKey: true,
  },
  openrouter: {
    fastModel: 'openrouter/free',
    caps: { tools: true, vision: true, audio: false, imageGen: false, maxContext: 32_000 },
    tier: 55,
    displayName: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    // The free-models router picks an available :free model that supports the request (including images).
    model: 'openrouter/free',
    supportsVision: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: true,
    needsKey: true,
  },
  ollama: {
    fastModel: 'gemma3',
    caps: { tools: false, vision: true, audio: false, imageGen: false, maxContext: 8_192 },
    tier: 20,
    displayName: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    // gemma3 reads text and images, so one download covers chat and image analysis.
    model: 'gemma3',
    supportsVision: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: true,
    needsKey: false,
  },
  openai: {
    fastModel: 'gpt-4o-mini',
    caps: { tools: true, vision: true, audio: true, imageGen: true, maxContext: 128_000 },
    tier: 90,
    displayName: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    supportsVision: true,
    maxTokensParam: 'max_completion_tokens',
    maxOutputTokens: 1200,
    free: false,
    needsKey: true,
  },
  openai_compatible: {
    fastModel: 'gpt-4o-mini',
    caps: { tools: true, vision: false, audio: false, imageGen: false, maxContext: 32_000 },
    tier: 40,
    displayName: 'AI provider',
    baseUrl: 'http://localhost:8000/v1',
    model: 'gpt-4o-mini',
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 1200,
    free: false,
    needsKey: false,
  },
  anthropic: {
    fastModel: 'claude-haiku-4-5',
    caps: { tools: true, vision: true, audio: false, imageGen: false, maxContext: 200_000 },
    tier: 95,
    displayName: 'Anthropic',
    baseUrl: 'https://api.anthropic.com/v1',
    model: 'claude-haiku-4-5',
    supportsVision: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 1200,
    free: false,
    needsKey: true,
  },
  // ---- Added providers (OpenAI-compatible endpoints). Model ids checked against each provider's
  // docs/catalog in Oct 2026; ones marked needs-verify could not be confirmed and are easy to
  // override with <PROVIDER>_MODEL or in the admin page.
  deepseek: {
    displayName: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    // deepseek-chat / deepseek-reasoner were retired on 2026-07-24; V4 Flash replaced them.
    model: 'deepseek-v4-flash',
    fastModel: 'deepseek-v4-flash',
    caps: { tools: true, vision: false, audio: false, imageGen: false, maxContext: 128_000 },
    tier: 75,
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: false,
    needsKey: true,
  },
  mistral: {
    displayName: 'Mistral',
    baseUrl: 'https://api.mistral.ai/v1',
    model: 'mistral-large-latest',
    fastModel: 'mistral-small-latest',
    visionModel: 'mistral-small-latest',
    caps: { tools: true, vision: true, audio: false, imageGen: false, maxContext: 128_000 },
    tier: 72,
    supportsVision: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: false,
    needsKey: true,
  },
  xai: {
    displayName: 'xAI Grok',
    baseUrl: 'https://api.x.ai/v1',
    model: 'grok-4',
    fastModel: 'grok-3-mini',
    caps: { tools: true, vision: true, audio: false, imageGen: false, maxContext: 256_000 },
    tier: 85,
    supportsVision: true,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: false,
    needsKey: true,
  },
  together: {
    displayName: 'Together AI',
    baseUrl: 'https://api.together.xyz/v1',
    model: 'openai/gpt-oss-120b',
    fastModel: 'Qwen/Qwen3.5-9B',
    caps: { tools: true, vision: false, audio: false, imageGen: false, maxContext: 128_000 },
    tier: 58,
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: false,
    needsKey: true,
  },
  fireworks: {
    displayName: 'Fireworks AI',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    // needs-verify: Fireworks serverless line-up changes often.
    model: 'accounts/fireworks/models/gpt-oss-120b',
    fastModel: 'accounts/fireworks/models/gpt-oss-20b',
    caps: { tools: true, vision: false, audio: false, imageGen: false, maxContext: 128_000 },
    tier: 57,
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: false,
    needsKey: true,
  },
  cerebras: {
    displayName: 'Cerebras',
    baseUrl: 'https://api.cerebras.ai/v1',
    model: 'gpt-oss-120b',
    fastModel: 'llama3.1-8b',
    caps: { tools: true, vision: false, audio: false, imageGen: false, maxContext: 65_000 },
    tier: 62,
    supportsVision: false,
    maxTokensParam: 'max_completion_tokens',
    maxOutputTokens: 2048,
    free: true,
    needsKey: true,
  },
  perplexity: {
    displayName: 'Perplexity',
    baseUrl: 'https://api.perplexity.ai',
    model: 'sonar-pro',
    fastModel: 'sonar',
    // Sonar searches the web itself; it has no function calling, so it is never used by the agent.
    caps: { tools: false, vision: false, audio: false, imageGen: false, maxContext: 128_000 },
    tier: 45,
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: false,
    needsKey: true,
  },
  cohere: {
    displayName: 'Cohere',
    baseUrl: 'https://api.cohere.ai/compatibility/v1',
    model: 'command-a-03-2025',
    // needs-verify
    fastModel: 'command-r7b-12-2024',
    caps: { tools: true, vision: false, audio: false, imageGen: false, maxContext: 256_000 },
    tier: 50,
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: false,
    needsKey: true,
  },
  huggingface: {
    displayName: 'Hugging Face',
    baseUrl: 'https://router.huggingface.co/v1',
    model: 'openai/gpt-oss-120b',
    fastModel: 'openai/gpt-oss-20b',
    caps: { tools: true, vision: false, audio: false, imageGen: false, maxContext: 128_000 },
    tier: 52,
    supportsVision: false,
    maxTokensParam: 'max_tokens',
    maxOutputTokens: 2048,
    free: true,
    needsKey: true,
  },
  azure: {
    displayName: 'Azure OpenAI',
    // <endpoint>/openai/v1 (Azure's v1 API); the model is your deployment name.
    baseUrl: '',
    model: '',
    fastModel: '',
    caps: { tools: true, vision: true, audio: false, imageGen: false, maxContext: 128_000 },
    tier: 88,
    supportsVision: true,
    maxTokensParam: 'max_completion_tokens',
    maxOutputTokens: 1200,
    free: false,
    needsKey: true,
  },
};

/** Env variables per provider: key pool, model override, base URL. */
const PROVIDER_ENV: Record<ProviderId, { key?: keyof Env; model?: keyof Env }> = {
  pollinations: { key: 'POLLINATIONS_TOKEN', model: 'POLLINATIONS_MODEL' },
  gemini: { key: 'GEMINI_API_KEY', model: 'GEMINI_MODEL' },
  groq: { key: 'GROQ_API_KEY', model: 'GROQ_MODEL' },
  openrouter: { key: 'OPENROUTER_API_KEY', model: 'OPENROUTER_MODEL' },
  ollama: { model: 'OLLAMA_MODEL' },
  openai: { key: 'OPENAI_API_KEY', model: 'OPENAI_MODEL' },
  openai_compatible: { key: 'CUSTOM_API_KEY', model: 'CUSTOM_MODEL' },
  anthropic: { key: 'ANTHROPIC_API_KEY', model: 'ANTHROPIC_MODEL' },
  deepseek: { key: 'DEEPSEEK_API_KEY', model: 'DEEPSEEK_MODEL' },
  mistral: { key: 'MISTRAL_API_KEY', model: 'MISTRAL_MODEL' },
  xai: { key: 'XAI_API_KEY', model: 'XAI_MODEL' },
  together: { key: 'TOGETHER_API_KEY', model: 'TOGETHER_MODEL' },
  fireworks: { key: 'FIREWORKS_API_KEY', model: 'FIREWORKS_MODEL' },
  cerebras: { key: 'CEREBRAS_API_KEY', model: 'CEREBRAS_MODEL' },
  perplexity: { key: 'PERPLEXITY_API_KEY', model: 'PERPLEXITY_MODEL' },
  cohere: { key: 'COHERE_API_KEY', model: 'COHERE_MODEL' },
  huggingface: { key: 'HF_TOKEN', model: 'HF_MODEL' },
  azure: { key: 'AZURE_OPENAI_API_KEY', model: 'AZURE_OPENAI_DEPLOYMENT' },
};

const envStr = (e: Env, k: keyof Env | undefined): string => (k ? String(e[k] ?? '') : '');

/** Is this provider set up well enough to be called (key, endpoint, deployment...)? */
function isConfigured(p: ProviderId, e: Env, raw: Record<string, string | undefined>): boolean {
  switch (p) {
    case 'pollinations':
      return e.POLLINATIONS_ENABLED;
    case 'ollama':
      return Boolean(raw.OLLAMA_BASE_URL?.trim() || raw.OLLAMA_MODEL?.trim());
    case 'openai_compatible':
      return Boolean(e.CUSTOM_BASE_URL);
    case 'azure':
      return Boolean(e.AZURE_OPENAI_API_KEY && e.AZURE_OPENAI_ENDPOINT && e.AZURE_OPENAI_DEPLOYMENT);
    default:
      return splitKeyPool(envStr(e, PROVIDER_ENV[p].key)).length > 0;
  }
}

function providerBaseUrl(p: ProviderId, e: Env): string {
  switch (p) {
    case 'gemini':
      return e.GEMINI_BASE_URL;
    case 'groq':
      return e.GROQ_BASE_URL;
    case 'openrouter':
      return e.OPENROUTER_BASE_URL;
    case 'anthropic':
      return e.ANTHROPIC_BASE_URL;
    case 'ollama':
      return `${e.OLLAMA_BASE_URL.replace(/\/+$/, '')}/v1`;
    case 'pollinations':
      return e.POLLINATIONS_BASE_URL;
    case 'azure':
      return e.AZURE_OPENAI_ENDPOINT ? `${e.AZURE_OPENAI_ENDPOINT.replace(/\/+$/, '').replace(/\/openai(\/v1)?$/, '')}/openai/v1` : '';
    case 'openai_compatible':
      return e.CUSTOM_BASE_URL || PRESETS.openai_compatible.baseUrl;
    default:
      return PRESETS[p].baseUrl;
  }
}

function altModelsFor(p: string, e: Env): string[] {
  if (p !== 'gemini') return [];
  return e.GEMINI_FALLBACK_MODELS.split(/[\s,]+/).map((m) => m.trim()).filter(Boolean);
}

/** A fallback (non-primary) entry: provider defaults + its own <PROVIDER>_MODEL override. */
function fallbackEntry(p: ProviderId, e: Env, timeoutMs: number, budget: number | null): ChainEntry {
  const preset = PRESETS[p];
  const override = envStr(e, PROVIDER_ENV[p].model);
  const model = override || preset.model;
  return {
    provider: p,
    displayName: preset.displayName,
    keys: splitKeyPool(envStr(e, PROVIDER_ENV[p].key)),
    baseUrl: providerBaseUrl(p, e).replace(/\/+$/, ''),
    model,
    fastModel: p === 'azure' || p === 'openai_compatible' ? model : preset.fastModel || model,
    visionModel: preset.visionModel || model,
    supportsVision: preset.supportsVision,
    caps: preset.caps,
    maxTokensParam: preset.maxTokensParam,
    timeoutMs,
    thinkingBudget: p === 'gemini' ? budget : null,
    altModels: altModelsFor(p, e),
  };
}

type Env = z.infer<typeof EnvSchema>;

/**
 * `auto` picks the strongest provider whose key is present (Anthropic > OpenAI > Gemini > Groq/OpenRouter),
 * then the keyless Pollinations default. Ollama must be chosen explicitly.
 */
function resolveProvider(e: Env): ChatProviderKind {
  if (e.AI_PROVIDER !== 'auto') return e.AI_PROVIDER;
  const present: Exclude<ChatProviderKind, 'none' | 'demo'>[] = [];
  if (e.GEMINI_API_KEY) present.push('gemini');
  if (e.GROQ_API_KEY) present.push('groq');
  if (e.OPENROUTER_API_KEY) present.push('openrouter');
  if (e.OPENAI_API_KEY || e.AI_API_KEY) present.push('openai');
  if (e.ANTHROPIC_API_KEY) present.push('anthropic');
  for (const p of ['deepseek', 'mistral', 'xai', 'together', 'fireworks', 'cerebras', 'perplexity', 'cohere', 'huggingface', 'azure', 'openai_compatible'] as const) {
    if (isConfigured(p, e, {})) present.push(p);
  }
  present.sort((a, b) => PRESETS[b].tier - PRESETS[a].tier);
  if (present[0]) return present[0];
  if (e.POLLINATIONS_ENABLED) return 'pollinations';
  return 'none';
}

function keyFor(provider: ChatProviderKind, e: Env): string {
  switch (provider) {
    case 'gemini':
      return e.GEMINI_API_KEY || e.AI_API_KEY;
    case 'groq':
      return e.GROQ_API_KEY || e.AI_API_KEY;
    case 'openrouter':
      return e.OPENROUTER_API_KEY || e.AI_API_KEY;
    case 'anthropic':
      return e.ANTHROPIC_API_KEY || e.AI_API_KEY;
    case 'openai':
      return e.AI_API_KEY || e.OPENAI_API_KEY;
    case 'openai_compatible':
      return e.AI_API_KEY || e.CUSTOM_API_KEY;
    case 'ollama':
      return e.AI_API_KEY;
    case 'pollinations':
      return e.POLLINATIONS_TOKEN;
    case 'none':
    case 'demo':
      return '';
    default:
      return envStr(e, PROVIDER_ENV[provider].key) || e.AI_API_KEY;
  }
}

function baseUrlFor(provider: ChatProviderKind, e: Env): string {
  if (provider === 'none' || provider === 'demo') return '';
  if (e.AI_BASE_URL) return e.AI_BASE_URL;
  return providerBaseUrl(provider, e);
}

function resolveVoice(e: Env, chatKey: string, chatProvider: ChatProviderKind) {
  const first = (s: string) => splitKeyPool(s)[0] ?? '';
  const openaiKey = first(e.OPENAI_API_KEY) || (chatProvider === 'openai' ? chatKey : '');
  let provider: VoiceProviderKind = 'none';
  if (e.VOICE_PROVIDER !== 'auto') provider = e.VOICE_PROVIDER;
  else if (e.VOICE_API_KEY || openaiKey) provider = 'openai';
  else if (e.DEEPGRAM_API_KEY) provider = 'deepgram';
  else if (e.ELEVENLABS_API_KEY) provider = 'elevenlabs';
  else if (e.GROQ_API_KEY) provider = 'groq';

  const apiKey =
    provider === 'groq'
      ? e.VOICE_API_KEY || first(e.GROQ_API_KEY)
      : provider === 'none'
        ? ''
        : provider === 'elevenlabs'
          ? first(e.ELEVENLABS_API_KEY)
          : provider === 'deepgram'
            ? first(e.DEEPGRAM_API_KEY)
            : e.VOICE_API_KEY || openaiKey;
  const sttHasTts = provider === 'openai' || provider === 'openai_compatible' || provider === 'elevenlabs' || provider === 'deepgram';
  const ttsProvider: TtsProviderKind | 'same' =
    e.TTS_PROVIDER !== 'auto'
      ? e.TTS_PROVIDER
      : e.ELEVENLABS_API_KEY
        ? 'elevenlabs'
        : sttHasTts
          ? 'same'
          : openaiKey || e.VOICE_API_KEY
            ? 'openai'
            : e.DEEPGRAM_API_KEY
              ? 'deepgram'
              : 'same';
  const defaults =
    provider === 'groq'
      ? // Groq's free tier includes Whisper speech-to-text. No TTS here: the app speaks on-device.
        { baseUrl: e.GROQ_BASE_URL, stt: 'whisper-large-v3-turbo', tts: '' }
      : { baseUrl: 'https://api.openai.com/v1', stt: 'gpt-4o-mini-transcribe', tts: 'gpt-4o-mini-tts' };
  return {
    provider,
    apiKey,
    baseUrl: (e.VOICE_BASE_URL || defaults.baseUrl).replace(/\/+$/, ''),
    sttModel: e.STT_MODEL || defaults.stt,
    ttsModel: e.TTS_MODEL || defaults.tts,
    voices: e.TTS_VOICES.split(',').map((s) => s.trim()).filter(Boolean),
    defaultVoice: e.TTS_DEFAULT_VOICE,
    tts: { provider: ttsProvider === provider ? ('same' as const) : ttsProvider, openaiKey: e.VOICE_API_KEY || openaiKey },
    elevenlabs: { apiKey: first(e.ELEVENLABS_API_KEY), voiceId: e.ELEVENLABS_VOICE_ID },
    deepgram: { apiKey: first(e.DEEPGRAM_API_KEY) },
    geminiTts: e.GEMINI_TTS !== 'off',
  };
}

export function loadConfig(rawEnv: Record<string, string | undefined> = process.env): AppConfig {
  // Keys saved from the admin page / app are encrypted in .env; decrypt them here.
  const env = openEnv(rawEnv);
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid server configuration: ${details}`);
  }
  const e = parsed.data;
  const provider = resolveProvider(e);
  const preset = provider === 'none' || provider === 'demo' ? null : PRESETS[provider];
  const keyPool = splitKeyPool(keyFor(provider, e));
  const apiKey = keyPool[0] ?? '';
  const providerModel = provider === 'none' || provider === 'demo' ? '' : envStr(e, PROVIDER_ENV[provider].model);
  const model = e.AI_CHAT_MODEL || providerModel || preset?.model || (provider === 'demo' ? 'demo' : '');
  const fastModel = e.AI_FAST_MODEL || (e.AI_CHAT_MODEL && provider !== 'pollinations' ? e.AI_CHAT_MODEL : '') || preset?.fastModel || model;
  const imageProvider: AppConfig['integrations']['imageProvider'] =
    e.IMAGE_PROVIDER !== 'auto'
      ? e.IMAGE_PROVIDER
      : e.OPENAI_API_KEY
        ? 'openai'
        : e.GEMINI_API_KEY
          ? 'gemini'
          : e.POLLINATIONS_ENABLED
            ? 'pollinations'
            : 'none';
  const codeSandbox: AppConfig['integrations']['codeSandbox'] =
    e.CODE_SANDBOX === 'auto' ? (e.E2B_API_KEY ? 'e2b' : 'none') : e.CODE_SANDBOX;
  const supportsVision =
    e.AI_SUPPORTS_VISION === '' ? Boolean(preset?.supportsVision) : ['1', 'true', 'yes'].includes(e.AI_SUPPORTS_VISION.toLowerCase());
  const maxOut = e.AI_MAX_OUTPUT_TOKENS === '' ? (preset?.maxOutputTokens ?? 1200) : Number(e.AI_MAX_OUTPUT_TOKENS);
  if (!Number.isFinite(maxOut)) throw new Error('Invalid server configuration: AI_MAX_OUTPUT_TOKENS must be a number');
  const budget = e.GEMINI_THINKING_BUDGET === '' ? null : Number(e.GEMINI_THINKING_BUDGET);
  const voice = resolveVoice(e, apiKey, provider);
  const timeoutMs = Math.max(e.AI_TIMEOUT_MS, 5000);
  const thinkingBudget = budget !== null && Number.isFinite(budget) ? budget : null;
  const ready = preset ? (preset.needsKey ? Boolean(apiKey) : true) && (provider !== 'azure' || Boolean(e.AZURE_OPENAI_ENDPOINT && model)) : false;
  const maxTokensParam: ChainEntry['maxTokensParam'] =
    e.AI_MAX_TOKENS_PARAM === 'max_tokens' || e.AI_MAX_TOKENS_PARAM === 'max_completion_tokens' ? e.AI_MAX_TOKENS_PARAM : (preset?.maxTokensParam ?? 'max_tokens');
  const baseUrl = baseUrlFor(provider, e).replace(/\/+$/, '');
  const visionModel = e.AI_VISION_MODEL || preset?.visionModel || model;

  // Every provider that is set up, then the ordered fallback chain behind the primary.
  const allIds = CHAT_PROVIDERS.filter((p): p is ProviderId => p !== 'auto' && p !== 'demo');
  const available = allIds.filter((p) => isConfigured(p, e, env)).map((p) => fallbackEntry(p, e, timeoutMs, thinkingBudget));
  const chain: ChainEntry[] = [];
  if (ready && preset && provider !== 'none' && provider !== 'demo') {
    chain.push({
      provider,
      displayName: preset.displayName,
      keys: provider === 'ollama' ? [''] : keyPool.length ? keyPool : [''],
      baseUrl,
      model,
      fastModel,
      visionModel,
      supportsVision,
      caps: { ...preset.caps, vision: supportsVision },
      maxTokensParam,
      timeoutMs,
      thinkingBudget,
      altModels: altModelsFor(provider, e),
    });
    const order = e.AI_FALLBACK_ORDER.toLowerCase();
    if (order !== 'off' && order !== 'none') {
      const wanted: ProviderId[] = order
        ? order
            .split(/[\s,>]+/)
            .filter((p): p is ProviderId => (allIds as string[]).includes(p))
        : available
            .map((a) => a.provider)
            .filter((p) => p !== 'pollinations' && p !== 'ollama')
            .sort((a, b) => PRESETS[b].tier - PRESETS[a].tier);
      for (const p of wanted) {
        if (chain.some((c) => c.provider === p)) continue;
        // Ollama has a default local URL, so naming it in the order is enough.
        if (!isConfigured(p, e, env) && !(order && p === 'ollama')) continue;
        chain.push(fallbackEntry(p, e, timeoutMs, thinkingBudget));
      }
      if (e.POLLINATIONS_ENABLED && !chain.some((c) => c.provider === 'pollinations')) chain.push(fallbackEntry('pollinations', e, timeoutMs, thinkingBudget));
    }
  }

  return {
    port: e.PORT,
    env: e.NODE_ENV,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    trustProxy: e.TRUST_PROXY,
    chat: {
      provider,
      displayName: preset?.displayName ?? (provider === 'demo' ? 'Demo responder' : 'none'),
      ready,
      free: Boolean(preset?.free),
      apiKey,
      baseUrl,
      model,
      visionModel,
      titleModel: e.AI_TITLE_MODEL || fastModel,
      fastModel,
      supportsVision,
      caps: preset ? { ...preset.caps, vision: supportsVision } : { tools: false, vision: false, audio: false, imageGen: false, maxContext: 8000 },
      maxTokensParam,
      maxOutputTokens: Math.min(Math.max(maxOut, 64), 16000),
      timeoutMs,
      demoMode: e.AI_DEMO_MODE || provider === 'demo',
      thinkingBudget,
      keysPresent: {
        gemini: Boolean(e.GEMINI_API_KEY),
        groq: Boolean(e.GROQ_API_KEY),
        openrouter: Boolean(e.OPENROUTER_API_KEY),
        openai: Boolean(e.OPENAI_API_KEY || e.AI_API_KEY),
        anthropic: Boolean(e.ANTHROPIC_API_KEY),
      },
      pollinations: {
        enabled: e.POLLINATIONS_ENABLED,
        baseUrl: e.POLLINATIONS_BASE_URL.replace(/\/+$/, ''),
        model: e.POLLINATIONS_MODEL,
        token: e.POLLINATIONS_TOKEN,
        imageUrl: e.POLLINATIONS_IMAGE_URL.replace(/\/+$/, ''),
      },
      autoSelected: e.AI_PROVIDER === 'auto',
      chain,
      available,
    },
    agent: {
      enabled: e.AGENT_ENABLED,
      maxSteps: Math.min(Math.max(e.AGENT_MAX_STEPS, 1), 100),
      taskMaxSteps: Math.min(Math.max(e.TASK_MAX_STEPS, 2), 120),
      maxContinuations: Math.min(Math.max(e.AGENT_MAX_CONTINUATIONS, 0), 10),
      maxOutputTokens: Math.min(Math.max(e.AGENT_MAX_OUTPUT_TOKENS, 2048), 65536),
      toolTimeoutMs: Math.max(e.AGENT_TOOL_TIMEOUT_MS, 2000),
      dataDir: e.DATA_DIR,
      publicUrl: (e.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || '').replace(/\/+$/, ''),
      worker: e.WORKER_ENABLED,
      workerPollMs: Math.max(e.WORKER_POLL_MS, 50),
      schedulerTickMs: Math.max(e.SCHEDULER_TICK_MS, 200),
      scheduleMinIntervalSec: Math.max(e.SCHEDULE_MIN_INTERVAL_SEC, 1),
    },
    integrations: {
      imageProvider,
      geminiKey: splitKeyPool(e.GEMINI_API_KEY)[0] ?? '',
      openaiKey: splitKeyPool(e.OPENAI_API_KEY)[0] ?? '',
      tavilyKey: splitKeyPool(e.TAVILY_API_KEY)[0] ?? '',
      braveKey: splitKeyPool(e.BRAVE_API_KEY)[0] ?? '',
      serperKey: splitKeyPool(e.SERPER_API_KEY)[0] ?? '',
      exaKey: splitKeyPool(e.EXA_API_KEY)[0] ?? '',
      e2bKey: e.E2B_API_KEY,
      codeSandbox,
      browserEnabled: e.BROWSER_ENABLED,
      browserExecutable: e.BROWSER_EXECUTABLE,
      google: { clientId: e.GOOGLE_CLIENT_ID, clientSecret: e.GOOGLE_CLIENT_SECRET, redirectUrl: e.GOOGLE_REDIRECT_URL },
    },
    voice,
    realtime: { enabled: e.REALTIME_ENABLED, model: e.REALTIME_MODEL, apiKey: e.VOICE_API_KEY || (splitKeyPool(e.OPENAI_API_KEY)[0] ?? "") },
    supabase: {
      url: e.SUPABASE_URL.replace(/\/+$/, ''),
      serviceRoleKey: e.SUPABASE_SERVICE_ROLE_KEY,
      jwtSecret: e.SUPABASE_JWT_SECRET,
    },
    access: {
      allowGuests: e.ALLOW_GUESTS,
      rateLimitWindowMs: e.RATE_LIMIT_WINDOW_MS,
      rateLimitMax: e.RATE_LIMIT_MAX,
      rateLimitGuestMax: e.RATE_LIMIT_GUEST_MAX,
      maxUploadBytes: e.MAX_UPLOAD_MB * 1024 * 1024,
      maxImageBytes: e.MAX_IMAGE_MB * 1024 * 1024,
      maxAudioBytes: e.MAX_AUDIO_MB * 1024 * 1024,
    },
  };
}
