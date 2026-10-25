import { AppError } from '../errors.js';
import { KeyHealth } from './keyHealth.js';
import type { ChatChunk, ChatProvider, ChatRequest } from './types.js';

/** One concrete provider + key, with the models it should use. */
export interface FallbackCandidate {
  provider: ChatProvider;
  /** provider id (gemini, groq, ...): keys of one provider form one group */
  group: string;
  /** for logs, never contains the key: e.g. "gemini key 2/3" */
  label: string;
  model: string;
  fastModel: string;
  visionModel: string;
  supportsVision: boolean;
  /** Other models of the same provider/key to try when the requested one is overloaded or rate limited. */
  altModels?: string[];
  /** hash of the key (see keyHealth.keyId): health is tracked per key, across reloads */
  keyId?: string;
}

export interface FallbackEvent {
  label: string;
  code: string;
  message: string;
}

/** Errors where another key or provider may well succeed. */
export function isFallbackError(e: unknown): boolean {
  if (e instanceof AppError) {
    switch (e.code) {
      case 'invalid_api_key':
      case 'provider_rate_limited':
      case 'provider_unavailable':
      case 'timeout':
        return true;
      case 'provider_bad_request':
        // 404 = model not found / not available to this key
        return /HTTP 404/.test(e.message);
      default:
        return false;
    }
  }
  const name = (e as Error | undefined)?.name;
  return name !== 'AbortError';
}

function cooldownMs(e: unknown): number {
  if (!(e instanceof AppError)) return 15_000;
  if (e.code === 'invalid_api_key') return 10 * 60_000;
  if (e.code === 'provider_bad_request') return 10 * 60_000;
  if (e.code === 'provider_rate_limited') {
    // Daily quota used up: rest the key for an hour; per-minute limits for a short while.
    if (/per day|daily|PerDay/i.test(e.message)) return 60 * 60_000;
    return e.retryable ? 30_000 : 5 * 60_000;
  }
  return 20_000;
}

const hasImages = (req: ChatRequest) => req.messages.some((m) => (m.images?.length ?? 0) > 0);

/**
 * Tries each key of the primary provider, then each fallback provider in order, on rate limits,
 * outages, timeouts and rejected keys. Only before the first chunk: once text has streamed the
 * error is passed through (a half answer from two models would be worse).
 */
export class FallbackChatProvider implements ChatProvider {
  readonly id: string;
  readonly displayName: string;
  readonly isDemo = false;
  readonly supportsVision: boolean;
  readonly supportsTools: boolean;
  private readonly groups: { id: string; items: FallbackCandidate[]; cursor: number }[] = [];
  private readonly cooling: Map<string, number>;
  private readonly health: KeyHealth;
  private readonly now: () => number;
  private readonly onFallback: (ev: FallbackEvent) => void;

  constructor(
    private readonly candidates: FallbackCandidate[],
    opts: { now?: () => number; onFallback?: (ev: FallbackEvent) => void; health?: KeyHealth } = {},
  ) {
    if (candidates.length === 0) throw new Error('FallbackChatProvider needs at least one candidate');
    const primary = candidates[0]!;
    this.id = primary.provider.id;
    this.displayName = primary.provider.displayName;
    this.supportsVision = primary.supportsVision;
    this.supportsTools = candidates.every((c) => c.provider.supportsTools);
    for (const c of candidates) {
      let g = this.groups.find((x) => x.id === c.group);
      if (!g) {
        g = { id: c.group, items: [], cursor: 0 };
        this.groups.push(g);
      }
      g.items.push(c);
    }
    this.health = opts.health ?? new KeyHealth();
    this.cooling = this.health.cooling;
    this.now = opts.now ?? Date.now;
    this.onFallback = opts.onFallback ?? ((ev) => console.warn(`[ai] ${ev.label} failed (${ev.code}); trying the next key/provider`));
  }

  /** Round robin: the next request in this group starts at its next key (spreads use across keys). */
  rotate(group: string): void {
    const g = this.groups.find((x) => x.id === group);
    if (g && g.items.length > 1) g.cursor = (g.cursor + 1) % g.items.length;
  }

  /** Labels of the chain in order (no keys), for health/admin. */
  describe(): { label: string; group: string; model: string; coolingFor: number; keyId: string; ok: number; fail: number; lastError: string }[] {
    const t = this.now();
    return this.candidates.map((c) => {
      const h = this.health.status(this.kid(c), t);
      return { label: c.label, group: c.group, model: c.model, coolingFor: h.coolingFor, keyId: c.keyId ?? '', ok: h.ok, fail: h.fail, lastError: h.lastError };
    });
  }

  /** Health/cooldown id of a candidate: the key's hash when known, else its label. */
  private kid(c: FallbackCandidate): string {
    return c.keyId ? c.keyId : c.label;
  }

