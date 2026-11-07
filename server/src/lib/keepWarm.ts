/**
 * Keep-warm (task "make app responses smooth"): Render's free plan puts the server to sleep after
 * about 15 minutes without a request, and the next visit then waits for a cold start (measured: 83 s
 * before the first reply). While the app has been used recently, the server pings its own public
 * address every 10 minutes so it stays awake. After KEEP_WARM_HOURS without a real request (default
 * 24) it stops and lets the server sleep, so a forgotten app does not burn the free monthly hours.
 * KEEP_WARM_HOURS=0 turns it off; "always" never stops.
 */
let lastActivity = Date.now();

/** Called for every real request (not the self-ping), see app.ts. */
export function noteActivity(now = Date.now()): void {
  lastActivity = now;
}

export function keepWarmWindowMs(env: NodeJS.ProcessEnv = process.env): number {
  const v = (env.KEEP_WARM_HOURS ?? '24').trim().toLowerCase();
  if (v === 'always') return Number.POSITIVE_INFINITY;
  const h = Number(v);
  return Number.isFinite(h) && h > 0 ? h * 3_600_000 : 0;
}

/** Whether a ping is due: the app was used within the window. */
export function shouldPing(now: number, windowMs: number, last = lastActivity): boolean {
  return windowMs > 0 && now - last < windowMs;
}

export function startKeepWarm(opts: { url?: string; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; everyMs?: number; log?: (msg: string) => void } = {}): (() => void) | null {
  const env = opts.env ?? process.env;
  const base = (opts.url ?? env.RENDER_EXTERNAL_URL ?? '').replace(/\/+$/, '');
  const windowMs = keepWarmWindowMs(env);
  if (!base || !/^https:\/\//.test(base) || windowMs === 0) return null;
  const f = opts.fetchImpl ?? fetch;
  const timer = setInterval(() => {
    if (!shouldPing(Date.now(), windowMs)) return;
    // through the public address on purpose: only outside traffic counts as activity on Render
    void f(`${base}/v1/health?warm=1`, { headers: { 'X-Orin-Keep-Warm': '1' }, signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
  }, opts.everyMs ?? 10 * 60_000);
  timer.unref?.();
  opts.log?.(`Keep-warm on: pinging ${base} every ${Math.round((opts.everyMs ?? 600_000) / 60_000)} min while the app was used in the last ${Number.isFinite(windowMs) ? `${windowMs / 3_600_000} h` : 'forever'}`);
  return () => clearInterval(timer);
}
