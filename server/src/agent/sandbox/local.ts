import { isIP } from 'node:net';
import { assertPublicUrl, isPrivateAddress, type LookupFn } from '../net.js';
import { SANDBOX_WORKDIR, shq, type ExecOptions, type ExecResult, type SandboxProvider, type SandboxSession } from './types.js';

/**
 * "Local sandbox": a sandbox the user runs themselves (for example on a spare phone), reached over
 * HTTPS with a URL + token, plus an optional "Discovery" value that describes its API.
 *
 * Orin's server runs in the cloud (Render), so the URL must be publicly reachable: a tunnel such as
 * ngrok or Cloudflare Tunnel in front of the phone. LAN, localhost and other private addresses are
 * refused with a plain explanation (same SSRF guard as everything else), and so are plain-http URLs
 * (the token goes with every request) and redirects (the token must never follow one to another host).
 *
 * PROTOCOL (what this adapter assumes, in order):
 *  1. Discovery, when given, is one of:
 *     - a URL or path (relative to the sandbox URL) of a JSON document,
 *     - the JSON document pasted inline,
 *     - something that is not for the cloud (an mDNS / Bonjour service name like "_orin._tcp", a LAN
 *       address): kept, ignored, and explained.
 *     When empty, these well-known paths are tried on the sandbox URL: /discovery, /.well-known/sandbox.json,
 *     /.well-known/orin-sandbox.json, /openapi.json.
 *  2. The document may be Orin's own simple shape:
 *       { "name", "workdir", "auth": { "header", "scheme" }, "preview": "https://host/{port}",
 *         "endpoints": { "health": "GET /health", "exec": "POST /exec", "read": "GET /files", "write": "PUT /files" } }
 *     (endpoint values: "/path", "METHOD /path", or { method, path }), or an OpenAPI document (paths are
 *     matched by name: exec|execute|run|command|shell, read|download|cat, write|upload|save, health|ping|status).
 *  3. With no usable document, POST is tried on /exec, /execute, /run, /api/exec, /command, /process/execute
 *     with `echo` until one answers, and files go through commands (base64).
 *  - exec request: JSON { command, cmd, cwd, timeout (s), timeoutMs, env }. Response: JSON with stdout/output/result,
 *    stderr, exitCode/exit_code/code/returncode; or plain text (= stdout, exit 0).
 *  - read: GET ?path=... returning raw bytes or JSON { content, encoding: "base64" }.
 *  - write: JSON { path, content (base64), encoding: "base64" }.
 *  - token: `Authorization: Bearer <token>` plus `X-Sandbox-Token`/`X-API-Key` (or the header Discovery names).
 *  - workspace: Orin's tools use /home/user/work. If that isn't writable on the sandbox (a phone usually
 *    isn't), /home/user is mapped to $HOME/orin (work dir $HOME/orin/work) in both directions.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export class LocalSandboxError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly reason: 'unreachable' | 'rejected' | 'protocol' | 'private' | 'config' = 'protocol',
  ) {
    super(message);
    this.name = 'LocalSandboxError';
  }
}

interface Endpoint {
  method: string;
  path: string;
}

export interface LocalProtocol {
  /** Where the protocol came from, in plain words (shown in the health line). */
  source: string;
  exec: Endpoint;
  read?: Endpoint;
  write?: Endpoint;
  health?: Endpoint;
  workdir?: string;
  preview?: string;
  authHeader?: string;
  authScheme?: string;
  name?: string;
  /** Discovery was something the cloud can't use (mDNS, LAN); kept, but ignored. */
  note?: string;
  /**
   * A "workspace jobs" API (the user's own sandbox app): commands are queued with
   * POST {prefix}/workspaces/{id}/commands, waited on, and their output read as events;
   * files go through {prefix}/workspaces/{id}/files/content, rooted at the workspace folder.
   */
  jobs?: { prefix: string; workspace: string; guest: string };
}

export interface LocalConfig {
  url: string;
  token: string;
  discovery?: string;
}

interface Deps {
  fetchImpl?: FetchLike;
  lookup?: LookupFn;
}

const cap = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);
const EXEC_GUESSES = ['/exec', '/execute', '/run', '/api/exec', '/command', '/process/execute'];
const DISCOVERY_GUESSES = ['/discovery', '/.well-known/sandbox.json', '/.well-known/orin-sandbox.json', '/openapi.json', '/v1/openapi.json', '/api/v1/openapi.json'];
const MAX_EXEC_BYTES = 4 * 1024 * 1024;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const WRITE_CHUNK = 48 * 1024; // base64 chunk when files go through commands

// ---------- address checks ----------

function privateHostKind(host: string): string | null {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h.endsWith('.localhost')) return 'this device itself (localhost)';
  if (h.endsWith('.local')) return 'a name that only works on your local Wi-Fi';
  if (h.endsWith('.internal') || h.endsWith('.lan') || h.endsWith('.home')) return 'a name that only works on your local network';
  if (isIP(h) && isPrivateAddress(h)) {
    if (/^(127\.|::1$|0\.)/.test(h)) return 'this device itself (localhost)';
    if (/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(h)) return 'a private VPN address (like Tailscale)';
    return 'an address on your local Wi-Fi';
  }
  return null;
}

export const TUNNEL_HELP =
  'On the sandbox phone, put a tunnel in front of it, for example "ngrok http 8080" or "cloudflared tunnel --url http://localhost:8080" (use your sandbox\'s port), and paste the https address it shows.';

/** Normalises and checks a local sandbox URL. Throws LocalSandboxError('private') with a plain explanation. */
export async function checkLocalUrl(raw: string, lookup?: LookupFn): Promise<URL> {
  let url: URL;
  const text = raw.trim();
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
  } catch {
    throw new LocalSandboxError('That sandbox URL isn\'t a valid address.', undefined, 'config');
  }
  if (url.protocol === 'ws:' || url.protocol === 'wss:') {
    throw new LocalSandboxError('That is a WebSocket address. Orin talks to local sandboxes over https; paste the https address of the sandbox.', undefined, 'config');
  }
  const kind = privateHostKind(url.hostname);
  if (kind) {
    throw new LocalSandboxError(
      `${url.hostname} is ${kind}. Orin's server runs in the cloud, not on your phone, so it can't reach it, even when both phones share the same Wi-Fi. ${TUNNEL_HELP}`,
      undefined,
      'private',
    );
  }
  if (url.protocol !== 'https:') {
    throw new LocalSandboxError('Use the https address of the sandbox. The token is sent with every request, so plain http isn\'t allowed.', undefined, 'config');
  }
  if (url.username || url.password) throw new LocalSandboxError('Put the token in the Token field, not in the URL.', undefined, 'config');
  try {
    await assertPublicUrl(url.toString(), lookup);
  } catch (err) {
    const msg = (err as Error).message || '';
    if (/resolve/i.test(msg)) {
      if (isQuickTunnel(url.toString())) throw new LocalSandboxError(`${tunnelGone(url.toString())}.`, undefined, 'unreachable');
      throw new LocalSandboxError(`Couldn't find ${url.hostname}. If it's a tunnel address, check the tunnel is still running on the phone.`, undefined, 'unreachable');
    }
    throw new LocalSandboxError(`${url.hostname} points to a private address. Orin's server runs in the cloud, so it can't reach it. ${TUNNEL_HELP}`, undefined, 'private');
  }
  url.hash = '';
  url.search = '';
  return url;
}

