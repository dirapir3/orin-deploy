import { z } from 'zod';
import { defineTool, type AgentServices } from './types.js';
import { htmlToText, safeFetch, stripTags, decodeEntities, USER_AGENT } from '../net.js';

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

/** Parses DuckDuckGo's lite HTML results page. */
export function parseDuckDuckGoLite(html: string): SearchResult[] {
  const out: SearchResult[] = [];
  const linkRe = /<a[^>]+href="([^"]+)"[^>]*class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+class=['"]result-link['"][^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const snippetRe = /<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/gi;
  const snippets = [...html.matchAll(snippetRe)].map((m) => stripTags(m[1] ?? ''));
  let i = 0;
  for (const m of html.matchAll(linkRe)) {
    let href = decodeEntities(m[1] ?? m[3] ?? '');
    const title = stripTags(m[2] ?? m[4] ?? '');
    if (href.startsWith('//')) href = `https:${href}`;
    try {
      const u = new URL(href, 'https://duckduckgo.com');
      const real = u.searchParams.get('uddg');
      if (real) href = real;
      else href = u.toString();
    } catch {
      continue;
    }
    // Skip ads (they go through duckduckgo.com/y.js)
    if (/duckduckgo\.com\/y\.js/.test(href) || !/^https?:/.test(href)) {
      i++;
      continue;
    }
    out.push({ title, url: href, snippet: snippets[i] ?? '', source: 'duckduckgo' });
    i++;
  }
  return out;
}

async function searchDuckDuckGo(svc: AgentServices, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await svc.fetchImpl(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}&kl=wt-wt`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'text/html' },
    signal: AbortSignal.any([signal, AbortSignal.timeout(12_000)]),
  });
  if (res.status !== 200) throw new Error(`duckduckgo ${res.status}`);
  return parseDuckDuckGoLite(await res.text());
}

async function searchWikipedia(svc: AgentServices, query: string, signal: AbortSignal, lang = 'en'): Promise<SearchResult[]> {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&srlimit=3&origin=*`;
  const res = await svc.fetchImpl(url, { headers: { 'User-Agent': 'OrinAssistant/1.0 (https://github.com/orin)' }, signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]) });
  if (!res.ok) throw new Error(`wikipedia ${res.status}`);
  const json = (await res.json()) as { query?: { search?: { title: string; snippet: string }[] } };
  return (json.query?.search ?? []).map((r) => ({
    title: `${r.title} — Wikipedia`,
    url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(r.title.replace(/ /g, '_'))}`,
    snippet: stripTags(r.snippet),
    source: 'wikipedia',
  }));
}

async function searchTavily(svc: AgentServices, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await svc.fetchImpl('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${svc.config.integrations.tavilyKey}` },
    body: JSON.stringify({ query, max_results: 8, search_depth: 'basic' }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!res.ok) throw new Error(`tavily ${res.status}`);
  const json = (await res.json()) as { results?: { title: string; url: string; content: string }[] };
  return (json.results ?? []).map((r) => ({ title: r.title, url: r.url, snippet: r.content.slice(0, 400), source: 'tavily' }));
}

