import type { SupabaseClient } from '@supabase/supabase-js';
import type { AuthContext } from '../middleware/auth.js';
import { logger } from '../logger.js';

export interface UsageEvent {
  kind: 'chat' | 'title' | 'stt' | 'tts' | 'extract' | 'realtime';
  provider: string;
  model: string;
  status: 'ok' | 'error' | 'cancelled';
  inputTokens?: number;
  outputTokens?: number;
  units?: number;
  durationMs: number;
  errorCode?: string;
}

export interface UsageSink {
  record(auth: AuthContext | undefined, ev: UsageEvent): void;
}

export class LogUsageSink implements UsageSink {
  record(auth: AuthContext | undefined, ev: UsageEvent) {
    logger.info('usage', { who: auth?.kind ?? 'anon', ...ev });
  }
}

/** Writes usage rows with the service role (bypasses RLS). Failures never break a request. */
export class SupabaseUsageSink implements UsageSink {
  constructor(private readonly admin: SupabaseClient) {}
  record(auth: AuthContext | undefined, ev: UsageEvent) {
    void this.admin
      .from('usage_events')
      .insert({
        user_id: auth?.kind === 'user' ? auth.userId : null,
        guest_id: auth?.kind === 'guest' ? auth.guestId.slice(0, 64) : null,
        kind: ev.kind,
        provider: ev.provider,
        model: ev.model,
        status: ev.status,
        input_tokens: ev.inputTokens ?? null,
        output_tokens: ev.outputTokens ?? null,
        units: ev.units ?? null,
        duration_ms: ev.durationMs,
        error_code: ev.errorCode ?? null,
      })
      .then(({ error }) => {
        if (error) logger.warn('usage insert failed', { code: error.code });
      });
  }
}

export class MemoryUsageSink implements UsageSink {
  events: (UsageEvent & { who: string })[] = [];
  record(auth: AuthContext | undefined, ev: UsageEvent) {
    this.events.push({ who: auth?.kind ?? 'anon', ...ev });
  }
}
