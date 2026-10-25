/** What the admin page shows: sections of cards, each with the .env variables it edits. */

export interface AdminField {
  env: string;
  label: string;
  /** secret values are never sent back to the browser (only the last 4 characters) */
  secret: boolean;
  /** several keys allowed (comma-separated in .env), rotated on rate limits */
  pool?: boolean;
  placeholder?: string;
  options?: string[];
  help?: string;
}

export type TestKind = 'chat' | 'search' | 'elevenlabs' | 'deepgram' | 'e2b' | 'google' | 'ollama' | 'none';

export interface AdminCard {
  id: string;
  title: string;
  link?: string;
  linkText?: string;
  note?: string;
  test: TestKind;
  fields: AdminField[];
}

export interface AdminSection {
  id: string;
  title: string;
  intro: string;
  cards: AdminCard[];
}

const key = (env: string, placeholder = 'Paste key'): AdminField => ({ env, label: 'API key', secret: true, pool: true, placeholder });
const model = (env: string, placeholder: string): AdminField => ({ env, label: 'Model (optional)', secret: false, placeholder, help: 'Leave empty for the default shown.' });

function chatCard(id: string, title: string, keyEnv: string, link: string, modelEnv: string, defModel: string, note?: string): AdminCard {
  return { id, title, link, linkText: 'Get a key', note, test: 'chat', fields: [key(keyEnv), model(modelEnv, defModel)] };
}

export const CHAT_PROVIDER_IDS = [
  'gemini',
  'openai',
  'anthropic',
  'groq',
  'openrouter',
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
  'ollama',
  'openai_compatible',
] as const;