/**
 * For saving only: a public-looking https address whose name doesn't resolve right now (an expired quick
 * tunnel) is kept as typed. It is checked again, DNS included, every time it's used, and a Discovery relay
 * replaces it with the sandbox's newest address.
 */
export async function normaliseLocalUrlForSave(raw: string, lookup?: LookupFn): Promise<string> {
  try {
    return await normaliseLocalUrl(raw, lookup);
  } catch (err) {
    if (!(err instanceof LocalSandboxError) || err.reason !== 'unreachable') throw err;
    const text = raw.trim();
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`);
    u.hash = '';
    u.search = '';
    return u.toString().replace(/\/+$/, '');
  }
}

/** The URL a user typed, cleaned up for storage (no trailing slash). Throws LocalSandboxError on a bad/private one. */
export async function normaliseLocalUrl(raw: string, lookup?: LookupFn): Promise<string> {
  const u = await checkLocalUrl(raw, lookup);
  return u.toString().replace(/\/+$/, '');
}

// ---------- discovery ----------

function parseEndpoint(v: unknown, defMethod: string): Endpoint | undefined {
  if (!v) return undefined;
  if (typeof v === 'string') {
    const m = v.trim().match(/^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)$/i);
    if (m) return { method: m[1]!.toUpperCase(), path: m[2]! };
    return v.trim() ? { method: defMethod, path: v.trim() } : undefined;
  }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const path = (o.path ?? o.url ?? o.href) as unknown;
    if (typeof path !== 'string' || !path.trim()) return undefined;
    const method = typeof o.method === 'string' ? o.method.toUpperCase() : defMethod;
    return { method, path: path.trim() };
  }
  return undefined;
}

function pick(o: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k];
  return undefined;
}

function fromOpenApi(doc: Record<string, unknown>): Partial<LocalProtocol> | null {
  const paths = doc.paths as Record<string, Record<string, unknown>> | undefined;
  if (!paths || typeof paths !== 'object') return null;
  let base = '';
  const servers = doc.servers as { url?: string }[] | undefined;
  if (Array.isArray(servers) && typeof servers[0]?.url === 'string' && servers[0].url.startsWith('/')) base = servers[0].url.replace(/\/+$/, '');
  const out: Partial<LocalProtocol> = {};
  const find = (re: RegExp, methods: string[]): Endpoint | undefined => {
    for (const [p, ops] of Object.entries(paths)) {
      if (!re.test(p) || p.includes('{')) continue;
      for (const m of methods) if (ops && typeof ops === 'object' && m in ops) return { method: m.toUpperCase(), path: base + p };
    }
    return undefined;
  };
  out.exec = find(/(exec|execute|run|command|shell)/i, ['post']);
  out.read = find(/(read|download|cat)/i, ['get', 'post']) ?? find(/\/files?$/i, ['get']);
  out.write = find(/(write|upload|save)/i, ['post', 'put']) ?? find(/\/files?$/i, ['put', 'post']);
  out.health = find(/(health|ping|status)/i, ['get']);
  const info = doc.info as Record<string, unknown> | undefined;
  if (typeof info?.title === 'string') out.name = info.title;
  // Workspace jobs API: /…/workspaces/{id}/commands + /…/commands/{id}/wait (+ events)
  const keys = Object.keys(paths);
  const cmdPath = keys.find((p) => /\/workspaces\/\{[^}]+\}\/commands$/.test(p) && paths[p] && 'post' in paths[p]!);
  if (cmdPath) {
    const prefix = base + cmdPath.replace(/\/workspaces\/\{[^}]+\}\/commands$/, '');
    const rawPrefix = cmdPath.replace(/\/workspaces\/\{[^}]+\}\/commands$/, '');
    if (keys.some((p) => p === `${rawPrefix}/commands/{command_id}/wait` || /\/commands\/\{[^}]+\}\/wait$/.test(p))) {
      out.exec = { method: 'POST', path: `${prefix}/workspaces/{workspace}/commands` };
      out.health = keys.includes(`${rawPrefix}/health`) ? { method: 'GET', path: `${prefix}/health` } : out.health;
      out.read = undefined;
      out.write = undefined;
      out.jobs = { prefix, workspace: '', guest: '' };
    }
  }
  return out.exec ? out : null;
}

/** Reads a discovery document (Orin's simple shape or OpenAPI). Returns null when it doesn't describe a usable API. */
export function protocolFromDoc(doc: unknown, source: string): LocalProtocol | null {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  const d = doc as Record<string, unknown>;
  if (d.openapi || d.swagger) {
    const p = fromOpenApi(d);
    if (p?.jobs) return { ...p, source, exec: p.exec!, name: p.name } as LocalProtocol;
    return p?.exec ? ({ ...p, source, exec: p.exec } as LocalProtocol) : null;
  }
  const eps = (pick(d, ['endpoints', 'routes', 'api', 'paths']) as Record<string, unknown> | undefined) ?? d;
  const exec = parseEndpoint(pick(eps, ['exec', 'execute', 'run', 'command', 'shell', 'process']), 'POST');
  if (!exec) return null;
  const auth = d.auth as Record<string, unknown> | undefined;
  const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : undefined);
  return {
    source,
    exec,
    read: parseEndpoint(pick(eps, ['read', 'readFile', 'read_file', 'download', 'fileRead', 'files_read']), 'GET'),
    write: parseEndpoint(pick(eps, ['write', 'writeFile', 'write_file', 'upload', 'fileWrite', 'files_write']), 'POST'),
    health: parseEndpoint(pick(eps, ['health', 'ping', 'status']), 'GET'),
    workdir: str(pick(d, ['workdir', 'workDir', 'cwd', 'workspace'])),
    preview: str(pick(d, ['preview', 'previewUrl', 'preview_url', 'portUrl'])),
    authHeader: str(auth?.header),
    authScheme: typeof auth?.scheme === 'string' ? auth.scheme : undefined,
    name: str(d.name),
  };
}

/** Plain words for a Discovery value the cloud can't use, or null when it's something to fetch/parse. */
function unusableDiscovery(disc: string): string | null {
  if (/^_[a-z0-9-]+\._(tcp|udp)/i.test(disc) || /\._(tcp|udp)(\.local)?\.?$/i.test(disc)) {
    return 'Discovery looks like a Wi-Fi service name (mDNS). That only works on the same Wi-Fi, so Orin uses the URL instead.';
  }
  if (/^wss?:\/\//i.test(disc)) return 'Discovery is a WebSocket address, which Orin doesn\'t use. She talks to the sandbox over its https URL.';
  try {
    const u = new URL(disc);
    const kind = privateHostKind(u.hostname);
    if (kind) return `Discovery points to ${kind}, which Orin's cloud server can't reach. She worked the API out from the sandbox URL instead.`;
  } catch {
    /* not a URL */
  }
  return null;
}

// ---------- HTTP ----------

function isQuickTunnel(base: string): boolean {
  try {
    return /(^|\.)trycloudflare\.com$/i.test(new URL(base).hostname);
  } catch {
    return false;
  }
}

/** Plain words for "the tunnel address doesn't answer". */
function tunnelGone(base: string): string {
  if (isQuickTunnel(base)) {
    return `${new URL(base).hostname} isn't online. Quick-tunnel (trycloudflare) addresses change every time the tunnel restarts on the phone. If your sandbox posts its address somewhere, put that link in Discovery and Orin follows it; otherwise paste the new address`;
  }
  return 'The tunnel address is offline: the tunnel on the phone stopped or its address changed. Start it again, and paste the new address if it changed';
}

