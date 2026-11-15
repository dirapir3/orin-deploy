/**
 * Notes & pages: what Orin makes for the user, like Sesame's artifacts.
 * A note is Markdown, shown in the app's own note view. A page is HTML, served from
 * /v1/pages/<signed link> under a strict sandbox (no cookies, no same-origin, no forms),
 * so a page the model wrote can never reach the user's session or the API.
 */
import type { Request, Response, Router } from 'express';
import express from 'express';
import type { AgentStore, Note } from './store.js';
import { signToken, verifyToken } from './vault.js';

/** The Sky/Ink look every page starts from, unless the model sent a full document of its own. */
const BASE_CSS = `
:root{--sky:#7cc4ff;--sky-deep:#2f8fe0;--ink:#0d1420;--ink-2:#17202e;--paper:#f6f8fb;--card:#ffffff;--line:#e3e8ef;--muted:#5b6778;--text:#0d1420}
@media (prefers-color-scheme:dark){:root{--paper:#0b111a;--card:#131b27;--line:#243042;--muted:#93a1b5;--text:#eef3f9}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--paper);color:var(--text);font:16px/1.6 'DM Sans',system-ui,-apple-system,sans-serif;padding:24px 18px 48px;max-width:760px;margin-inline:auto;overflow-wrap:anywhere}
h1,h2{font-family:'Anton','DM Sans',sans-serif;font-weight:400;letter-spacing:.01em;line-height:1.15}
h1{font-size:34px;margin:4px 0 14px}h2{font-size:24px;margin:28px 0 10px}h3{font-size:18px;margin:22px 0 8px}
a{color:var(--sky-deep)}p,ul,ol{margin:0 0 14px}li{margin:4px 0}
img,video,canvas,svg{max-width:100%;height:auto;border-radius:12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:16px 18px;margin:14px 0}
.muted{color:var(--muted)}.pill{display:inline-block;padding:2px 10px;border-radius:999px;background:color-mix(in srgb,var(--sky) 22%,transparent);font-size:13px}
table{width:100%;border-collapse:collapse;margin:12px 0;font-size:15px;display:block;overflow-x:auto}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600}
code,pre{font-family:ui-monospace,Menlo,monospace;font-size:14px}pre{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;overflow-x:auto}
blockquote{margin:12px 0;padding:4px 14px;border-left:3px solid var(--sky);color:var(--muted)}
button{font:inherit;border:0;border-radius:999px;padding:10px 16px;background:var(--ink);color:#fff}
@media (prefers-color-scheme:dark){button{background:var(--sky);color:var(--ink)}}
`;
const FONTS = '<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Anton&family=DM+Sans:wght@400;500;600;700&display=swap">';

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Strips the opening and closing ``` fence a model sometimes wraps its HTML in. */
export function unfence(html: string): string {
  const m = html.trim().match(/^```(?:html)?\s*\n([\s\S]*?)\n?```\s*$/i);
  return m ? m[1]! : html;
}

/** A whole HTML document for the page: the model's own document, or its body inside the Sky/Ink skeleton. */
export function pageDocument(title: string, html: string): string {
  const src = unfence(html);
  if (/<html[\s>]|<!doctype/i.test(src)) {
    // its own document: only make sure it fits a phone
    if (/<meta[^>]+name=["']viewport/i.test(src)) return src;
    return src.replace(/<head([^>]*)>/i, '<head$1><meta name="viewport" content="width=device-width,initial-scale=1">');
  }
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>${FONTS}<style>${BASE_CSS}</style></head><body>${src}</body></html>`;
}

/** The page's shell when its link has expired or the page is gone: same look, one clear line. */
function gonePage(line: string): string {
  return pageDocument('Page', `<div class="card"><h2 style="margin-top:0">This page can't open</h2><p class="muted">${esc(line)}</p></div>`);
}

/** Pages may run their own scripts and load from https (charts, fonts, pictures), but get no cookies, forms or same-origin access. */
export const PAGE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' https:",
  "style-src 'unsafe-inline' https:",
  'font-src https: data:',
  'img-src https: data: blob:',
  'media-src https: data: blob:',
  'connect-src https:',
  "frame-ancestors 'self'",
  'sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox',
].join('; ');

export interface PageLinkDeps {
  sign: (payload: Record<string, unknown>, ttlSec: number) => string;
  verify: (token: string) => Record<string, unknown> | null;
}
/** Signed with the vault key, so a link can't be forged or changed to open another page. */
export const vaultLinks: PageLinkDeps = {
  sign: (payload, ttlSec) => signToken(JSON.stringify(payload), ttlSec),
  verify: (token) => {
    const raw = verifyToken(token);
    if (!raw) return null;
    try {
      const v = JSON.parse(raw) as unknown;
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  },
};

/** A link that opens one page for an hour, without the user's sign-in (the app fetches a fresh one each time). */
export function pageLink(baseUrl: string, owner: string, id: string, ttlSec = 3600, deps: PageLinkDeps = vaultLinks): string {
  const t = deps.sign({ k: 'page', o: owner, n: id }, ttlSec);
  return `${baseUrl.replace(/\/$/, '')}/v1/pages/${encodeURIComponent(t)}`;
}

export function pagesRouter(store: () => AgentStore | null, deps: PageLinkDeps = vaultLinks): Router {
  const r = express.Router();
  r.get('/:token', (req: Request, res: Response) => {
    res.setHeader('Content-Security-Policy', PAGE_CSP);
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    // the web app runs cross-origin isolated (COEP credentialless), so a frame inside it must opt in too
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'private, no-store');
    res.type('html');
    const p = deps.verify(String(req.params.token ?? ''));
    const st = store();
    if (!p || p.k !== 'page' || typeof p.o !== 'string' || typeof p.n !== 'string' || !st) {
      res.status(404).send(gonePage('The link has expired. Go back and open the page again.'));
      return;
    }
    const note: Note | null = st.getNote(p.o, p.n);
    if (!note) {
      res.status(404).send(gonePage('This page was deleted.'));
      return;
    }
    res.send(note.kind === 'page' ? pageDocument(note.title, note.body) : pageDocument(note.title, `<h1>${esc(note.title)}</h1><pre style="white-space:pre-wrap">${esc(note.body)}</pre>`));
  });
  return r;
}

/** Applies exact text replacements; each old text must appear exactly once. */
export function applyEdits(body: string, edits: { old: string; new: string }[]): { ok: true; body: string } | { ok: false; error: string } {
  let out = body;
  for (const [i, e] of edits.entries()) {
    if (!e.old) return { ok: false, error: `Edit ${i + 1}: old text is empty.` };
    const first = out.indexOf(e.old);
    if (first < 0) return { ok: false, error: `Edit ${i + 1}: the old text was not found. Read the note again and copy it exactly.` };
    if (out.indexOf(e.old, first + 1) >= 0) return { ok: false, error: `Edit ${i + 1}: the old text appears more than once. Include more of the text around it.` };
    out = out.slice(0, first) + e.new + out.slice(first + e.old.length);
  }
  return { ok: true, body: out };
}

/** The first lines of a note as plain text, for its card in the chat. */
export function notePreview(n: Pick<Note, 'body' | 'kind'>, max = 160): string {
  const text =
    n.kind === 'page'
      ? unfence(n.body).replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      : n.body.replace(/^#+\s*/gm, '').replace(/[*_`>|]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1).trimEnd()}…` : one;
}
