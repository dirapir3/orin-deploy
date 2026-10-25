import { z } from 'zod';
import { assertPublicUrl, htmlToText, stripTags, decodeEntities, USER_AGENT } from './net.js';
import { defineTool, type ToolContext } from './tools/types.js';
import { domainMatches, revealLogin } from './vault.js';

/**
 * A lightweight web browser for the agent that works on small hosts without Chromium: it keeps
 * cookies per user, follows links, lists forms and submits them, and can sign in with a Secure
 * Vault login. It does not run page JavaScript. Submitting a form (POST) or signing in always
 * asks the user for approval first; the password is filled in server-side and never shown to the model.
 */
interface FormField {
  name: string;
  type: string;
  value: string;
  options?: string[];
}
interface PageForm {
  action: string;
  method: 'GET' | 'POST';
  fields: FormField[];
}
interface Session {
  cookies: Map<string, Map<string, string>>;
  url: string;
  title: string;
  links: { text: string; url: string }[];
  forms: PageForm[];
  at: number;
}

const sessions = new Map<string, Session>();
const SESSION_TTL = 30 * 60_000;

function session(owner: string): Session {
  const now = Date.now();
  for (const [k, v] of sessions) if (now - v.at > SESSION_TTL) sessions.delete(k);
  let s = sessions.get(owner);
  if (!s) {
    s = { cookies: new Map(), url: '', title: '', links: [], forms: [], at: now };
    sessions.set(owner, s);
  }
  s.at = now;
  return s;
}

export function resetBrowserSessions() {
  sessions.clear();
}

function attrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([a-zA-Z_:-][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(tag))) out[m[1]!.toLowerCase()] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '');
  return out;
}

export function parseForms(html: string, base: string): PageForm[] {
  const forms: PageForm[] = [];
  const re = /<form\b([^>]*)>([\s\S]*?)<\/form>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) && forms.length < 15) {
    const a = attrs(m[1] ?? '');
    const inner = m[2] ?? '';
    const fields: FormField[] = [];
    const fre = /<(input|select|textarea)\b([^>]*)>([\s\S]*?<\/(?:select|textarea)>)?/gi;
    let f: RegExpExecArray | null;
    while ((f = fre.exec(inner)) && fields.length < 40) {
      const tag = f[1]!.toLowerCase();
      const fa = attrs(f[2] ?? '');
      if (!fa.name) continue;
      if (tag === 'input') {
        const type = (fa.type || 'text').toLowerCase();
        if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
        if ((type === 'checkbox' || type === 'radio') && !('checked' in fa)) {
          fields.push({ name: fa.name, type, value: '', options: [fa.value ?? 'on'] });
          continue;
        }
        fields.push({ name: fa.name, type, value: fa.value ?? '' });
      } else if (tag === 'select') {
        const opts = [...(f[3] ?? '').matchAll(/<option\b([^>]*)>([\s\S]*?)(?=<option|<\/select)/gi)].map((o) => {
          const oa = attrs(o[1] ?? '');
          return { value: oa.value ?? stripTags(o[2] ?? '').trim(), selected: 'selected' in oa };
        });
        fields.push({ name: fa.name, type: 'select', value: (opts.find((o) => o.selected) ?? opts[0])?.value ?? '', options: opts.map((o) => o.value).slice(0, 30) });
      } else {
        fields.push({ name: fa.name, type: 'textarea', value: decodeEntities(stripTags((f[3] ?? '').replace(/<\/textarea>$/i, ''))) });
      }
    }
    let action = base;
    try {
      action = new URL(a.action || base, base).toString();
    } catch {
      /* keep base */
    }
    forms.push({ action, method: (a.method || 'get').toUpperCase() === 'POST' ? 'POST' : 'GET', fields });
  }
  return forms;
}