class Client {
  constructor(
    readonly base: string,
    private readonly token: string,
    private readonly f: FetchLike,
    private auth: { header?: string; scheme?: string } = {},
  ) {}

  setAuth(a: { header?: string; scheme?: string }) {
    this.auth = a;
  }

  url(path: string): string {
    if (/^https?:\/\//i.test(path)) {
      const u = new URL(path);
      if (u.origin !== new URL(this.base).origin) throw new LocalSandboxError('Discovery names an address on a different host. For safety, the token is only sent to the sandbox URL.', undefined, 'config');
      return u.toString();
    }
    return `${this.base}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'user-agent': 'OrinSandbox/1.0', 'ngrok-skip-browser-warning': '1', accept: 'application/json, */*', ...extra };
    if (this.token) {
      if (this.auth.header && this.auth.header.toLowerCase() !== 'authorization') {
        h[this.auth.header.toLowerCase()] = this.auth.scheme ? `${this.auth.scheme} ${this.token}` : this.token;
      } else {
        const scheme = this.auth.scheme ?? 'Bearer';
        h.authorization = scheme ? `${scheme} ${this.token}` : this.token;
        h['x-sandbox-token'] = this.token;
        h['x-api-key'] = this.token;
      }
    }
    return h;
  }

  async send(ep: Endpoint, o: { body?: unknown; raw?: Uint8Array; query?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal; auth?: boolean } = {}): Promise<Response> {
    let url = this.url(ep.path);
    if (o.query) {
      const u = new URL(url);
      for (const [k, v] of Object.entries(o.query)) u.searchParams.set(k, v);
      url = u.toString();
    }
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(new Error('timed out')), o.timeoutMs ?? 30_000);
    const onAbort = () => ctl.abort(o.signal?.reason);
    o.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const hasBody = (o.body !== undefined || o.raw !== undefined) && ep.method !== 'GET';
      const res = await this.f(url, {
        method: ep.method,
        headers: this.headers(hasBody ? { 'content-type': o.raw ? 'application/octet-stream' : 'application/json' } : {}),
        body: hasBody ? (o.raw ? Buffer.from(o.raw) : JSON.stringify(o.body)) : undefined,
        signal: ctl.signal,
        redirect: 'manual',
      });
      if (res.status >= 300 && res.status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const loc = res.headers.get('location') ?? '';
        throw new LocalSandboxError(`The sandbox answered with a redirect${loc ? ` to ${cap(loc, 80)}` : ''}. Paste the final address as the sandbox URL.`, res.status, 'config');
      }
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => undefined);
        throw new LocalSandboxError('The sandbox rejected the token.', res.status, 'rejected');
      }
      const ngrokCode = res.headers.get('ngrok-error-code') ?? '';
      if (!res.ok && (ngrokCode === 'ERR_NGROK_3200' || res.status === 530)) {
        await res.body?.cancel().catch(() => undefined);
        throw new LocalSandboxError(`${tunnelGone(this.base)} (${res.status})`, res.status, 'unreachable');
      }
      if (!res.ok && (ngrokCode || res.status === 502 || res.status === 504)) {
        await res.body?.cancel().catch(() => undefined);
        throw new LocalSandboxError(`The tunnel is up but the sandbox behind it isn't answering (${res.status}). Check the sandbox app is running on the phone.`, res.status, 'unreachable');
      }
      return res;
    } catch (err) {
      if (err instanceof LocalSandboxError) throw err;
      if (o.signal?.aborted) throw o.signal.reason instanceof Error ? o.signal.reason : new Error('aborted');
      const msg = (err as Error)?.message || String(err);
      throw new LocalSandboxError(
        ctl.signal.aborted
          ? `The sandbox didn't answer in time (fetch failed: timed out).`
          : isQuickTunnel(this.base)
            ? `${tunnelGone(this.base)} (fetch failed: ${cap(msg, 80)})`
            : `Couldn't reach the sandbox (fetch failed: ${cap(msg, 120)}). Check the phone is online and the tunnel is running.`,
        undefined,
        'unreachable',
      );
    } finally {
      clearTimeout(t);
      o.signal?.removeEventListener('abort', onAbort);
    }
  }
}

async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > max) {
      await reader.cancel().catch(() => undefined);
      throw new LocalSandboxError(`The sandbox sent more than ${Math.round(max / 1024 / 1024)} MB.`, res.status, 'protocol');
    }
    parts.push(value);
  }
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}

