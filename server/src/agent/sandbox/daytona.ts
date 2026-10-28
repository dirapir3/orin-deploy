import { assertPublicUrl } from '../net.js';
import { SANDBOX_WORKDIR, shq, type ExecOptions, type ExecResult, type SandboxProvider, type SandboxSession } from './types.js';

/**
 * Daytona (daytona.io) provider, over its documented REST API (no SDK, so no extra dependencies):
 * POST /sandbox to create, GET /sandbox/{id} until it is "started", then the sandbox's toolbox
 * (`${toolboxProxyUrl}/${id}`) for commands and files, POST /sandbox/{id}/autostop/{min} to keep it
 * on and DELETE /sandbox/{id} to end it. Every call carries `Authorization: Bearer <key>`.
 *
 * Daytona's default image runs as the user "daytona"; Orin's workspace path (/home/user/work) is
 * created there so tools and saved files work the same as on E2B. What is NOT the same: no public
 * preview URLs and no live browser view yet (those use E2B's port hosts), and none of the extra
 * tools baked into Orin's E2B workspace image (Android SDK, Chromium, Playwright).
 */

export const DAYTONA_API = 'https://app.daytona.io/api';

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class DaytonaError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'DaytonaError';
  }
}

const cap = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

async function call(f: FetchLike, key: string, url: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const { timeoutMs = 60_000, signal, headers, ...rest } = init;
  const t = AbortSignal.timeout(timeoutMs);
  const res = await f(url, { ...rest, headers: { Authorization: `Bearer ${key}`, 'X-Daytona-Source': 'orin', ...(headers as Record<string, string> | undefined) }, signal: signal ? AbortSignal.any([signal, t]) : t });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let msg = '';
    try {
      msg = String((JSON.parse(text) as { message?: unknown }).message ?? '');
    } catch {
      msg = text;
    }
    throw new DaytonaError(`Daytona ${res.status}: ${(msg || res.statusText || 'request failed').slice(0, 200)}`, res.status);
  }
  return res;
}

interface DaytonaSandbox {
  id: string;
  state?: string;
  errorReason?: string;
  toolboxProxyUrl?: string;
}

class DaytonaSession implements SandboxSession {
  readonly provider = 'daytona';
  constructor(
    readonly id: string,
    private readonly api: string,
    private readonly toolbox: string,
    private readonly key: string,
    private readonly f: FetchLike,
  ) {}

  private tb(path: string, init: RequestInit & { timeoutMs?: number } = {}) {
    return call(this.f, this.key, `${this.toolbox}${path}`, init);
  }

  async exec(cmd: string, o: ExecOptions = {}): Promise<ExecResult> {
    const timeoutMs = o.timeoutMs ?? 120_000;
    const sec = Math.max(1, Math.ceil(timeoutMs / 1000));
    try {
      const res = await this.tb('/process/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: `bash -lc ${shq(cmd)}`, cwd: o.cwd ?? SANDBOX_WORKDIR, timeout: sec, ...(o.envs && Object.keys(o.envs).length ? { envs: o.envs } : {}) }),
        timeoutMs: timeoutMs + 20_000,
        signal: o.signal,
      });
      const d = (await res.json()) as { exitCode?: number; result?: string };
      // Daytona returns stdout and stderr together in `result`.
      return { stdout: cap(d.result ?? '', 60_000), stderr: '', exitCode: typeof d.exitCode === 'number' ? d.exitCode : null };
    } catch (e) {
      if (o.signal?.aborted) return { stdout: '', stderr: '(stopped: cancelled)', exitCode: null };
      const err = e as Error;
      if (err.name === 'TimeoutError' || /timeout|timed out/i.test(err.message)) {
        return { stdout: '', stderr: `(stopped: time limit of ${sec} s reached)`, exitCode: null, timedOut: true };
      }
      throw e;
    }
  }

  async execBackground(cmd: string, o: { cwd?: string; envs?: Record<string, string> } = {}) {
    const r = await this.exec(`setsid nohup bash -lc ${shq(cmd)} </dev/null >/dev/null 2>&1 & echo $!`, { cwd: o.cwd, envs: o.envs, timeoutMs: 30_000 });
    const pid = Number.parseInt(r.stdout.trim().split(/\s+/).pop() ?? '', 10);
    return { pid: Number.isFinite(pid) ? pid : null };
  }

  private async upload(path: string, data: string | Uint8Array) {
    const form = new FormData();
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    form.append('files[0].path', path);
    form.append('files[0].file', new Blob([bytes as Uint8Array<ArrayBuffer>]), path.split('/').pop() || 'file');
    await this.tb('/files/bulk-upload', { method: 'POST', body: form, timeoutMs: 120_000 });
  }

  async writeFile(path: string, data: string | Uint8Array) {
    try {
      await this.upload(path, data);
    } catch {
      // the folder may not exist yet
      const dir = path.slice(0, path.lastIndexOf('/')) || '/';
      await this.exec(`mkdir -p ${shq(dir)}`, { cwd: '/', timeoutMs: 30_000 });
      await this.upload(path, data);
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const res = await this.tb(`/files/download?path=${encodeURIComponent(path)}`, { timeoutMs: 120_000 });
    return new Uint8Array(await res.arrayBuffer());
  }

  async extend(ms: number) {
    const min = Math.max(1, Math.ceil(ms / 60_000));
    await call(this.f, this.key, `${this.api}/sandbox/${encodeURIComponent(this.id)}/autostop/${min}`, { method: 'POST', timeoutMs: 30_000 });
  }

  async close() {
    await call(this.f, this.key, `${this.api}/sandbox/${encodeURIComponent(this.id)}`, { method: 'DELETE', timeoutMs: 30_000 });
  }
}