export function parseLinks(html: string, base: string): { text: string; url: string }[] {
  const out: { text: string; url: string }[] = [];
  const seen = new Set<string>();
  for (const m of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = attrs(m[1] ?? '').href;
    if (!href || /^(javascript:|mailto:|tel:|#)/i.test(href)) continue;
    let url: string;
    try {
      url = new URL(href, base).toString();
    } catch {
      continue;
    }
    if (!/^https?:/.test(url) || seen.has(url)) continue;
    seen.add(url);
    const text = stripTags(m[2] ?? '').replace(/\s+/g, ' ').trim().slice(0, 80) || url;
    out.push({ text, url });
    if (out.length >= 60) break;
  }
  return out;
}

function cookieHeader(s: Session, host: string): string {
  const parts: string[] = [];
  for (const [domain, jar] of s.cookies) {
    if (host === domain || host.endsWith(`.${domain}`)) for (const [k, v] of jar) parts.push(`${k}=${v}`);
  }
  return parts.join('; ');
}

function storeCookies(s: Session, host: string, res: Response) {
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const list = h.getSetCookie ? h.getSetCookie() : (res.headers.get('set-cookie') ?? '').split(/,(?=\s*[^;=\s]+=)/).filter(Boolean);
  for (const c of list) {
    const [pair, ...rest] = c.split(';');
    const eq = pair!.indexOf('=');
    if (eq < 1) continue;
    const name = pair!.slice(0, eq).trim();
    const value = pair!.slice(eq + 1).trim();
    const dom = rest.map((r) => r.trim()).find((r) => /^domain=/i.test(r))?.slice(7).replace(/^\./, '').toLowerCase();
    const domain = dom && (host === dom || host.endsWith(`.${dom}`)) ? dom : host;
    if (!s.cookies.has(domain)) s.cookies.set(domain, new Map());
    const expired = rest.some((r) => /^max-age=0/i.test(r.trim()) || (/^expires=/i.test(r.trim()) && Date.parse(r.trim().slice(8)) < Date.now()));
    if (expired) s.cookies.get(domain)!.delete(name);
    else s.cookies.get(domain)!.set(name, value);
  }
}

async function load(ctx: ToolContext, url: string, init: { method: 'GET' | 'POST'; body?: string }): Promise<{ url: string; status: number; html: string }> {
  const s = session(ctx.owner);
  const signal = AbortSignal.any([ctx.signal, AbortSignal.timeout(20_000)]);
  let current = url;
  let method = init.method;
  let body = init.body;
  for (let hop = 0; hop < 8; hop++) {
    const u = await assertPublicUrl(current, ctx.services.lookup);
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT, Accept: 'text/html,application/xhtml+xml,*/*;q=0.5', 'Accept-Language': 'en;q=0.9' };
    const ck = cookieHeader(s, u.hostname);
    if (ck) headers.Cookie = ck;
    if (method === 'POST') headers['Content-Type'] = 'application/x-www-form-urlencoded';
    if (s.url) headers.Referer = s.url;
    const res = await ctx.services.fetchImpl(u.toString(), { method, body: method === 'POST' ? body : undefined, redirect: 'manual', signal, headers });
    storeCookies(s, u.hostname, res);
    const loc = res.headers.get('location');
    if (res.status >= 300 && res.status < 400 && loc) {
      current = new URL(loc, u).toString();
      if (res.status !== 307 && res.status !== 308) {
        method = 'GET';
        body = undefined;
      }
      continue;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    return { url: u.toString(), status: res.status, html: buf.subarray(0, 2_000_000).toString('utf8') };
  }
  throw new Error('Too many redirects.');
}

function describe(ctx: ToolContext, page: { url: string; status: number; html: string }) {
  const s = session(ctx.owner);
  const { title, text } = htmlToText(page.html);
  s.url = page.url;
  s.title = title;
  s.links = parseLinks(page.html, page.url);
  s.forms = parseForms(page.html, page.url);
  const forms = s.forms
    .map((f, i) => `Form ${i + 1}: ${f.method} ${f.action}\n${f.fields.filter((x) => x.type !== 'hidden').map((x) => `  - ${x.name} (${x.type}${x.options ? `: ${x.options.slice(0, 8).join(' | ')}` : ''})${x.value && x.type !== 'password' ? ` = "${x.value.slice(0, 60)}"` : ''}`).join('\n') || '  (only hidden fields)'}`)
    .join('\n');
  const links = s.links.slice(0, 40).map((l, i) => `[${i + 1}] ${l.text}`).join('\n');
  const content = `URL: ${page.url} (HTTP ${page.status})\nTitle: ${title}\n\n${text.slice(0, 7000)}\n\n## Links (use browser_click with the number)\n${links || '(none)'}\n\n## Forms (use browser_submit)\n${forms || '(none)'}`;
  return { content, summary: `Opened ${title || page.url}`.slice(0, 80), display: { kind: 'page' as const, url: page.url, title: title || page.url } };
}

export const browserOpenTool = defineTool({
  name: 'browser_open',
  description: 'Open a web page in your browser session (keeps cookies, so you can sign in and move around a site). Returns the page text, numbered links and forms. Does not run JavaScript; for plain reading prefer fetch_page.',
  schema: z.object({ url: z.string().min(4).max(2000) }),
  label: (a) => `Opening ${a.url.replace(/^https?:\/\//, '').slice(0, 40)}…`,
  handler: async (a, ctx) => describe(ctx, await load(ctx, /^https?:/i.test(a.url) ? a.url : `https://${a.url}`, { method: 'GET' })),
});

export const browserClickTool = defineTool({
  name: 'browser_click',
  description: 'Follow a numbered link from the last page opened with browser_open.',
  schema: z.object({ link: z.number().int().min(1) }),
  label: () => 'Following a link…',
  handler: async (a, ctx) => {
    const l = session(ctx.owner).links[a.link - 1];
    if (!l) return { ok: false, content: 'No link with that number on the current page. Open a page first.', summary: 'No such link' };
    return describe(ctx, await load(ctx, l.url, { method: 'GET' }));
  },
});

const submitSchema = z.object({
  form: z.number().int().min(1).describe('Form number from the page'),
  fields: z.record(z.string(), z.string()).optional().describe('Field name -> value to fill in. Never put passwords here; use login.'),
  login: z.string().max(100).optional().describe('Name of a Secure Vault login to sign in with; the username and password are filled in for you'),
});

function plan(a: z.infer<typeof submitSchema>, ctx: ToolContext) {
  const s = session(ctx.owner);
  const form = s.forms[a.form - 1];
  if (!form) return { error: 'No form with that number on the current page. Open the page first with browser_open.' };
  const values = new Map(form.fields.filter((f) => f.value || f.type === 'hidden').map((f) => [f.name, f.value]));
  for (const [k, v] of Object.entries(a.fields ?? {})) values.set(k, v);
  let loginInfo: { name: string; username: string; password: string; userField?: string; passField?: string } | null = null;
  if (a.login) {
    const row = ctx.services.store.findVault(ctx.owner.split('#')[0]!, a.login);
    if (!row) return { error: `No saved login called "${a.login}" in the Secure Vault. Use vault_list to see saved logins, or ask the user to add one in the app (Settings > Secure Vault).` };
    const host = new URL(form.action).hostname;
    if (!domainMatches(row.domain, host)) return { error: `The login "${row.name}" is saved for ${row.domain}, but this form sends to ${host}. For safety it will not be used here.` };
    const { username, password } = revealLogin(row);
    const passField = form.fields.find((f) => f.type === 'password')?.name;
    const idx = form.fields.findIndex((f) => f.name === passField);
    const userField =
      form.fields.find((f) => /user|email|login|account|name/i.test(f.name) && ['text', 'email', 'tel'].includes(f.type))?.name ??
      form.fields.slice(0, Math.max(idx, 0)).reverse().find((f) => ['text', 'email', 'tel'].includes(f.type))?.name;
    if (!passField) return { error: 'This form has no password field, so a login cannot be filled in.' };
    loginInfo = { name: row.name, username, password, userField, passField };
    if (userField) values.set(userField, username);
    values.set(passField, password);
  }
  return { form, values, loginInfo, page: s.url };
}

export const browserSubmitTool = defineTool({
  name: 'browser_submit',
  description: 'Fill in and submit a form from the current page, optionally signing in with a Secure Vault login (login = its name). Submitting data or signing in asks the user for approval first.',
  schema: submitSchema,
  label: (a) => (a.login ? `Signing in with ${a.login}…` : 'Submitting a form…'),
  approval: (a, ctx) => {
    const p = plan(a, ctx);
    if ('error' in p) return null;
    if (p.form.method === 'GET' && !p.loginInfo) return null; // a search box: nothing is sent
    const pf = p.loginInfo?.passField;
    const fields = [
      { label: 'Page', value: p.page },
      { label: 'Sends to', value: `${p.form.method} ${p.form.action}` },
      ...(p.loginInfo ? [{ label: 'Login', value: `${p.loginInfo.name} (${p.loginInfo.username || 'no username'})` }] : []),
      ...[...p.values.entries()]
        .filter(([k]) => !p.form.fields.find((f) => f.name === k && f.type === 'hidden'))
        .map(([k, v]) => ({ label: k, value: k === pf || p.form.fields.find((f) => f.name === k)?.type === 'password' ? '••••••••' : v.slice(0, 200) })),
    ];
    return { title: p.loginInfo ? `Sign in to ${new URL(p.form.action).hostname}` : `Submit a form on ${new URL(p.form.action).hostname}`, body: p.loginInfo ? 'Orin wants to sign in with your saved login. The password stays hidden.' : 'Orin wants to send this form.', fields };
  },
  handler: async (a, ctx) => {
    const p = plan(a, ctx);
    if ('error' in p) return { ok: false, content: p.error ?? 'Cannot submit.', summary: 'Cannot submit' };
    if (p.loginInfo) {
      ctx.secrets ??= new Set();
      if (p.loginInfo.password) ctx.secrets.add(p.loginInfo.password);
    }
    const body = new URLSearchParams([...p.values.entries()]).toString();
    const page =
      p.form.method === 'GET'
        ? await load(ctx, `${p.form.action.split('?')[0]}?${body}`, { method: 'GET' })
        : await load(ctx, p.form.action, { method: 'POST', body });
    const d = describe(ctx, page);
    let content = d.content;
    if (p.loginInfo?.password) content = content.split(p.loginInfo.password).join('[hidden]');
    return { ...d, content: `${p.loginInfo ? `Submitted the sign-in form with the saved login "${p.loginInfo.name}". Check the page below to see whether it worked.\n\n` : ''}${content}`, summary: p.loginInfo ? `Signed in with ${p.loginInfo.name}` : 'Form sent' };
  },
});

export const browserTools = [browserOpenTool, browserClickTool, browserSubmitTool];