async function readJsonOrText(res: Response, max = MAX_EXEC_BYTES): Promise<{ json?: Record<string, unknown>; text: string }> {
  const bytes = await readCapped(res, max);
  const text = new TextDecoder().decode(bytes);
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('json') || /^\s*[{[]/.test(text)) {
    try {
      const j = JSON.parse(text);
      if (j && typeof j === 'object' && !Array.isArray(j)) return { json: j as Record<string, unknown>, text };
    } catch {
      /* not JSON */
    }
  }
  return { text };
}

function parseExec(res: Response, body: { json?: Record<string, unknown>; text: string }): ExecResult {
  const j = body.json;
  if (!j) return { stdout: body.text, stderr: '', exitCode: res.ok ? 0 : 1 };
  const inner = (j.data && typeof j.data === 'object' ? (j.data as Record<string, unknown>) : j) as Record<string, unknown>;
  const s = (v: unknown) => (typeof v === 'string' ? v : v == null ? '' : Array.isArray(v) ? v.join('') : String(v));
  const stdout = s(pick(inner, ['stdout', 'output', 'out', 'result', 'logs']));
  const stderr = s(pick(inner, ['stderr', 'err']));
  const codeRaw = pick(inner, ['exitCode', 'exit_code', 'code', 'returncode', 'returnCode', 'status']);
  const code = typeof codeRaw === 'number' ? codeRaw : typeof codeRaw === 'string' && /^-?\d+$/.test(codeRaw) ? Number(codeRaw) : null;
  const timedOut = inner.timedOut === true || inner.timed_out === true || inner.timeout === true;
  if (!res.ok && !stdout && !stderr) {
    const err = s(pick(inner, ['error', 'message', 'detail']));
    throw new LocalSandboxError(`The sandbox answered ${res.status}${err ? `: ${cap(err, 200)}` : ''}.`, res.status, 'protocol');
  }
  return { stdout, stderr, exitCode: timedOut ? null : (code ?? (res.ok ? 0 : 1)), ...(timedOut ? { timedOut } : {}) };
}

// ---------- relay: a feed where the sandbox posts its current address ----------

const TUNNEL_FAMILIES = ['trycloudflare.com', 'ngrok-free.app', 'ngrok-free.dev', 'ngrok.app', 'ngrok.dev', 'ngrok.io', 'loca.lt'];
const family = (h: string) => h.toLowerCase().split('.').slice(-2).join('.');

/** The ntfy-style feed URL for a Discovery value, or null when Discovery doesn't look like a relay topic. */
export function relayFeed(disc: string): string | null {
  if (!/^https:\/\//i.test(disc.trim())) return null;
  let u: URL;
  try {
    u = new URL(disc.trim());
  } catch {
    return null;
  }
  const seg = u.pathname.split('/').filter(Boolean);
  const topic = seg[0] ?? '';
  if (!/^[\w-]{1,64}$/.test(topic) || /^(discovery|openapi|\.well-known|v\d+|api)$/i.test(topic)) return null;
  if (seg.length === 2 && !/^(json|raw|sse)$/i.test(seg[1]!)) return null;
  if (seg.length > 2) return null;
  if (!/ntfy/i.test(u.hostname) && seg.length === 1 && topic.length < 6) return null;
  return `${u.origin}/${topic}/json?poll=1&since=all`;
}

/** Newest address in an ntfy JSON-lines feed. Messages may be JSON ({"url": …, "epoch": …, "ts": …}) or plain text with an https address. */
export function newestRelayAddress(text: string): { url: string; at?: number } | null {
  let best: { url: string; at?: number; k: [number, number] } | null = null;
  for (const line of text.split('\n')) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!ev || (ev.event !== undefined && ev.event !== 'message') || typeof ev.message !== 'string') continue;
    const time = typeof ev.time === 'number' ? ev.time * 1000 : 0;
    let url: string | undefined;
    let k: [number, number] = [time, 0];
    let at: number | undefined = time || undefined;
    try {
      const m = JSON.parse(ev.message) as Record<string, unknown>;
      const u = pick(m, ['url', 'sandbox_url', 'SANDBOX_URL', 'address', 'public_url']);
      if (typeof u === 'string') url = u;
      const ts = typeof m.ts === 'number' ? m.ts : time;
      // newest post wins (a reinstalled sandbox app may restart its epoch count); epoch breaks ties
      k = [ts, typeof m.epoch === 'number' ? m.epoch : 0];
      at = ts || at;
    } catch {
      url = ev.message.match(/https:\/\/[^\s"'<>]+/)?.[0];
    }
    if (!url) continue;
    if (!best || k[0] > best.k[0] || (k[0] === best.k[0] && k[1] >= best.k[1])) best = { url, at, k };
  }
  return best ? { url: best.url, at: best.at } : null;
}

/**
 * When Discovery is a relay feed (like an ntfy.sh topic the sandbox posts its tunnel address to),
 * returns the config with the newest posted address as the URL. The token is never sent to the feed.
 */
export async function followRelay(cfg: LocalConfig, deps: Deps = {}): Promise<{ cfg: LocalConfig; note?: string; relayed: boolean; posted?: string; dead?: boolean }> {
  const disc = (cfg.discovery ?? '').trim();
  const feed = disc ? relayFeed(disc) : null;
  if (!feed) return { cfg, relayed: false };
  const f = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const keep = (note: string) => ({ cfg: { ...cfg, discovery: '' }, note, relayed: true });
  let found: { url: string; at?: number } | null = null;
  try {
    await checkLocalUrl(feed, deps.lookup);
    const get = () => f(feed, { headers: { 'user-agent': 'OrinSandbox/1.0', accept: 'application/x-ndjson, application/json, */*' }, redirect: 'manual', signal: AbortSignal.timeout(12_000) });
    // one retry: a feed read can fail once on a cold server
    const res = await get().catch(() => new Promise<Response>((r, j) => setTimeout(() => get().then(r, j), 1500)));
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return keep(`Couldn't read the Discovery link (it answered ${res.status}), so Orin used the saved URL.`);
    }
    found = newestRelayAddress(new TextDecoder().decode(await readCapped(res, 1024 * 1024)));
  } catch (e) {
    return keep(`Couldn't read the Discovery link (${cap((e as Error).message || String(e), 80)}), so Orin used the saved URL.`);
  }
  if (!found) return keep('The Discovery link has no address posted in the last 12 hours, so Orin used the saved URL. Start the sandbox app so it posts one.');
  let next: string;
  try {
    next = await normaliseLocalUrl(found.url, deps.lookup);
  } catch (e) {
    const le = e as LocalSandboxError;
    if (le instanceof LocalSandboxError && le.reason === 'unreachable') {
      let host = found.url;
      try {
        host = new URL(found.url).hostname;
      } catch {
        /* keep as posted */
      }
      // the sandbox moved on from the saved URL: never fall back to it (a stale quick-tunnel name can belong to someone else now)
      return { cfg: { ...cfg, discovery: '' }, note: '', relayed: true, posted: host, dead: true };
    }
    return keep(`The address posted on the Discovery link can't be used: ${le.message}`);
  }
  const host = new URL(next).hostname;
  let savedHost = '';
  try {
    savedHost = cfg.url ? new URL(/^https?:\/\//i.test(cfg.url) ? cfg.url : `https://${cfg.url}`).hostname : '';
  } catch {
    /* bad saved URL: the relay decides */
  }
  const trusted = savedHost ? family(host) === family(savedHost) : TUNNEL_FAMILIES.includes(family(host));
  if (!trusted) return keep(`The Discovery link posted an address on a different service (${host}), so for safety Orin kept the saved URL and didn't send the token there.`);
  const mins = found.at ? Math.max(0, Math.round((Date.now() - found.at) / 60_000)) : null;
  const when = mins === null ? '' : mins < 1 ? ', posted just now' : mins < 120 ? `, posted ${mins} min ago` : `, posted ${Math.round(mins / 60)} h ago`;
  const changed = !savedHost || host !== savedHost;
  return {
    posted: host,
    cfg: { ...cfg, url: next, discovery: '' },
    note: changed ? `Following the newest address your sandbox posted on Discovery (${host}${when}).` : 'Following the address your sandbox posts on Discovery.',
    relayed: true,
  };
}

// ---------- workspace jobs API ----------

const jobPath = (p: LocalProtocol, rest: string) => `${p.jobs!.prefix}${rest}`;
const RUNNING = /^(queued|pending|starting|running|created)$/i;

async function jsonOf(res: Response, max = 1024 * 1024): Promise<Record<string, unknown>> {
  const body = await readJsonOrText(res, max);
  if (!res.ok) {
    const err = body.json ? pick(body.json, ['error', 'message', 'detail']) : body.text;
    const e = typeof err === 'object' && err ? (pick(err as Record<string, unknown>, ['message', 'code']) ?? JSON.stringify(err)) : err;
    throw new LocalSandboxError(`The sandbox answered ${res.status}${e ? `: ${cap(String(e), 200)}` : ''}.`, res.status, 'protocol');
  }
  return body.json ?? {};
}

/** Picks (or creates) the workspace Orin works in: one named "orin", else the first one. */
async function pickWorkspace(c: Client, p: LocalProtocol): Promise<LocalProtocol> {
  const j = await jsonOf(await c.send({ method: 'GET', path: jobPath(p, '/workspaces') }, { timeoutMs: 20_000 }));
  const list = (Array.isArray(j.workspaces) ? j.workspaces : Array.isArray(j.items) ? j.items : Array.isArray(j.data) ? j.data : []) as Record<string, unknown>[];
  let ws = list.find((w) => String(w.name ?? '').toLowerCase() === 'orin') ?? list[0];
  if (!ws) {
    ws = await jsonOf(await c.send({ method: 'POST', path: jobPath(p, '/workspaces') }, { body: { name: 'orin' }, timeoutMs: 30_000 })).catch((e) => {
      throw new LocalSandboxError(`The sandbox has no workspace and Orin couldn't create one (${(e as Error).message}). Create a workspace in the sandbox app.`, undefined, 'protocol');
    });
    ws = ((ws as Record<string, unknown>).workspace as Record<string, unknown>) ?? ws;
  }
  const id = String(ws.id ?? '');
  if (!id) throw new LocalSandboxError('The sandbox listed a workspace without an id.', undefined, 'protocol');
  const guest = (typeof ws.guest_path === 'string' && ws.guest_path.startsWith('/') ? ws.guest_path : '/workspace').replace(/\/+$/, '');
  const name = typeof ws.name === 'string' ? ws.name : undefined;
  return { ...p, jobs: { prefix: p.jobs!.prefix, workspace: id, guest }, workdir: p.workdir ?? `${guest}/orin/work`, name: p.name ?? name };
}

/** Runs one command through the jobs API: queue it, wait for it, then read its output events. */
async function runJob(
  c: Client,
  p: LocalProtocol,
  cmd: string,
  o: { timeoutMs?: number; signal?: AbortSignal; envs?: Record<string, string>; maxBytes?: number; background?: boolean } = {},
): Promise<ExecResult & { id?: string }> {
  const timeoutMs = Math.max(1000, o.timeoutMs ?? 60_000);
  const ws = encodeURIComponent(p.jobs!.workspace);
  const started = await jsonOf(
    await c.send({ method: 'POST', path: jobPath(p, `/workspaces/${ws}/commands`) }, { body: { cmd, timeout_ms: Math.min(timeoutMs, 21_600_000), ...(o.envs && Object.keys(o.envs).length ? { env: o.envs } : {}) }, timeoutMs: 30_000, signal: o.signal }),
  );
  const id = String(started.id ?? '');
  if (!id) throw new LocalSandboxError('The sandbox accepted the command but gave no id for it.', undefined, 'protocol');
  if (o.background) return { stdout: '', stderr: '', exitCode: null, id };
  const enc = encodeURIComponent(id);
  const deadline = Date.now() + timeoutMs + 15_000;
  let st: Record<string, unknown> = started;
  try {
    while (RUNNING.test(String(st.status ?? 'queued'))) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      const wait = Math.min(25_000, left);
      st = await jsonOf(await c.send({ method: 'GET', path: jobPath(p, `/commands/${enc}/wait`) }, { query: { timeout_ms: String(wait) }, timeoutMs: wait + 15_000, signal: o.signal }));
    }
  } catch (err) {
    if (o.signal?.aborted) await c.send({ method: 'POST', path: jobPath(p, `/commands/${enc}/cancel`) }, { timeoutMs: 10_000 }).catch(() => undefined);
    throw err;
  }
  const stillRunning = RUNNING.test(String(st.status ?? ''));
  if (stillRunning) await c.send({ method: 'POST', path: jobPath(p, `/commands/${enc}/cancel`) }, { timeoutMs: 10_000 }).catch(() => undefined);
  // output
  const max = o.maxBytes ?? MAX_EXEC_BYTES;
  let stdout = '';
  let stderr = '';
  let after = 0;
  for (let i = 0; i < 200; i++) {
    const ev = await jsonOf(await c.send({ method: 'GET', path: jobPath(p, `/commands/${enc}/events`) }, { query: { after: String(after) }, timeoutMs: 30_000, signal: o.signal }), max * 2 + 1024 * 1024);
    const list = (Array.isArray(ev.events) ? ev.events : []) as Record<string, unknown>[];
    for (const e of list) {
      const seq = typeof e.seq === 'number' ? e.seq : after;
      if (seq > after) after = seq;
      if (typeof e.data !== 'string') continue;
      if (e.type === 'stdout' && stdout.length < max) stdout += e.data;
      else if (e.type === 'stderr' && stderr.length < max) stderr += e.data;
    }
    if (!list.length || ev.finished === true || stdout.length >= max) break;
  }
  const status = String(st.status ?? '');
  const timedOut = stillRunning || /time/i.test(status);
  const code = typeof st.exit_code === 'number' ? st.exit_code : null;
  if (code === null && !timedOut && typeof st.error === 'string' && st.error && !stderr) stderr = st.error;
  return { stdout, stderr, exitCode: timedOut ? null : (code ?? (status === 'exited' ? 0 : 1)), ...(timedOut ? { timedOut: true } : {}), id };
}

// ---------- protocol resolution ----------

/** Errors that end the search for the API at once (no point trying other paths). */
function fatal(err: unknown): boolean {
  if (!(err instanceof LocalSandboxError)) return false;
  return err.reason === 'rejected' || err.reason === 'unreachable' || err.reason === 'private' || (err.status !== undefined && err.status >= 300 && err.status < 400);
}

async function tryExec(c: Client, ep: Endpoint, p?: LocalProtocol): Promise<boolean> {
  if (p?.jobs) {
    const r = await runJob(c, p, 'echo orin-ok', { timeoutMs: 20_000 }).catch((err) => {
      if (fatal(err)) throw err;
      return null;
    });
    return !!r?.stdout.includes('orin-ok');
  }
  try {
    const res = await c.send(ep, { body: { command: 'echo orin-ok', cmd: 'echo orin-ok', timeout: 15, timeoutMs: 15_000 }, timeoutMs: 20_000 });
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined);
      return false;
    }
    const r = parseExec(res, await readJsonOrText(res, 256 * 1024));
    return r.stdout.includes('orin-ok');
  } catch (err) {
    if (fatal(err)) throw err;
    return false;
  }
}