export class DaytonaProvider implements SandboxProvider {
  readonly id = 'daytona';
  private readonly api: string;
  constructor(
    private readonly key: () => string,
    o: { apiUrl?: string; fetchImpl?: FetchLike; pollMs?: number; startTimeoutMs?: number; lookup?: Parameters<typeof assertPublicUrl>[1] } = {},
  ) {
    this.api = (o.apiUrl || DAYTONA_API).replace(/\/+$/, '');
    this.f = o.fetchImpl ?? ((u, i) => fetch(u, i));
    this.pollMs = o.pollMs ?? 1500;
    this.startTimeoutMs = o.startTimeoutMs ?? 120_000;
    this.lookup = o.lookup;
  }
  private readonly f: FetchLike;
  private readonly pollMs: number;
  private readonly startTimeoutMs: number;
  private readonly lookup?: Parameters<typeof assertPublicUrl>[1];

  needs(): string | null {
    return this.key() ? null : 'a Daytona API key';
  }

  async create(o: { timeoutMs: number; metadata?: Record<string, string>; signal?: AbortSignal }): Promise<SandboxSession> {
    const key = this.key();
    // a self-hosted address is checked again on every start (it must still resolve to a public host)
    if (this.api !== DAYTONA_API) await assertPublicUrl(this.api, this.lookup);
    const res = await call(this.f, key, `${this.api}/sandbox`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // stop after the idle time and delete as soon as it stops, so nothing is left running (or billing)
      body: JSON.stringify({ labels: o.metadata ?? {}, autoStopInterval: Math.max(1, Math.ceil(o.timeoutMs / 60_000)), autoDeleteInterval: 0 }),
      timeoutMs: 90_000,
      signal: o.signal,
    });
    let sb = (await res.json()) as DaytonaSandbox;
    if (!sb?.id) throw new DaytonaError('Daytona did not return a sandbox id.');
    const kill = () => call(this.f, key, `${this.api}/sandbox/${encodeURIComponent(sb.id)}`, { method: 'DELETE', timeoutMs: 30_000 }).catch(() => undefined);
    try {
      const until = Date.now() + this.startTimeoutMs;
      while (sb.state !== 'started') {
        if (sb.state && /error|failed|destroyed|archived/i.test(sb.state)) throw new DaytonaError(`Daytona could not start the sandbox (${sb.state}${sb.errorReason ? `: ${sb.errorReason}` : ''}).`);
        if (Date.now() > until) throw new DaytonaError('Daytona took too long to start the sandbox.');
        if (o.signal?.aborted) throw new DaytonaError('Cancelled while starting.');
        await new Promise((r) => setTimeout(r, this.pollMs));
        sb = (await (await call(this.f, key, `${this.api}/sandbox/${encodeURIComponent(sb.id)}`, { timeoutMs: 30_000 })).json()) as DaytonaSandbox;
      }
      const proxy = (sb.toolboxProxyUrl ?? '').replace(/\/+$/, '');
      if (!proxy) throw new DaytonaError('Daytona did not say where the sandbox toolbox is.');
      // The key is sent to this address too, so it must be a public https host (never a local one).
      const u = new URL(proxy);
      if (u.protocol !== 'https:') throw new DaytonaError('Daytona gave a toolbox address that is not https; refusing to send the key there.');
      await assertPublicUrl(proxy, this.lookup);
      const session = new DaytonaSession(sb.id, this.api, `${proxy}/${encodeURIComponent(sb.id)}`, key, this.f);
      const w = SANDBOX_WORKDIR;
      const r = await session.exec(`if ! mkdir -p ${w} 2>/dev/null; then sudo -n mkdir -p ${w} && sudo -n chown -R "$(id -u):$(id -g)" /home/user; fi; test -w ${w} && echo ok`, { cwd: '/', timeoutMs: 30_000 });
      if (!r.stdout.includes('ok')) throw new DaytonaError(`Could not create ${w} in the Daytona sandbox.`);
      return session;
    } catch (e) {
      await kill();
      throw e;
    }
  }
}

/** One cheap authenticated call: lists sandboxes. Throws DaytonaError (status 401/403 = key rejected). */
export async function checkDaytonaKey(key: string, o: { apiUrl?: string; fetchImpl?: FetchLike; lookup?: Parameters<typeof assertPublicUrl>[1] } = {}): Promise<void> {
  const api = (o.apiUrl || DAYTONA_API).replace(/\/+$/, '');
  if (api !== DAYTONA_API) await assertPublicUrl(api, o.lookup);
  const res = await call(o.fetchImpl ?? ((u, i) => fetch(u, i)), key, `${api}/sandbox`, { timeoutMs: 20_000 });
  await res.body?.cancel().catch(() => undefined);
}
