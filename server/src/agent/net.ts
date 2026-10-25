import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '../errors.js';
import type { FetchLike } from '../ai/http.js';

export type LookupFn = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultLookup: LookupFn = (host) => dnsLookup(host, { all: true, verbatim: true });

export const USER_AGENT = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36 OrinAssistant/1.0';

/** true for loopback, private, link-local, CGNAT, multicast and other non-public addresses. */
export function isPrivateAddress(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b, c] = p;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      // only 192.0.0.0/24 and 192.0.2.0/24 are reserved; the rest of 192.0.x.x is public
      // (e.g. WordPress VIP, which hosts nasa.gov and spacenews.com, is on 192.0.66-78.x)
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && b === 51 && c === 100) ||
      (a === 203 && b === 0 && c === 113) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (v === 6) {
    const x = ip.toLowerCase();
    if (x === '::' || x === '::1') return true;
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(x);
    if (mapped) return isPrivateAddress(mapped[1]!);
    return /^(fc|fd|fe8|fe9|fea|feb|ff)/.test(x) || x.startsWith('64:ff9b:') || x.startsWith('2001:db8');
  }
  return true;
}

/** Throws unless the URL is http(s) on a public host (protects against SSRF). */
export async function assertPublicUrl(raw: string, lookup: LookupFn = defaultLookup): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError('validation_error', 'That is not a valid URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new AppError('validation_error', 'Only http and https links can be opened.');
  if (url.username || url.password) throw new AppError('validation_error', 'Links with credentials are not allowed.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new AppError('forbidden', 'Private or local addresses cannot be opened.');
  }
  const addrs = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host).catch(() => []);
  if (!addrs.length) throw new AppError('provider_unavailable', `Could not resolve ${host}.`);
  if (addrs.some((a) => isPrivateAddress(a.address))) throw new AppError('forbidden', 'Private or local addresses cannot be opened.');
  return url;
}

/** Fetch a public URL with manual redirect checks, a timeout and a byte limit. */
export async function safeFetch(
  fetchImpl: FetchLike,
  raw: string,
  opts: { signal: AbortSignal; maxBytes?: number; timeoutMs?: number; lookup?: LookupFn; accept?: string; method?: string },
): Promise<{ url: string; status: number; contentType: string; body: Buffer; truncated: boolean }> {
  const maxBytes = opts.maxBytes ?? 2_000_000;
  const signal = AbortSignal.any([opts.signal, AbortSignal.timeout(opts.timeoutMs ?? 15_000)]);
  let current = raw;
  for (let hop = 0; hop < 6; hop++) {
    const url = await assertPublicUrl(current, opts.lookup);
    let res: Response;
    try {
      res = await fetchImpl(url.toString(), {
        method: opts.method ?? 'GET',
        redirect: 'manual',
        signal,
        headers: { 'User-Agent': USER_AGENT, Accept: opts.accept ?? 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.5', 'Accept-Language': 'en;q=0.9,*;q=0.5' },
      });
    } catch (err) {
      const e = err as Error;
      if (e?.name === 'TimeoutError') throw new AppError('timeout', 'The page took too long to load.');
      if (e?.name === 'AbortError') throw new AppError('cancelled', 'Cancelled.');
      throw new AppError('provider_unavailable', `Could not load ${url.hostname}.`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
      current = new URL(res.headers.get('location')!, url).toString();
      continue;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    if (res.body) {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > maxBytes) {
          chunks.push(Buffer.from(value.subarray(0, value.byteLength - (size - maxBytes))));
          truncated = true;
          await reader.cancel().catch(() => undefined);
          break;
        }
        chunks.push(Buffer.from(value));
      }
    }
    return { url: url.toString(), status: res.status, contentType: res.headers.get('content-type') ?? '', body: Buffer.concat(chunks), truncated };
  }
  throw new AppError('provider_unavailable', 'Too many redirects.');
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', copy: '©' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

export function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();
}

/** Readable text from HTML: drops scripts, styles, navigation and markup; keeps headings and paragraphs. */
export function htmlToText(html: string): { title: string; text: string } {
  const title = stripTags(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  let body = /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  const main = /<(main|article)[^>]*>([\s\S]*?)<\/\1>/i.exec(body)?.[2];
  if (main && main.length > 500) body = main;
  body = body
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe|template)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<h([1-6])[^>]*>/gi, (_m, l: string) => `\n\n${'#'.repeat(Number(l))} `)
    .replace(/<\/(h[1-6]|p|div|section|article|li|tr|table|blockquote|pre)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '\n- ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ');
  const text = decodeEntities(body)
    .split('\n')
    .map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter((l, i, arr) => l || (arr[i - 1] ?? '') !== '')
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { title, text };
}