async function fetchDoc(c: Client, path: string, withToken: boolean, f: FetchLike, lookup?: LookupFn): Promise<unknown | null> {
  let res: Response;
  if (withToken) {
    res = await c.send({ method: 'GET', path }, { timeoutMs: 15_000 });
  } else {
    // A discovery document on another host: fetched WITHOUT the token, after the same public-address check.
    await checkLocalUrl(path, lookup);
    res = await f(path, { headers: { 'user-agent': 'OrinSandbox/1.0', accept: 'application/json', 'ngrok-skip-browser-warning': '1' }, redirect: 'manual', signal: AbortSignal.timeout(15_000) }).catch((e) => {
      throw new LocalSandboxError(`Couldn't fetch the Discovery address (${cap((e as Error).message, 80)}).`, undefined, 'unreachable');
    });
  }
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  const body = await readJsonOrText(res, 1024 * 1024);
  return body.json ?? null;
}

/** Works out how to talk to the sandbox. Throws LocalSandboxError when it can't. */
export async function resolveProtocol(cfg: LocalConfig, deps: Deps = {}): Promise<LocalProtocol> {
  const f = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const base = await normaliseLocalUrl(cfg.url, deps.lookup);
  const c = new Client(base, cfg.token, f);
  const rawDisc = (cfg.discovery ?? '').trim();
  // a relay feed only carries the address (followRelay reads it); the API is worked out from the URL
  const disc = relayFeed(rawDisc) ? '' : rawDisc;
  let note: string | undefined;
  let proto: LocalProtocol | null = null;

  if (disc) {
    note = unusableDiscovery(disc) ?? undefined;
    if (!note) {
      if (disc.startsWith('{')) {
        let doc: unknown;
        try {
          doc = JSON.parse(disc);
        } catch {
          throw new LocalSandboxError('Discovery looks like JSON but isn\'t valid JSON.', undefined, 'config');
        }
        proto = protocolFromDoc(doc, 'Discovery (pasted)');
        if (!proto) throw new LocalSandboxError('The Discovery JSON doesn\'t name a command (exec) endpoint.', undefined, 'config');
      } else if (/^https?:\/\//i.test(disc) || disc.startsWith('/')) {
        const sameHost = disc.startsWith('/') || new URL(disc).origin === new URL(base).origin;
        const doc = await fetchDoc(c, disc, sameHost, f, deps.lookup);
        if (!doc) throw new LocalSandboxError('The Discovery address didn\'t return a JSON description of the sandbox.', undefined, 'config');
        proto = protocolFromDoc(doc, 'Discovery');
        if (!proto) throw new LocalSandboxError('The Discovery document doesn\'t name a command (exec) endpoint.', undefined, 'config');
      } else {
        note = 'Orin didn\'t recognise the Discovery value, so she worked the API out from the sandbox URL.';
      }
    }
  }

  if (!proto) {
    for (const p of DISCOVERY_GUESSES) {
      const doc = await fetchDoc(c, p, true, f, deps.lookup).catch((e) => {
        if (fatal(e)) throw e;
        return null;
      });
      const found = doc ? protocolFromDoc(doc, `found at ${p}`) : null;
      if (found) {
        proto = found;
        break;
      }
    }
  }

  if (proto) {
    c.setAuth({ header: proto.authHeader, scheme: proto.authScheme });
    if (proto.jobs) proto = await pickWorkspace(c, proto);
    if (!(await tryExec(c, proto.exec, proto))) {
      throw new LocalSandboxError(`The sandbox didn't run a test command at ${proto.exec.method} ${proto.exec.path}.`, undefined, 'protocol');
    }
    return note ? { ...proto, note } : proto;
  }

  for (const p of EXEC_GUESSES) {
    const ep = { method: 'POST', path: p };
    if (await tryExec(c, ep)) return { source: `guessed (${p})`, exec: ep, ...(note ? { note } : {}) };
  }
  throw new LocalSandboxError(
    'Orin reached the sandbox but couldn\'t find how to run commands on it. Put its API description in Discovery (a URL like /openapi.json, or JSON naming the exec endpoint).',
    undefined,
    'protocol',
  );
}

