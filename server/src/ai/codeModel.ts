/**
 * Coding work goes to the strongest coding model the user's own gateway offers.
 *
 * A gateway key (OmniRoute, OpenRouter, .route, a custom endpoint) reaches many models, but the
 * user picks one model in AI setup, usually a quick one for chat. When a turn carries the full
 * work toolkit (building, coding, deploying), this asks the gateway for its model list, ranks the
 * models by how good they are at code, and sends the step to the best one. If that model fails
 * (no credit, not set up in the gateway, rate limited), it tries the next, then the user's own
 * model, then the server's backup chain. Voice turns and small talk never come here.
 */
import { AppError } from '../errors.js';
import type { ChatChunk, ChatProvider, ChatRequest } from './types.js';

/** providers whose key reaches many vendors' models through one endpoint */
export const GATEWAYS = new Set(['omniroute', 'openrouter', 'dotroute', 'custom', 'together']);

/** a turn with at least this many tools is work, not small talk (the lite lane has six) */
export const WORK_TOOLS = 14;

const EXCLUDE = /embed|tts|whisper|transcri|speech|audio|image|dall-?e|imagen|flux|stable-?diffusion|sdxl|veo|sora|video|moderation|rerank|guard|search-preview|realtime|-instruct-?\d*$|vision-preview|ocr|computer-use/i;
const SMALL = /(^|[-_/:.])(mini|nano|lite|tiny|small|haiku|flash-?8b|1\.5b|3b|7b|8b|9b|12b|14b)(\b|[-_/:.]|$)/i;

/** [pattern, score]: the first match wins. Higher is better at long agentic coding. */
const RANKS: [RegExp, number][] = [
  [/claude[-_. ]?(opus)|opus[-_. ]?4|claude-4[-.]?\d*-opus/i, 100],
  [/gpt-?5[\w.-]*codex|codex[-_ ]?(max|1|2)?/i, 99],
  [/claude[-_. ]?(sonnet)|sonnet[-_. ]?[45]/i, 97],
  [/gpt-?5(\.\d+)?(-pro|-high)?\b/i, 94],
  [/gemini[-_. ]?([3-9](\.\d+)?)[-_. ]?pro/i, 93],
  [/grok[-_. ]?code|grok[-_. ]?[4-9]/i, 90],
  [/kimi[-_. ]?k2|moonshot.*k2/i, 89],
  [/qwen[-_. ]?3[\w.-]*coder|qwen[\w.-]*coder[-_. ]?(plus|480b)/i, 89],
  [/glm[-_. ]?(4\.[5-9]|[5-9])/i, 88],
  [/gemini[-_. ]?2\.5[-_. ]?pro/i, 87],
  [/deepseek[-_. ]?(v3\.[1-9]|v[4-9]|r[12]|chat|reasoner|coder)/i, 86],
  [/minimax[-_. ]?m[12]/i, 84],
  [/claude[-_. ]?3[.-]?7|claude-3-5-sonnet/i, 84],
  [/qwen[-_. ]?3/i, 80],
  [/devstral|codestral|mistral[-_. ]?(large|medium)/i, 78],
  [/gpt-?4\.1|gpt-?4o|o[34](-high)?\b/i, 78],
  [/gpt-?oss[-_. ]?120b/i, 76],
  [/gemini[-_. ]?[2-9](\.\d+)?[-_. ]?flash/i, 72],
  [/llama[-_. ]?(4|3\.3)[\w.-]*(maverick|70b|405b)/i, 66],
];

/** model families that read pictures; text-only coders (DeepSeek, Qwen-Coder, Kimi K2, GLM 4.x, gpt-oss...) are not on it */
const VISION = /claude|gpt-?(4o|4\.1|5)|\bo[34]\b|gemini|grok[-_. ]?[4-9]|llama[-_. ]?4|qwen[\w.-]*vl|qwen[-_. ]?3\.5|glm[-_. ]?[\d.]+v|kimi[-_. ]?(k2\.5|vl)|pixtral|mistral[-_. ]?medium|minimax[-_. ]?m2\.5|vision/i;
export function likelyVision(id: string): boolean {
  return VISION.test(id) && !/coder|codex-mini|deepseek/i.test(id);
}

function version(id: string): number {
  // later versions of one family rank a little higher: claude-opus-4-5 over claude-opus-4
  const nums = id.match(/\d+(\.\d+)?/g)?.map(Number).filter((n) => n < 100) ?? [];
  return nums.slice(0, 2).reduce((a, n, i) => a + n / (i ? 100 : 10), 0);
}