  /** Order for one request: groups in order, each group's keys starting at its cursor; cooling ones last. */
  plan(req: ChatRequest): FallbackCandidate[] {
    const t = this.now();
    const ready: FallbackCandidate[] = [];
    const cool: FallbackCandidate[] = [];
    const images = hasImages(req);
    for (const g of this.groups) {
      const n = g.items.length;
      for (let i = 0; i < n; i++) {
        const c = g.items[(g.cursor + i) % n]!;
        if (images && !c.supportsVision) continue;
        if ((this.cooling.get(this.kid(c)) ?? 0) > t) cool.push(c);
        else ready.push(c);
      }
    }
    return [...ready, ...cool];
  }

  private modelFor(c: FallbackCandidate, req: ChatRequest): string {
    const primary = this.candidates[0]!;
    if (c.group === primary.group) return req.model;
    if (req.model === primary.fastModel && primary.fastModel !== primary.model) return c.fastModel;
    if (hasImages(req)) return c.visionModel;
    return c.model;
  }

  /** Models to try for one candidate: the requested one, then its alternates; models cooling down go last. */
  private modelsFor(c: FallbackCandidate, req: ChatRequest): string[] {
    const first = this.modelFor(c, req);
    const all = [first, ...(c.altModels ?? []).filter((m) => m && m !== first)];
    if (all.length === 1) return all;
    const t = this.now();
    const ready = all.filter((m) => (this.cooling.get(`${this.kid(c)}|${m}`) ?? 0) <= t);
    const cool = all.filter((m) => !ready.includes(m));
    return [...ready, ...cool];
  }

  async *streamChat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const plan = this.plan(req);
    if (plan.length === 0) {
      throw new AppError('vision_not_supported', `${this.displayName} cannot read images.`);
    }
    const errors: { label: string; err: unknown }[] = [];
    // Skip keys and models that are resting after a rate limit or outage while anything fresh is
    // left. Retrying a model that just said "quota used up" costs a round trip on every message and
    // on every tool step, which is what made replies slow when the main Gemini model was over quota.
    // When everything is resting, try it all anyway (the soonest-to-recover order is kept).
    const t0 = this.now();
    const fresh = (c: FallbackCandidate, m: string) =>
      (this.cooling.get(this.kid(c)) ?? 0) <= t0 && (this.cooling.get(`${this.kid(c)}|${m}`) ?? 0) <= t0;
    const anyFresh = plan.some((c) => this.modelsFor(c, req).some((m) => fresh(c, m)));
    for (const c of plan) {
      const allModels = this.modelsFor(c, req);
      const models = anyFresh ? allModels.filter((m) => fresh(c, m)) : allModels;
      if (models.length === 0) continue;
      let lastErr: unknown = null;
      for (const model of models) {
        let started = false;
        try {
          for await (const chunk of c.provider.streamChat({ ...req, model })) {
            if (!started) {
              started = true;
              yield { type: 'served', provider: c.group, model };
            }
            yield chunk;
          }
          const g = this.groups.find((x) => x.id === c.group)!;
          g.cursor = g.items.indexOf(c);
          this.cooling.delete(this.kid(c));
          this.cooling.delete(`${this.kid(c)}|${model}`);
          this.health.recordOk(this.kid(c), this.now());
          return;
        } catch (err) {
          if (started || req.signal.aborted || !isFallbackError(err)) throw err;
          lastErr = err;
          // A bad key fails for every model; anything else may be specific to this model.
          if (allModels.length > 1) this.cooling.set(`${this.kid(c)}|${model}`, this.now() + Math.max(cooldownMs(err), 60_000));
          const label = allModels.length > 1 ? `${c.label} ${model}` : c.label;
          this.onFallback({ label, code: err instanceof AppError ? err.code : 'error', message: (err as Error).message });
          if (err instanceof AppError && err.code === 'invalid_api_key') break;
        }
      }
      const err = lastErr;
      this.cooling.set(this.kid(c), this.now() + cooldownMs(err));
      this.health.recordFail(this.kid(c), this.now(), err instanceof AppError ? err.code : 'error', (err as Error)?.message ?? '');
      const g = this.groups.find((x) => x.id === c.group)!;
      if (g.items.length > 1 && g.items[g.cursor] === c) g.cursor = (g.cursor + 1) % g.items.length;
      errors.push({ label: c.label, err });
    }
    if (errors.length === 1) throw errors[0]!.err;
    const first = errors[0]!.err;
    const code = first instanceof AppError ? first.code : 'provider_unavailable';
    const summary = errors.map((e) => `${e.label}: ${e.err instanceof AppError ? e.err.code : 'error'}`).join(', ');
    throw new AppError(code === 'invalid_api_key' ? 'provider_unavailable' : code, `All AI providers failed (${summary}).`);
  }
}