async function searchBrave(svc: AgentServices, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await svc.fetchImpl(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=8`, {
    headers: { Accept: 'application/json', 'X-Subscription-Token': svc.config.integrations.braveKey },
    signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)]),
  });
  if (!res.ok) throw new Error(`brave ${res.status}`);
  const json = (await res.json()) as { web?: { results?: { title: string; url: string; description: string }[] } };
  return (json.web?.results ?? []).map((r) => ({ title: stripTags(r.title), url: r.url, snippet: stripTags(r.description), source: 'brave' }));
}

async function searchSerper(svc: AgentServices, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await svc.fetchImpl('https://google.serper.dev/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-KEY': svc.config.integrations.serperKey },
    body: JSON.stringify({ q: query, num: 8 }),
    signal,
  });
  if (!res.ok) throw new Error(`serper ${res.status}`);
  const json = (await res.json()) as { organic?: { title: string; link: string; snippet?: string }[] };
  return (json.organic ?? []).map((r) => ({ title: r.title, url: r.link, snippet: r.snippet ?? '', source: 'serper' }));
}

async function searchExa(svc: AgentServices, query: string, signal: AbortSignal): Promise<SearchResult[]> {
  const res = await svc.fetchImpl('https://api.exa.ai/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': svc.config.integrations.exaKey },
    body: JSON.stringify({ query, numResults: 8, contents: { text: { maxCharacters: 400 } } }),
    signal,
  });
  if (!res.ok) throw new Error(`exa ${res.status}`);
  const json = (await res.json()) as { results?: { title?: string; url: string; text?: string }[] };
  return (json.results ?? []).map((r) => ({ title: r.title || r.url, url: r.url, snippet: (r.text ?? '').slice(0, 400), source: 'exa' }));
}

/** Best available search: Tavily, Brave, Serper or Exa when keyed (first that works), else DuckDuckGo (lite) + Wikipedia, keyless. */
export async function webSearch(svc: AgentServices, query: string, signal: AbortSignal, max = 6): Promise<{ results: SearchResult[]; engine: string; warnings: string[] }> {
  const warnings: string[] = [];
  const i = svc.config.integrations;
  if (i.tavilyKey) {
    try {
      return { results: (await searchTavily(svc, query, signal)).slice(0, max), engine: 'Tavily', warnings };
    } catch (e) {
      warnings.push(`Tavily failed (${(e as Error).message}); used the free search instead.`);
    }
  }
  if (i.braveKey) {
    try {
      return { results: (await searchBrave(svc, query, signal)).slice(0, max), engine: 'Brave', warnings };
    } catch (e) {
      warnings.push(`Brave failed (${(e as Error).message}); used the free search instead.`);
    }
  }
  if (i.serperKey) {
    try {
      return { results: (await searchSerper(svc, query, signal)).slice(0, max), engine: 'Serper', warnings };
    } catch (e) {
      warnings.push(`Serper failed (${(e as Error).message}); used the free search instead.`);
    }
  }
  if (i.exaKey) {
    try {
      return { results: (await searchExa(svc, query, signal)).slice(0, max), engine: 'Exa', warnings };
    } catch (e) {
      warnings.push(`Exa failed (${(e as Error).message}); used the free search instead.`);
    }
  }
  const [ddg, wiki] = await Promise.allSettled([searchDuckDuckGo(svc, query, signal), searchWikipedia(svc, query, signal)]);
  const results: SearchResult[] = [];
  if (ddg.status === 'fulfilled') results.push(...ddg.value.slice(0, max));
  else warnings.push('DuckDuckGo did not answer.');
  if (wiki.status === 'fulfilled') {
    for (const w of wiki.value.slice(0, 2)) if (!results.some((r) => r.url === w.url)) results.push(w);
  }
  return { results: results.slice(0, max + 2), engine: 'DuckDuckGo + Wikipedia', warnings };
}

export const webSearchTool = defineTool({
  name: 'web_search',
  description:
    'Search the web for current or factual information (news, prices, people, places, docs). Returns titles, URLs and snippets. Cite the sources you use as Markdown links.',
  schema: z.object({
    query: z.string().min(1).max(300).describe('Search query'),
    max_results: z.number().int().min(1).max(10).optional().describe('Default 6'),
  }),
  label: (a) => `Searching the web for “${a.query.slice(0, 60)}”…`,
  handler: async (args, ctx) => {
    const { results, engine, warnings } = await webSearch(ctx.services, args.query, ctx.signal, args.max_results ?? 6);
    if (!results.length) {
      return { ok: false, content: `No results found for "${args.query}". ${warnings.join(' ')}`.trim(), summary: 'No results' };
    }
    const lines = results.map((r, i) => `[${i + 1}] ${r.title}\nURL: ${r.url}\n${r.snippet}`);
    return {
      content: `Search results (${engine}) for "${args.query}":\n\n${lines.join('\n\n')}\n\nCite sources inline as Markdown links like [title](url). Use fetch_page for details.${warnings.length ? `\nNote: ${warnings.join(' ')}` : ''}`,
      summary: `Found ${results.length} results`,
      display: { kind: 'sources', sources: results.map((r) => ({ title: r.title, url: r.url })) },
    };
  },
});

export async function fetchReadable(svc: AgentServices, url: string, signal: AbortSignal, maxChars = 12_000) {
  const res = await safeFetch(svc.fetchImpl, url, { signal, lookup: svc.lookup, maxBytes: 2_000_000 });
  if (res.status >= 400) throw new Error(`The page returned HTTP ${res.status}.`);
  const ct = res.contentType.toLowerCase();
  const raw = res.body.toString('utf8');
  let title = '';
  let text: string;
  if (ct.includes('html') || /^\s*<(!doctype|html)/i.test(raw)) {
    const r = htmlToText(raw);
    title = r.title;
    text = r.text;
  } else if (ct.startsWith('text/') || ct.includes('json') || ct.includes('xml') || ct === '') {
    text = raw;
  } else {
    throw new Error(`Unsupported content type: ${ct || 'unknown'}.`);
  }
  const truncated = text.length > maxChars || res.truncated;
  return { url: res.url, title, text: text.slice(0, maxChars), truncated };
}

export const fetchPageTool = defineTool({
  name: 'fetch_page',
  description: 'Open a public web page and return its readable text (no scripts). Use after web_search or when the user gives a link.',
  schema: z.object({
    url: z.string().min(4).max(2000).describe('http(s) URL'),
    max_chars: z.number().int().min(500).max(30000).optional().describe('Default 12000'),
  }),
  label: (a) => {
    let host = a.url;
    try {
      host = new URL(a.url).hostname;
    } catch {
      /* keep raw */
    }
    return `Reading ${host}…`;
  },
  handler: async (args, ctx) => {
    const page = await fetchReadable(ctx.services, args.url, ctx.signal, args.max_chars ?? 12_000);
    return {
      content: `Title: ${page.title || '(none)'}\nURL: ${page.url}\n\n${page.text}${page.truncated ? '\n\n[truncated]' : ''}`,
      summary: `Read ${page.title || new URL(page.url).hostname}`.slice(0, 80),
      display: { kind: 'page', url: page.url, title: page.title || new URL(page.url).hostname },
    };
  },
});