/** how good this model id is at coding, or null for models that cannot do the work at all */
export function codeScore(id: string): number | null {
  if (!id || EXCLUDE.test(id)) return null;
  const hit = RANKS.find(([re]) => re.test(id));
  if (!hit) return null;
  let s = hit[1] + Math.min(version(id), 0.99);
  if (SMALL.test(id)) s -= 25;
  if (/preview|exp(erimental)?\b/i.test(id)) s -= 0.5;
  if (/thinking|reason|high/i.test(id)) s += 0.3;
  return s;
}

/**
 * The best coding models in a list, best first. When the user's own pick is a free model, only
 * free models are taken (so a free gateway account never meets a paid model's "no credit").
 */
export function rankCodeModels(ids: string[], userModel: string): string[] {
  const freeOnly = /(^|[:/-])free\b/i.test(userModel);
  const own = codeScore(userModel) ?? 0;
  return [...new Set(ids)]
    .filter((id) => !freeOnly || /(^|[:/-])free\b/i.test(id))
    .map((id) => ({ id, s: codeScore(id) }))
    .filter((m): m is { id: string; s: number } => m.s !== null && m.s > own + 1)
    .sort((a, b) => b.s - a.s || a.id.length - b.id.length)
    .map((m) => m.id);
}

export interface CodeRouterOptions {
  /** the user's chain: their own model first, then the server's backup */
  base: ChatProvider;
  /** their key at a given model */
  pinned: (model: string) => ChatProvider;
  /** the gateway's model list (cached by the caller) */
  listModels: () => Promise<string[]>;
  userModel: string;
  providerLabel: string;
  /** an explicit coding model the user chose; skips the ranking */
  preferred?: string;
  now?: () => number;
}

/** models that failed for this key, and until when to leave them alone */
const resting = new Map<string, number>();

export function codeRouter(o: CodeRouterOptions): ChatProvider {
  const now = o.now ?? Date.now;
  let picks: Promise<string[]> | null = null;
  let pickedAt = 0;
  const candidates = async (): Promise<string[]> => {
    if (o.preferred) return [o.preferred];
    if (!picks || now() - pickedAt > 6 * 3600_000) {
      pickedAt = now();
      picks = Promise.race([
        o.listModels().then((ids) => rankCodeModels(ids, o.userModel)),
        new Promise<string[]>((r) => setTimeout(() => r([]), 6_000)),
      ]).catch(() => [] as string[]);
      // an empty answer (gateway asleep, list timed out) is asked again in a minute, not in six hours
      void picks.then((p) => {
        if (!p.length) pickedAt = now() - 6 * 3600_000 + 60_000;
      });
    }
    return picks;
  };
  const key = (m: string) => `${o.providerLabel}|${m}`;
  return {
    id: o.base.id,
    displayName: o.base.displayName,
    isDemo: o.base.isDemo,
    supportsVision: o.base.supportsVision,
    supportsTools: o.base.supportsTools,
    async *streamChat(req: ChatRequest): AsyncGenerator<ChatChunk> {
      const work = !req.fast && (req.tools?.length ?? 0) >= WORK_TOOLS;
      // a turn carrying a picture (a design to build) needs a model that can see it
      const seesPictures = req.messages.some((m) => (m.images?.length ?? 0) > 0);
      if (work) {
        const list = (await candidates()).filter((m) => (resting.get(key(m)) ?? 0) < now() && (!seesPictures || likelyVision(m))).slice(0, 2);
        for (const model of list) {
          let sent = false;
          try {
            for await (const chunk of o.pinned(model).streamChat({ ...req, model })) {
              if (!sent) {
                sent = true;
                yield { type: 'served', provider: `user:${o.providerLabel}`, model };
              }
              if (chunk.type !== 'served') yield chunk;
            }
            return;
          } catch (e) {
            if (sent || req.signal?.aborted || (e instanceof AppError && e.code === 'cancelled')) throw e;
            const code = e instanceof AppError ? e.code : 'provider_error';
            // a passing limit rests the model briefly; "no such model" or "no credit" for an hour
            const rest = code === 'provider_rate_limited' || code === 'timeout' || code === 'provider_unavailable' ? 2 * 60_000 : 60 * 60_000;
            resting.set(key(model), now() + rest);
            console.warn(`[code-model] ${o.providerLabel} ${model} failed (${code}: ${(e as Error).message.slice(0, 100)}); resting ${rest / 60_000} min`);
          }
        }
      }
      yield* o.base.streamChat(req);
    },
  };
}

/** test hook */
export function _resetCodeRouter() {
  resting.clear();
}
