import type { AppConfig } from '../config.js';
import type { ChatProvider, ProviderMessage } from '../ai/types.js';
import { buildContext } from '../ai/context.js';
import type { ChatRequestBody } from '../schemas.js';
import type { AgentStore, Memory } from './store.js';
import { buildAgentSystemPrompt, type PersonaOptions } from './persona.js';

const KEEP_RECENT = 8;

/**
 * Character budget for the history, derived from the model's context window. Capped at about
 * 8k tokens: every message re-sends the history, and a 120k-character history made each reply slow
 * and used up free-tier token limits fast. Older turns are summarised instead (see below).
 */
export function historyBudget(config: AppConfig): number {
  return Math.min(32_000, Math.max(12_000, Math.floor(config.chat.caps.maxContext * 1.6)));
}

/** Refresh the cached summary only after this many new older messages, not on every message. */
const RESUMMARIZE_AFTER = 10;

async function summarize(provider: ChatProvider, model: string, previous: string, msgs: ProviderMessage[], signal: AbortSignal): Promise<string> {
  const transcript = msgs
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.slice(0, 4000)}`)
    .join('\n');
  let out = '';
  for await (const c of provider.streamChat({
    model,
    maxOutputTokens: 600,
    temperature: 0.2,
    signal,
    messages: [
      { role: 'system', content: 'Summarise the conversation so far for your own memory: key facts, decisions, user preferences, open questions and anything promised. Max 200 words, plain text.' },
      { role: 'user', content: `${previous ? `Earlier summary:\n${previous}\n\n` : ''}New messages:\n${transcript}` },
    ],
  })) {
    if (c.type === 'delta') out += c.text;
  }
  return out.trim();
}

export interface AgentContextResult {
  messages: ProviderMessage[];
  hasImages: boolean;
  summarized: boolean;
  trimmed: number;
  memories: Memory[];
}

/**
 * Builds the model input: persona + remembered facts + rolling summary of older turns + recent turns.
 * Older turns beyond the budget are summarised with the fast model (cached per conversation) instead
 * of being silently dropped; if summarising fails, the oldest turns are dropped.
 */
export async function buildAgentContext(
  body: ChatRequestBody,
  config: AppConfig,
  deps: { store: AgentStore; owner: string; provider: ChatProvider; signal: AbortSignal; persona: Omit<PersonaOptions, 'memories'> },
): Promise<AgentContextResult> {
  const base = buildContext(body, config, { allowImages: config.chat.supportsVision, budget: Number.POSITIVE_INFINITY });
  let msgs = base.messages.filter((m) => m.role !== 'system');
  // buildContext already trims to its own budget; we apply the model-based budget + summaries.
  const budget = historyBudget(config);
  const size = (list: ProviderMessage[]) => list.reduce((n, m) => n + m.content.length, 0);
  let summary = '';
  let summarized = false;
  let trimmed = base.trimmed;
  const conv = body.conversationId;
  const totalBefore = body.messages.length;
  if (size(msgs) > budget && msgs.length > KEEP_RECENT) {
    const cut = msgs.length - KEEP_RECENT;
    const older = msgs.slice(0, cut);
    const cached = conv ? deps.store.getSummary(deps.owner, conv) : null;
    // `upto` counts how many messages of the full conversation the summary covers.
    const coveredInOlder = cached ? Math.max(0, cached.upto - (totalBefore - msgs.length)) : 0;
    try {
      if (cached && coveredInOlder >= older.length) summary = cached.summary;
      else if (cached && coveredInOlder > 0 && older.length - coveredInOlder < RESUMMARIZE_AFTER) {
        // Reuse the summary and keep the few messages it does not cover yet, instead of an extra
        // AI call on every message once a chat is long.
        summary = cached.summary;
        msgs = msgs.slice(coveredInOlder);
        summarized = true;
        trimmed += coveredInOlder;
      } else {
        summary = await summarize(deps.provider, config.chat.fastModel, cached?.summary ?? '', older.slice(coveredInOlder), deps.signal);
        if (conv && summary && !deps.persona.incognito) deps.store.setSummary(deps.owner, conv, totalBefore - msgs.length + cut, summary);
      }
      if (summary && !summarized) {
        msgs = msgs.slice(cut);
        summarized = true;
        trimmed += cut;
      }
    } catch {
      /* fall through to dropping */
    }
  }
  while (msgs.length > 1 && size(msgs) > budget) {
    msgs.shift();
    trimmed++;
  }
  while (msgs.length > 1 && msgs[0]!.role !== 'user') {
    msgs.shift();
    trimmed++;
  }
  const lastUser = [...body.messages].reverse().find((m) => m.role === 'user')?.content ?? '';
  const relevant = deps.persona.incognito ? [] : deps.store.searchMemories(deps.owner, lastUser, 8);
  const recent = deps.persona.incognito ? [] : deps.store.listMemories(deps.owner, 20);
  const memories = [...relevant, ...recent.filter((m) => !relevant.some((r) => r.id === m.id))].slice(0, 25);
  const system = buildAgentSystemPrompt(body.preferences, body.mode, { ...deps.persona, memories });
  const out: ProviderMessage[] = [{ role: 'system', content: system }];
  if (summary) out.push({ role: 'system', content: `Summary of the earlier part of this conversation:\n${summary}` });
  out.push(...msgs);
  return { messages: out, hasImages: base.hasImages, summarized, trimmed, memories };
}