// ---------- session ----------

function b64(data: string | Uint8Array): string {
  return Buffer.from(typeof data === 'string' ? Buffer.from(data, 'utf8') : data).toString('base64');
}

class PathMap {
  private readonly fwd: [string, string][];
  private readonly back: [string, string][];
  constructor(pairs: [string, string][]) {
    const clean = pairs.filter(([a, b]) => a !== b);
    this.fwd = [...clean].sort((x, y) => y[0].length - x[0].length);
    this.back = clean.map(([a, b]) => [b, a] as [string, string]).sort((x, y) => y[0].length - x[0].length);
  }
  private static apply(s: string, pairs: [string, string][]): string {
    if (!pairs.length || !s) return s;
    const esc = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(pairs.map(([a]) => `${esc(a)}(?![\\w.-])`).join('|'), 'g');
    return s.replace(re, (m) => pairs.find(([a]) => a === m)?.[1] ?? m);
  }
  to(s: string): string {
    return PathMap.apply(s, this.fwd);
  }
  from(s: string): string {
    return PathMap.apply(s, this.back);
  }
}

export class LocalSandboxSession implements SandboxSession {
  readonly provider = 'local';
  private readonly pids = new Set<number>();
  private readonly jobIds = new Set<string>();
  constructor(
    readonly id: string,
    private readonly c: Client,
    private readonly proto: LocalProtocol,
    private readonly map: PathMap,
    private readonly wrap: (cmd: string) => string,
  ) {}

  private remotePath(p: string): string {
    return this.map.to(p);
  }

