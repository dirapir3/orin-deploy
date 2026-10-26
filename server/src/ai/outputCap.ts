import { AppError } from '../errors.js';

/**
 * Output token caps. The agent asks for a big budget (config.agent.maxOutputTokens, 32k by default)
 * because a thinking model spends part of it thinking and a single file written through a tool
 * call can be well over 10k tokens. Each endpoint only accepts up to some limit, so cap per host,
 * and if an endpoint still rejects the number (older or smaller models), retry lower.
 */
export function outputCap(baseUrl: string, model: string): number {
  const u = baseUrl.toLowerCase();
  const m = model.toLowerCase();
  if (u.includes('generativelanguage.googleapis.com')) return /gemini-1\./.test(m) ? 8192 : 65536;
  if (u.includes('anthropic.com')) return /claude-3-(haiku|opus|sonnet)|claude-2/.test(m) ? 4096 : /claude-3-5|claude-3\.5/.test(m) ? 8192 : 32000;
  if (u.includes('pollinations')) return 8192;
  if (u.includes('groq.com')) return 32768;
  if (u.includes('api.openai.com')) return /^(gpt-5|gpt-6|o\d)/.test(m) ? 65536 : /^gpt-4\.1/.test(m) ? 32768 : 16384;
  return 16384;
}

/** The next lower budget to retry with after a 400 that looks like "max_tokens too large", or null. */
export function lowerOutputBudget(current: number, err: unknown): number | null {
  if (!(err instanceof AppError) || err.code !== 'provider_bad_request' || !err.message.includes('output token')) return null;
  if (current > 8192) return 8192;
  if (current > 4096) return 4096;
  return null;
}
