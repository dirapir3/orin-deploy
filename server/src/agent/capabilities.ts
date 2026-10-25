import type { AppConfig } from '../config.js';
import type { Providers } from '../ai/registry.js';
import type { AgentRuntime } from './runtime.js';
import { codeSandboxNeeds, browserNeeds } from './tools/adapters.js';
import { googleConfigured } from './connectors.js';

export interface Capability {
  id: string;
  name: string;
  live: boolean;
  /** what powers it right now */
  via: string | null;
  /** what is missing (when not live) */
  needs: string | null;
  /** optional upgrade that makes it better */
  upgrade: string | null;
}

/** Exactly which capabilities are live and which need which key/service. Never includes key values. */
export function capabilityReport(config: AppConfig, providers: Providers, agent: AgentRuntime | undefined, owner?: string): Capability[] {
  const c = config.chat;
  const chatReal = Boolean(providers.chat && !providers.chat.isDemo);
  const agentOn = Boolean(agent?.enabled && providers.agent);
  const worker = config.agent.worker;
  const i = config.integrations;
  const svc = agent?.services;
  const noAgent = chatReal ? `a tool-capable model (current: ${c.displayName} has no tool support)` : 'an AI model (POLLINATIONS_ENABLED=1, or a key)';
  const cap = (id: string, name: string, live: boolean, via: string | null, needs: string | null, upgrade: string | null = null): Capability => ({ id, name, live, via: live ? via : null, needs: live ? null : needs, upgrade });
  const searchVia = i.tavilyKey ? 'Tavily' : i.braveKey ? 'Brave Search' : i.serperKey ? 'Serper' : i.exaKey ? 'Exa' : 'DuckDuckGo + Wikipedia (free)';
  const googleConnected = Boolean(owner && agent?.store.getConnection(owner, 'google'));
  const strongest = 'ANTHROPIC_API_KEY or OPENAI_API_KEY (strongest), GEMINI_API_KEY (free tier)';
  return [
    cap('chat', 'Chat', chatReal, `${c.displayName} · ${c.model}`, 'POLLINATIONS_ENABLED=1 or any AI key', c.provider === 'pollinations' ? strongest : null),
    cap('agent', 'Tools & actions (agent)', agentOn, `${c.displayName} function calling`, noAgent),
    cap('vision', 'Understand photos', chatReal && c.supportsVision, c.displayName, 'GEMINI_API_KEY (free), OPENAI_API_KEY or ANTHROPIC_API_KEY'),
    cap('voice_input', 'Voice input (speech to text)', Boolean(providers.voice), providers.voice ? `${providers.voice.id} · ${providers.voice.sttModel}` : null, 'GROQ_API_KEY (free) or OPENAI_API_KEY'),
    cap('voice_output', 'Spoken replies', true, 'Phone voices (on-device)', null, providers.voice?.supportsTts ? null : 'OPENAI_API_KEY for natural server voices'),
    cap('web_search', 'Web search with sources', agentOn, searchVia, noAgent, i.tavilyKey || i.braveKey || i.serperKey || i.exaKey ? null : 'A Tavily, Brave, Serper or Exa key (admin page) for better results'),
    cap('fetch_page', 'Read web pages', agentOn, 'Built-in reader', noAgent),
    cap('memory', 'Long-term memory', agentOn, 'Server memory store (SQLite)', noAgent),
    cap('notes', 'Notes', agentOn, 'Server notes (SQLite)', noAgent),
    cap('reminders', 'Reminders', agentOn, 'Phone notifications', noAgent),
    cap('image_generation', 'Create images', agentOn && i.imageProvider !== 'none', i.imageProvider === 'pollinations' ? 'Pollinations (free)' : i.imageProvider === 'gemini' ? 'Gemini' : 'OpenAI gpt-image-1', agentOn ? 'POLLINATIONS_ENABLED=1, GEMINI_API_KEY or OPENAI_API_KEY' : noAgent, i.imageProvider === 'pollinations' ? 'OPENAI_API_KEY or GEMINI_API_KEY (paid) for higher quality' : null),
    cap('calculator', 'Calculator & date/time', agentOn, 'Built-in', noAgent),
    cap('background_tasks', 'Background tasks', agentOn && worker, 'Server job queue (SQLite)', agentOn ? 'WORKER_ENABLED=1' : noAgent),
    cap('deep_research', 'Deep research reports', agentOn && worker, `${searchVia} + ${c.displayName}`, agentOn ? 'WORKER_ENABLED=1' : noAgent),
    cap('schedules', 'Schedules & routines', agentOn && worker, 'Server scheduler (cron)', agentOn ? 'WORKER_ENABLED=1' : noAgent),
    cap('skills', 'Skills', agentOn, 'Saved instruction sets', noAgent),
    cap('code', 'Run code / build apps', agentOn && Boolean(svc) && codeSandboxNeeds(svc!) === null, i.codeSandbox === 'e2b' ? 'E2B sandbox' : 'Docker sandbox', svc ? codeSandboxNeeds(svc) : 'E2B_API_KEY'),
    cap('browser', 'Web browser (JS pages, forms)', agentOn && Boolean(svc) && browserNeeds(svc!) === null, 'Playwright + Chromium', svc ? browserNeeds(svc) : 'BROWSER_ENABLED=1'),
    cap(
      'google',
      'Gmail & Google Calendar',
      agentOn && Boolean(svc) && googleConfigured(svc!) && googleConnected,
      'Google APIs',
      !svc || !googleConfigured(svc) ? 'GOOGLE_CLIENT_ID + GOOGLE_CLIENT_SECRET (+ PUBLIC_URL)' : 'Connect your Google account in Connected apps',
    ),
  ];
}