export const SECTIONS: AdminSection[] = [
  {
    id: 'routing',
    title: 'Model & routing',
    intro: 'Auto uses the strongest provider that has a key. If it fails (rate limit, outage, bad key), Orin tries your other keys, then the next provider, and finally free Pollinations.',
    cards: [
      {
        id: 'routing',
        title: 'Which AI answers',
        test: 'none',
        fields: [
          { env: 'AI_PROVIDER', label: 'Primary provider', secret: false, options: ['auto', ...CHAT_PROVIDER_IDS, 'pollinations', 'demo'] },
          { env: 'AI_CHAT_MODEL', label: 'Main model override (primary only)', secret: false, placeholder: 'Provider default' },
          { env: 'AI_FAST_MODEL', label: 'Fast model override (titles, summaries)', secret: false, placeholder: 'Provider default' },
          { env: 'AI_VISION_MODEL', label: 'Vision model override', secret: false, placeholder: 'Provider default' },
          {
            env: 'AI_FALLBACK_ORDER',
            label: 'Fallback order',
            secret: false,
            placeholder: 'e.g. groq,openrouter (empty = every keyed provider, strongest first; off = none)',
            help: 'Comma-separated provider ids. Pollinations (free) is always tried last when enabled.',
          },
          { env: 'POLLINATIONS_ENABLED', label: 'Free Pollinations as last resort', secret: false, options: ['true', 'false'] },
        ],
      },
    ],
  },
  {
    id: 'chat',
    title: 'AI chat providers',
    intro: 'Paste one key, or several separated by commas: extra keys are rotated when one hits its limit.',
    cards: [
      chatCard('gemini', 'Google Gemini (free tier)', 'GEMINI_API_KEY', 'https://aistudio.google.com/apikey', 'GEMINI_MODEL', 'gemini-3.5-flash'),
      chatCard('openai', 'OpenAI', 'OPENAI_API_KEY', 'https://platform.openai.com/api-keys', 'OPENAI_MODEL', 'gpt-4.1-mini', 'Also powers natural server voices (speech in and out).'),
      chatCard('anthropic', 'Anthropic Claude', 'ANTHROPIC_API_KEY', 'https://console.anthropic.com/settings/keys', 'ANTHROPIC_MODEL', 'claude-sonnet-4-5'),
      chatCard('groq', 'Groq (free tier)', 'GROQ_API_KEY', 'https://console.groq.com/keys', 'GROQ_MODEL', 'openai/gpt-oss-120b', 'Also gives free voice input (Whisper).'),
      chatCard('openrouter', 'OpenRouter', 'OPENROUTER_API_KEY', 'https://openrouter.ai/keys', 'OPENROUTER_MODEL', 'openrouter/free'),
      chatCard('deepseek', 'DeepSeek', 'DEEPSEEK_API_KEY', 'https://platform.deepseek.com/api_keys', 'DEEPSEEK_MODEL', 'deepseek-v4-flash'),
      chatCard('mistral', 'Mistral', 'MISTRAL_API_KEY', 'https://console.mistral.ai/api-keys', 'MISTRAL_MODEL', 'mistral-large-latest'),
      chatCard('xai', 'xAI Grok', 'XAI_API_KEY', 'https://console.x.ai', 'XAI_MODEL', 'grok-4'),
      chatCard('together', 'Together AI', 'TOGETHER_API_KEY', 'https://api.together.ai/settings/api-keys', 'TOGETHER_MODEL', 'openai/gpt-oss-120b'),
      chatCard('fireworks', 'Fireworks AI', 'FIREWORKS_API_KEY', 'https://fireworks.ai/account/api-keys', 'FIREWORKS_MODEL', 'accounts/fireworks/models/gpt-oss-120b'),
      chatCard('cerebras', 'Cerebras (free tier)', 'CEREBRAS_API_KEY', 'https://cloud.cerebras.ai', 'CEREBRAS_MODEL', 'gpt-oss-120b'),
      chatCard('perplexity', 'Perplexity', 'PERPLEXITY_API_KEY', 'https://www.perplexity.ai/settings/api', 'PERPLEXITY_MODEL', 'sonar-pro', 'Answers with web search built in; no tool calling, so not used for the agent.'),
      chatCard('cohere', 'Cohere', 'COHERE_API_KEY', 'https://dashboard.cohere.com/api-keys', 'COHERE_MODEL', 'command-a-03-2025'),
      chatCard('huggingface', 'Hugging Face', 'HF_TOKEN', 'https://huggingface.co/settings/tokens', 'HF_MODEL', 'openai/gpt-oss-120b', 'Token needs the "Make calls to Inference Providers" permission.'),
      {
        id: 'azure',
        title: 'Azure OpenAI',
        link: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI',
        linkText: 'Azure portal',
        note: 'Key and endpoint are under your resource → Keys and Endpoint. The deployment is the name you gave the model.',
        test: 'chat',
        fields: [
          key('AZURE_OPENAI_API_KEY'),
          { env: 'AZURE_OPENAI_ENDPOINT', label: 'Endpoint', secret: false, placeholder: 'https://my-resource.openai.azure.com' },
          { env: 'AZURE_OPENAI_DEPLOYMENT', label: 'Deployment name', secret: false, placeholder: 'my-gpt-deployment' },
        ],
      },
      {
        id: 'ollama',
        title: 'Ollama (your own computer, no key)',
        link: 'https://ollama.com/download',
        linkText: 'Install Ollama',
        note: 'Only works if this server can reach your Ollama. Choose it as primary, or add "ollama" to the fallback order.',
        test: 'ollama',
        fields: [
          { env: 'OLLAMA_BASE_URL', label: 'Base URL', secret: false, placeholder: 'http://localhost:11434' },
          model('OLLAMA_MODEL', 'gemma3'),
        ],
      },
      {
        id: 'openai_compatible',
        title: 'Custom OpenAI-compatible endpoint',
        note: 'Any service with an OpenAI-style /chat/completions API (LM Studio, vLLM, LiteLLM, a proxy...).',
        test: 'chat',
        fields: [
          { env: 'CUSTOM_BASE_URL', label: 'Base URL', secret: false, placeholder: 'https://example.com/v1' },
          { ...key('CUSTOM_API_KEY'), label: 'API key (if needed)' },
          { env: 'CUSTOM_MODEL', label: 'Model', secret: false, placeholder: 'model-name' },
        ],
      },
    ],
  },
  {
    id: 'search',
    title: 'Web search',
    intro: 'Without a key Orin uses DuckDuckGo + Wikipedia. With one, the first working one here is used.',
    cards: [
      { id: 'tavily', title: 'Tavily', link: 'https://app.tavily.com/home', linkText: 'Get a key', test: 'search', fields: [key('TAVILY_API_KEY')] },
      { id: 'brave', title: 'Brave Search', link: 'https://api-dashboard.search.brave.com/app/keys', linkText: 'Get a key', test: 'search', fields: [key('BRAVE_API_KEY')] },
      { id: 'serper', title: 'Serper (Google results)', link: 'https://serper.dev/api-key', linkText: 'Get a key', test: 'search', fields: [key('SERPER_API_KEY')] },
      { id: 'exa', title: 'Exa', link: 'https://dashboard.exa.ai/api-keys', linkText: 'Get a key', test: 'search', fields: [key('EXA_API_KEY')] },
    ],
  },
  {
    id: 'voice',
    title: 'Voice',
    intro: 'OpenAI TTS/STT uses the OpenAI key above, and Groq gives free voice input. Without any, the phone speaks with its own voices.',
    cards: [
      {
        id: 'elevenlabs',
        title: 'ElevenLabs (voices + speech-to-text)',
        link: 'https://elevenlabs.io/app/settings/api-keys',
        linkText: 'Get a key',
        test: 'elevenlabs',
        fields: [key('ELEVENLABS_API_KEY'), { env: 'ELEVENLABS_VOICE_ID', label: 'Voice ID (optional)', secret: false, placeholder: 'First voice in your account' }],
      },
      { id: 'deepgram', title: 'Deepgram (speech-to-text + Aura voices)', link: 'https://console.deepgram.com', linkText: 'Get a key', test: 'deepgram', fields: [key('DEEPGRAM_API_KEY')] },
      {
        id: 'voice_routing',
        title: 'Which voice service',
        test: 'none',
        fields: [
          { env: 'VOICE_PROVIDER', label: 'Speech-to-text', secret: false, options: ['auto', 'openai', 'groq', 'elevenlabs', 'deepgram', 'none'] },
          { env: 'TTS_PROVIDER', label: 'Spoken replies (server voice)', secret: false, options: ['auto', 'openai', 'elevenlabs', 'deepgram', 'none'] },
        ],
      },
    ],
  },
  {
    id: 'sandbox',
    title: 'Code sandbox',
    intro: 'Lets the agent run code safely in the cloud. Off until a key is set.',
    cards: [{ id: 'e2b', title: 'E2B', link: 'https://e2b.dev/dashboard', linkText: 'Get a key', test: 'e2b', fields: [{ ...key('E2B_API_KEY'), pool: false }] }],
  },
  {
    id: 'google',
    title: 'Google (Gmail & Calendar)',
    intro: 'An OAuth client of type "Web application". Add the redirect URL shown below to it in Google Cloud.',
    cards: [
      {
        id: 'google',
        title: 'Google OAuth client',
        link: 'https://console.cloud.google.com/apis/credentials',
        linkText: 'Google Cloud credentials',
        test: 'google',
        fields: [
          { env: 'GOOGLE_CLIENT_ID', label: 'Client ID', secret: false, placeholder: '...apps.googleusercontent.com' },
          { env: 'GOOGLE_CLIENT_SECRET', label: 'Client secret', secret: true, placeholder: 'Paste secret' },
        ],
      },
    ],
  },
];

export function findCard(id: string): AdminCard | undefined {
  for (const s of SECTIONS) for (const c of s.cards) if (c.id === id) return c;
  return undefined;
}

/** Every variable the admin page manages (reloaded from .env on save). */
export const MANAGED_ENV: string[] = SECTIONS.flatMap((s) => s.cards.flatMap((c) => c.fields.map((f) => f.env)));