  private async rawExec(command: string, o: { cwd?: string; timeoutMs?: number; signal?: AbortSignal; envs?: Record<string, string>; maxBytes?: number } = {}): Promise<ExecResult> {
    const timeoutMs = Math.max(1000, o.timeoutMs ?? 60_000);
    const sec = Math.ceil(timeoutMs / 1000);
    const cwd = o.cwd ? this.remotePath(o.cwd) : undefined;
    // cwd and env are put into the command itself, so they work whatever fields the sandbox understands.
    const exports = o.envs ? Object.entries(o.envs).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => `export ${k}=${shq(this.map.to(v))}; `).join('') : '';
    if (this.proto.jobs) {
      // env goes in its own field here: the sandbox keeps the command text, but never stores env values
      const envs = o.envs ? Object.fromEntries(Object.entries(o.envs).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => [k, this.map.to(v)])) : undefined;
      return runJob(this.c, this.proto, this.wrap(`${cwd ? `cd ${shq(cwd)} && ` : ''}${command}`), { timeoutMs, signal: o.signal, envs, maxBytes: o.maxBytes });
    }
    const inner = `${cwd ? `cd ${shq(cwd)} && ` : ''}${exports}${command}`;
    const full = this.wrap(inner);
    const res = await this.c.send(this.proto.exec, {
      body: { command: full, cmd: full, ...(cwd ? { cwd } : {}), timeout: sec, timeoutMs },
      timeoutMs: timeoutMs + 20_000,
      signal: o.signal,
    });
    return parseExec(res, await readJsonOrText(res, o.maxBytes ?? MAX_EXEC_BYTES));
  }

  async exec(cmd: string, o: ExecOptions = {}): Promise<ExecResult> {
    const r = await this.rawExec(this.map.to(cmd), { cwd: o.cwd ?? SANDBOX_WORKDIR, timeoutMs: o.timeoutMs, signal: o.signal, envs: o.envs });
    return { ...r, stdout: cap(this.map.from(r.stdout), 60_000), stderr: cap(this.map.from(r.stderr), 30_000) };
  }

  async execBackground(cmd: string, o: { cwd?: string; envs?: Record<string, string> } = {}): Promise<{ pid: number | null }> {
    if (this.proto.jobs) {
      const envs = o.envs ? Object.fromEntries(Object.entries(o.envs).filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k)).map(([k, v]) => [k, this.map.to(v)])) : undefined;
      const r = await runJob(this.c, this.proto, this.wrap(`cd ${shq(this.remotePath(o.cwd ?? SANDBOX_WORKDIR))} && ${this.map.to(cmd)}`), { timeoutMs: 21_600_000, envs, background: true });
      if (r.id) this.jobIds.add(r.id);
      return { pid: null };
    }
    const inner = this.wrap(`${o.cwd || SANDBOX_WORKDIR ? `cd ${shq(this.remotePath(o.cwd ?? SANDBOX_WORKDIR))} && ` : ''}${this.map.to(cmd)}`);
    const bg = `if command -v setsid >/dev/null 2>&1; then setsid nohup sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 & else nohup sh -c ${shq(inner)} </dev/null >/dev/null 2>&1 & fi; echo $!`;
    const r = await this.rawExec(bg, { timeoutMs: 20_000, envs: o.envs });
    const pid = Number((r.stdout.trim().split(/\s+/).pop() ?? '').replace(/\D/g, '')) || null;
    if (pid) this.pids.add(pid);
    return { pid };
  }

  async writeFile(path: string, data: string | Uint8Array): Promise<void> {
    const p = this.remotePath(path);
    const rel = this.workspaceRel(p);
    if (rel !== null) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      const ws = encodeURIComponent(this.proto.jobs!.workspace);
      const res = await this.c.send({ method: 'PUT', path: jobPath(this.proto, `/workspaces/${ws}/files/content`) }, { raw: bytes, query: { path: rel, create_parents: 'true' }, timeoutMs: 180_000 });
      await jsonOf(res).catch((e) => {
        throw new LocalSandboxError(`Couldn't write ${path} on the sandbox: ${(e as Error).message}`, (e as LocalSandboxError).status, 'protocol');
      });
      return;
    }
    const content = b64(data);
    if (this.proto.write) {
      try {
        const res = await this.c.send(this.proto.write, { body: { path: p, content, encoding: 'base64', mkdirs: true }, timeoutMs: 120_000 });
        const body = await readJsonOrText(res, 256 * 1024);
        if (res.ok && body.json?.ok !== false && !body.json?.error) return;
      } catch (err) {
        if (err instanceof LocalSandboxError && (err.reason === 'rejected' || err.reason === 'unreachable')) throw err;
      }
    }
    // Through commands: base64 in chunks, so it works with only an exec endpoint.
    const dir = p.replace(/\/[^/]*$/, '') || '/';
    const tmp = `${p}.orin-part`;
    const first = await this.rawExec(`mkdir -p ${shq(dir)} && : > ${shq(tmp)}`, { timeoutMs: 30_000 });
    if (first.exitCode !== 0) throw new LocalSandboxError(`Couldn't write ${path} on the sandbox: ${cap(first.stderr || first.stdout, 200)}`);
    for (let i = 0; i < content.length; i += WRITE_CHUNK) {
      const r = await this.rawExec(`printf %s ${shq(content.slice(i, i + WRITE_CHUNK))} >> ${shq(tmp)}`, { timeoutMs: 60_000 });
      if (r.exitCode !== 0) throw new LocalSandboxError(`Couldn't write ${path} on the sandbox: ${cap(r.stderr || r.stdout, 200)}`);
    }
    const done = await this.rawExec(`base64 -d ${shq(tmp)} > ${shq(p)} && rm -f ${shq(tmp)}`, { timeoutMs: 60_000 });
    if (done.exitCode !== 0) throw new LocalSandboxError(`Couldn't write ${path} on the sandbox: ${cap(done.stderr || done.stdout, 200)}`);
  }

  /** For the jobs API: the path inside the workspace folder (files API), or null when it's outside it. */
  private workspaceRel(p: string): string | null {
    const g = this.proto.jobs?.guest;
    if (!g || !p.startsWith(`${g}/`)) return null;
    const rel = p.slice(g.length + 1);
    return rel && !rel.split('/').includes('..') ? rel : null;
  }

  async readFile(path: string): Promise<Uint8Array> {
    const p = this.remotePath(path);
    const rel = this.workspaceRel(p);
    if (rel !== null) {
      const ws = encodeURIComponent(this.proto.jobs!.workspace);
      const res = await this.c.send({ method: 'GET', path: jobPath(this.proto, `/workspaces/${ws}/files/content`) }, { query: { path: rel }, timeoutMs: 180_000 });
      if (res.status === 404) {
        await res.body?.cancel().catch(() => undefined);
        throw new LocalSandboxError(`No such file on the sandbox: ${path}`, 404, 'protocol');
      }
      if (!res.ok) await jsonOf(res);
      return await readCapped(res, MAX_FILE_BYTES);
    }
    if (this.proto.read) {
      try {
        const ep = this.proto.read;
        const res = await this.c.send(ep, ep.method === 'GET' ? { query: { path: p }, timeoutMs: 120_000 } : { body: { path: p }, timeoutMs: 120_000 });
        if (res.ok) {
          const ct = res.headers.get('content-type') ?? '';
          if (ct.includes('json')) {
            const body = await readJsonOrText(res, MAX_FILE_BYTES * 2);
            const j = body.json ?? {};
            const content = pick(j, ['content', 'data', 'base64']);
            if (typeof content === 'string') {
              const enc = String(pick(j, ['encoding']) ?? (pick(j, ['base64']) ? 'base64' : 'utf8'));
              return enc.toLowerCase() === 'base64' ? new Uint8Array(Buffer.from(content, 'base64')) : new TextEncoder().encode(content);
            }
          } else {
            return await readCapped(res, MAX_FILE_BYTES);
          }
        } else {
          await res.body?.cancel().catch(() => undefined);
          if (res.status === 404) {
            // could be "no such file" or "no such endpoint": the command route below tells them apart
          }
        }
      } catch (err) {
        if (err instanceof LocalSandboxError && (err.reason === 'rejected' || err.reason === 'unreachable')) throw err;
      }
    }
    const r = await this.rawExec(`if [ -f ${shq(p)} ] && [ -r ${shq(p)} ]; then base64 < ${shq(p)} | tr -d '\\n'; else echo 'no such file' >&2; exit 1; fi`, { timeoutMs: 120_000, maxBytes: MAX_FILE_BYTES * 2 });
    if (r.exitCode !== 0) throw new LocalSandboxError(`No such file on the sandbox: ${path}`, 404, 'protocol');
    return new Uint8Array(Buffer.from(r.stdout.trim(), 'base64'));
  }

  publicUrl(port: number): string {
    if (!this.proto.preview) throw new Error('This local sandbox has no public preview address. Add "preview" (like https://your-tunnel/{port}) to its Discovery to get one.');
    return this.proto.preview.replace(/\{port\}/g, String(port));
  }

  async extend(): Promise<void> {
    /* the user's own machine: nothing to keep alive */
  }

  async close(): Promise<void> {
    // It's the user's own machine, so nothing is deleted; background processes Orin started are stopped.
    if (this.jobIds.size) {
      const ids = [...this.jobIds];
      this.jobIds.clear();
      await Promise.all(ids.map((id) => this.c.send({ method: 'POST', path: jobPath(this.proto, `/commands/${encodeURIComponent(id)}/cancel`) }, { timeoutMs: 10_000 }).then((r) => r.body?.cancel()).catch(() => undefined)));
    }
    if (!this.pids.size) return;
    const list = [...this.pids].join(' ');
    this.pids.clear();
    await this.rawExec(`kill ${list} 2>/dev/null; true`, { timeoutMs: 10_000 }).catch(() => undefined);
  }
}

/** Prepares the workspace and returns a ready session. */
export async function openLocalSession(
  given: LocalConfig,
  deps: Deps = {},
  proto?: LocalProtocol,
): Promise<{ session: LocalSandboxSession; proto: LocalProtocol; workdir: string; url: string; relayNote?: string }> {
  const f = deps.fetchImpl ?? ((u, i) => fetch(u, i));
  const relay = await followRelay(given, deps);
  const cfg = relay.cfg;
  let p: LocalProtocol;
  try {
    if (relay.dead) throw new LocalSandboxError(`${relay.posted} isn't online.`, 503, 'unreachable');
    p = proto ?? (await resolveProtocol(cfg, deps));
  } catch (err) {
    if (err instanceof LocalSandboxError && relay.posted && err.reason === 'unreachable') {
      throw new LocalSandboxError(
        `The newest address your sandbox posted (${relay.posted}) isn't answering, so the sandbox app or its tunnel on the other phone has probably stopped. Open the sandbox app on that phone and start it again; Orin picks up its new address from Discovery by itself.`,
        err.status,
        'unreachable',
      );
    }
    if (err instanceof LocalSandboxError && relay.note) throw new LocalSandboxError(`${err.message} ${relay.note}`, err.status, err.reason);
    throw err;
  }
  const base = await normaliseLocalUrl(cfg.url, deps.lookup);
  const c = new Client(base, cfg.token, f, { header: p.authHeader, scheme: p.authScheme });
  const raw = async (cmd: string) => {
    if (p.jobs) return runJob(c, p, cmd, { timeoutMs: 30_000 });
    const res = await c.send(p.exec, { body: { command: cmd, cmd, timeout: 30, timeoutMs: 30_000 }, timeoutMs: 45_000 });
    return parseExec(res, await readJsonOrText(res, 256 * 1024));
  };
  // One probe: is bash there, is /home/user/work usable, and where is $HOME.
  const wanted = p.workdir || SANDBOX_WORKDIR;
  const probe = await raw(
    `if command -v bash >/dev/null 2>&1; then echo B=1; else echo B=0; fi; ` +
      `if mkdir -p ${shq(wanted)} 2>/dev/null && [ -w ${shq(wanted)} ]; then echo W=1; else echo W=0; fi; echo H=$HOME`,
  );
  const out = probe.stdout;
  const bash = /B=1/.test(out);
  const homeOk = /W=1/.test(out);
  const home = (out.match(/H=(\S*)/)?.[1] ?? '').replace(/\/+$/, '');
  let pairs: [string, string][];
  let workdir: string;
  if (homeOk && p.jobs && wanted.startsWith(`${p.jobs.guest}/`)) {
    // keep Orin's files inside the workspace folder, so the sandbox's files API reaches them
    workdir = wanted;
    const root = wanted.replace(/\/work$/, '');
    pairs = root !== wanted ? [[SANDBOX_WORKDIR, wanted], ['/home/user', root]] : [[SANDBOX_WORKDIR, wanted]];
  } else if (homeOk) {
    workdir = wanted;
    pairs = wanted === SANDBOX_WORKDIR ? [] : [[SANDBOX_WORKDIR, wanted]];
  } else {
    if (!home) throw new LocalSandboxError(`The sandbox ran a command but Orin couldn't find a folder to work in (${cap(probe.stderr || out, 120)}).`);
    const root = `${home}/orin`;
    workdir = `${root}/work`;
    const mk = await raw(`mkdir -p ${shq(workdir)} && [ -w ${shq(workdir)} ] && echo ok`);
    if (!mk.stdout.includes('ok')) throw new LocalSandboxError(`Orin couldn't create her work folder on the sandbox (${cap(mk.stderr || mk.stdout, 120)}).`);
    pairs = [
      [SANDBOX_WORKDIR, workdir],
      ['/home/user', root],
    ];
  }
  const wrap = bash ? (cmd: string) => `bash -lc ${shq(cmd)}` : (cmd: string) => cmd;
  const id = `local-${Math.random().toString(36).slice(2, 10)}`;
  return { session: new LocalSandboxSession(id, c, p, new PathMap(pairs), wrap), proto: p, workdir, url: base, relayNote: relay.note };
}

/** One health check: reachable, token accepted, a command runs. Returns a plain-words line about it. */
export async function checkLocalSandbox(cfg: LocalConfig, deps: Deps = {}): Promise<{ info: string; proto: LocalProtocol }> {
  const { session, proto, workdir, relayNote } = await openLocalSession(cfg, deps);
  const r = await session.exec('echo ok', { timeoutMs: 20_000 });
  if (!r.stdout.includes('ok')) throw new LocalSandboxError('The sandbox answered but didn\'t run the test command.');
  const files = proto.jobs || (proto.read && proto.write) ? 'files over its API' : 'files through commands';
  const bits = [`Commands work`, files, `works in ${workdir.replace(/^\/data\/data\/com\.termux\/files\/home/, '~')}`];
  if (proto.preview) bits.push('has previews');
  let info = `${bits.join(' · ')}.`;
  if (proto.note) info += ` ${proto.note}`;
  if (relayNote) info += ` ${relayNote}`;
  return { info, proto };
}

/** Provider used by the sandbox manager for one saved local connection. */
export class LocalSandboxProvider implements SandboxProvider {
  readonly id = 'local';
  private proto: { p: LocalProtocol; at: number } | null = null;
  constructor(
    private readonly cfg: LocalConfig,
    private readonly deps: Deps = {},
  ) {}

  needs(): string | null {
    if (!this.cfg.url) return 'Local sandbox needs its URL.';
    if (!this.cfg.token) return 'Local sandbox needs its token.';
    return null;
  }

  async create(_opts: { timeoutMs: number; metadata?: Record<string, string>; signal?: AbortSignal }): Promise<SandboxSession> {
    const cached = this.proto && Date.now() - this.proto.at < 10 * 60_000 ? this.proto.p : undefined;
    try {
      const { session, proto } = await openLocalSession(this.cfg, this.deps, cached);
      this.proto = { p: proto, at: Date.now() };
      return session;
    } catch (err) {
      this.proto = null;
      throw err;
    }
  }
}
