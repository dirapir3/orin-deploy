import { z } from 'zod';
import type { ImageInput } from '../../ai/types.js';
import { lintDesign, parseReview, REVIEW_RUBRIC, sortIssues, type DesignIssue } from '../craft.js';

import { safeFetch } from '../net.js';
import { planSite } from '../sites.js';
import { SANDBOX_WORKDIR, sandboxPath } from '../sandbox/types.js';
import { workspaceDir } from '../workspace.js';
import { defineTool, type ToolContext } from './types.js';
import { withSandbox } from './sandbox.js';

/**
 * review_design: Orin looks at what she built before calling it done. It renders the page in a
 * headless browser on her computer at phone and desktop sizes, measures what users would hit
 * (sideways scrolling, default fonts, low contrast, tiny tap targets, broken images, script
 * errors), lints the HTML/CSS for the marks of a dated page, and has the vision model score the
 * screenshots against a professional design rubric. The result is a ranked list of fixes.
 */

const REVIEW_DIR = '/home/user/.orin/review';
const SHOT_DIR = `${SANDBOX_WORKDIR}/screenshots`;

export const REVIEW_PY = String.raw`#!/usr/bin/env python3
import base64, http.server, json, os, socketserver, sys, threading

/** The visual score a build needs to pass (scored against the design skill in agent/designKit.ts). */
export const PASS_SCORE = 8;
from playwright.sync_api import sync_playwright

METRICS = r"""
() => {
  const W = innerWidth, doc = document.documentElement, body = document.body || doc;
  const parse = c => { const m = /rgba?\(([^)]+)\)/.exec(c || ''); if (!m) return null; const p = m[1].split(',').map(s => parseFloat(s)); return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 }; };
  const lum = ({ r, g, b }) => { const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
  const bgOf = el => { while (el && el.nodeType === 1) { const cs = getComputedStyle(el); if (cs.backgroundImage && cs.backgroundImage !== 'none') return null; const c = parse(cs.backgroundColor); if (c && c.a > 0.5) return c; el = el.parentElement; } return { r: 255, g: 255, b: 255, a: 1 }; };
  const low = []; let checked = 0; const seen = new Set();
  const tw = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  while (tw.nextNode() && checked < 400) {
    const t = tw.currentNode, el = t.parentElement;
    if (!el || seen.has(el) || !t.textContent.trim()) continue; seen.add(el);
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el); if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.2) continue;
    checked++;
    const fg = parse(cs.color), bg = bgOf(el); if (!fg || !bg || fg.a < 0.3) continue;
    const a = lum(fg), b = lum(bg), ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const size = parseFloat(cs.fontSize), large = size >= 24 || (size >= 18.6 && parseInt(cs.fontWeight) >= 700);
    if (ratio < (large ? 3 : 4.5)) low.push({ text: t.textContent.trim().slice(0, 40), ratio: Math.round(ratio * 10) / 10 });
  }
  const small = [...document.querySelectorAll('button,input:not([type=hidden]),select,textarea,[role=button],nav a,a.button,a.btn')].filter(e => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && (r.height < 32 || r.width < 32); }).length;
  const broken = [...document.images].filter(i => i.complete && i.naturalWidth === 0).length;
  let wide = 0; document.querySelectorAll('p,li').forEach(p => { if (p.getBoundingClientRect().width > 900 && (p.innerText || '').length > 160) wide++; });
  const defaultLinks = [...document.querySelectorAll('a[href]')].slice(0, 60).filter(a => ['rgb(0, 0, 238)', 'rgb(85, 26, 139)'].includes(getComputedStyle(a).color)).length;
  const bcs = getComputedStyle(body);
  return { overflowX: Math.max(doc.scrollWidth, body.scrollWidth) - W, font: bcs.fontFamily, fontSize: parseFloat(bcs.fontSize), lowContrast: low.slice(0, 5), lowContrastCount: low.length, checked, smallTargets: small, brokenImgs: broken, textLen: (body.innerText || '').trim().length, wide, defaultLinks, height: Math.max(doc.scrollHeight, body.scrollHeight), title: document.title };
}
"""
SHEETS = "() => [...document.styleSheets].map(s => { try { return [...s.cssRules].map(r => r.cssText).join('\\n'); } catch (e) { return ''; } }).join('\\n')"

a = json.loads(os.environ['ORIN_REVIEW'])
target, out = a['target'], a['out']
os.makedirs(out, exist_ok=True)
url = target
if not target.startswith(('http://', 'https://', 'file://')):
    root, page = target, 'index.html'
    if os.path.isfile(root):
        root, page = os.path.dirname(root) or '.', os.path.basename(root)
    if not os.path.isfile(os.path.join(root, page)):
        print(json.dumps({'ok': False, 'error': 'No %s in %s' % (page, root)}))
        sys.exit(0)

    class H(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kw):
            super().__init__(*args, directory=root, **kw)

        def log_message(self, *x):
            pass

    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), H)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/%s' % (srv.server_address[1], page)

res = {'ok': True, 'url': url, 'views': []}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
    for name, w, h, mobile in [('phone', 390, 844, True), ('desktop', 1280, 800, False)]:
        ctx = b.new_context(viewport={'width': w, 'height': h}, is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
        pg = ctx.new_page()
        errs, failed = [], []
        pg.on('console', lambda m, errs=errs: errs.append(m.text[:200]) if m.type == 'error' else None)
        pg.on('pageerror', lambda e, errs=errs: errs.append(str(e)[:200]))
        pg.on('requestfailed', lambda r, failed=failed: failed.append(r.url[:150]))
        v = {'name': name, 'width': w}
        try:
            resp = pg.goto(url, wait_until='load', timeout=30000)
            v['status'] = resp.status if resp else None
            try:
                pg.wait_for_load_state('networkidle', timeout=5000)
            except Exception:
                pass
            pg.wait_for_timeout(700)
            v['m'] = pg.evaluate(METRICS)
            hgt = max(h, min(int(v['m'].get('height') or h), 2400))
            shot = os.path.join(out, 'review-%s.jpg' % name)
            pg.screenshot(path=shot, type='jpeg', quality=55, full_page=True, clip={'x': 0, 'y': 0, 'width': w, 'height': hgt})
            v['shot'] = shot
            if name == 'desktop':
                res['html'] = pg.content()[:300000]
                res['css'] = pg.evaluate(SHEETS)[:300000]
        except Exception as e:
            v['error'] = str(e)[:300]
        v['errors'] = errs[:5]
        v['failed'] = failed[:5]
        res['views'].append(v)
        ctx.close()
    b.close()
print(json.dumps(res))
`;

interface View {
  name: string;
  width: number;
  status?: number | null;
  error?: string;
  errors?: string[];
  failed?: string[];
  shot?: string;
  m?: {
    overflowX: number;
    font: string;
    fontSize: number;
    lowContrast: { text: string; ratio: number }[];
    lowContrastCount: number;
    smallTargets: number;
    brokenImgs: number;
    textLen: number;
    wide: number;
    defaultLinks: number;
    title: string;
  };
}
export interface RenderResult {
  ok: boolean;
  error?: string;
  url?: string;
  views?: View[];
  html?: string;
  css?: string;
}

/** Turns what the browser measured into ranked issues. Pure, so it is tested without a browser. */
export function renderIssues(r: RenderResult): DesignIssue[] {
  const out: DesignIssue[] = [];
  const add = (severity: DesignIssue['severity'], issue: string, fix: string) => out.push({ severity, issue, fix });
  for (const v of r.views ?? []) {
    const at = v.name === 'phone' ? 'on a phone (390px)' : 'on desktop (1280px)';
    if (v.error) {
      add('high', `The page did not load ${at}: ${v.error}`, 'Make sure the page loads; check the path or start the server.');
      continue;
    }
    if (v.status && v.status >= 400) add('high', `The page answered HTTP ${v.status} ${at}.`, 'Fix the address or the server so the page loads.');
    const missing = (v.errors ?? []).filter((e) => /^Failed to load resource/i.test(e));
    const jsErrors = (v.errors ?? []).filter((e) => !/^Failed to load resource/i.test(e));
    if (jsErrors.length) add('high', `JavaScript errors ${at}: ${[...new Set(jsErrors)].slice(0, 3).join(' | ')}`, 'Fix these errors; part of the page may not work.');
    if (v.failed?.length || missing.length) add('medium', `Files that failed to load ${at}: ${[...new Set([...(v.failed ?? []), ...missing])].slice(0, 3).join(', ')}`, 'Fix the links (relative paths) or remove what is missing.');
    const m = v.m;
    if (!m) continue;
    if (m.textLen < 20) add('high', `The page looks blank ${at} (almost no visible text).`, 'Check that the content renders (a script error or a wrong path can leave it empty).');
    if (v.name === 'phone' && m.overflowX > 4) add('high', `Sideways scrolling on a phone: the page is ${Math.round(m.overflowX)}px wider than the screen.`, 'Find the element with a fixed width or long unbroken content; use max-width: 100%, flex-wrap, minmax() grids and overflow-wrap: anywhere.');
    if (v.name === 'phone' && /^\s*["']?(times|serif\b)/i.test(m.font)) add('high', 'The text is in the browser default Times font.', 'Set body { font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif }.');
    if (v.name === 'phone' && m.fontSize < 15) add('medium', `Body text is only ${m.fontSize}px on a phone.`, 'Use 16px or more for body text.');
    if (v.name === 'phone' && m.smallTargets > 2) add('medium', `${m.smallTargets} buttons or controls are smaller than 32px on a phone.`, 'Make tap targets at least 44px tall (padding, min-height).');
    if (v.name === 'phone' && m.brokenImgs) add('high', `${m.brokenImgs} image${m.brokenImgs === 1 ? '' : 's'} failed to load.`, 'Fix the image paths or use images that exist.');
    if (v.name === 'phone' && m.lowContrastCount) add(m.lowContrastCount > 5 ? 'high' : 'medium', `${m.lowContrastCount} text element${m.lowContrastCount === 1 ? '' : 's'} with low contrast, e.g. ${m.lowContrast.map((c) => `"${c.text}" ${c.ratio}:1`).join(', ')}.`, 'Raise text contrast to at least 4.5:1 (3:1 for large headings).');
    if (v.name === 'phone' && m.defaultLinks) add('medium', 'Links still use the browser default blue/purple.', 'Style links with the accent colour and a hover state.');
    if (v.name === 'desktop' && m.wide) add('medium', `${m.wide} paragraph${m.wide === 1 ? '' : 's'} run wider than 900px on desktop (hard to read).`, 'Limit text to ~65-75 characters (max-width: 65ch) inside a centred container.');
  }
  return out;
}

async function render(ctx: ToolContext, target: string): Promise<{ r: RenderResult; images: ImageInput[] }> {
  return withSandbox(ctx, async (s) => {
    await s.writeFile(`${REVIEW_DIR}/review.py`, REVIEW_PY);
    const ex = await s.exec(`python3 ${REVIEW_DIR}/review.py`, { timeoutMs: 120_000, signal: ctx.signal, envs: { ORIN_REVIEW: JSON.stringify({ target, out: SHOT_DIR }) } });
    const line = ex.stdout.trim().split('\n').pop() ?? '';
    let r: RenderResult;
    try {
      r = JSON.parse(line) as RenderResult;
    } catch {
      r = { ok: false, error: `the browser check did not run: ${(ex.stderr || ex.stdout).trim().slice(-400)}` };
    }
    const images: ImageInput[] = [];
    for (const v of r.views ?? []) {
      if (!v.shot) continue;
      try {
        images.push({ mimeType: 'image/jpeg', data: Buffer.from(await s.readFile(v.shot)).toString('base64') });
      } catch {
        /* no screenshot for this size */
      }
    }
    return { r, images };
  });
}

async function critique(ctx: ToolContext, images: ImageInput[], focus: string | undefined): Promise<ReturnType<typeof parseReview> | null> {
  const llm = ctx.services.llm();
  if (!llm || !llm.provider.supportsVision || !images.length) return null;
  let raw = '';
  try {
    for await (const c of llm.provider.streamChat({
      model: llm.model,
      messages: [
        { role: 'system', content: REVIEW_RUBRIC },
        { role: 'user', content: `Review this page.${focus ? ` What it is for / what to look at: ${focus.slice(0, 500)}` : ''}`, images },
      ],
      maxOutputTokens: 8000,
      temperature: 0.2,
      signal: ctx.signal,
    })) {
      if (c.type === 'delta') raw += c.text;
    }
  } catch {
    return null;
  }
  const p = parseReview(raw);
  return p.score === null && !p.issues.length ? null : p;
}

export const reviewDesignTool = defineTool({
  name: 'review_design',
  description:
    'Look at a page or app screen you built before calling it done, like a designer would. It opens it in a browser at phone (390px) and desktop (1280px) sizes, takes screenshots, checks for sideways scrolling, default fonts, low contrast, tiny buttons, broken images, script errors and dated HTML, and scores the screenshots against your design skill (passes at 8/10). ' +
    'Give exactly one of: site (a site folder or name in your workspace, as for publish_site), path (a folder or .html file on your sandbox computer, e.g. a Vite dist folder or the web app you will package as an APK), or url (a public link, or http://localhost:PORT for a server running on your computer). ' +
    'Fix every high and medium issue, then review again (up to three rounds) before sharing the result. The screenshots are saved on your computer under screenshots/ if the user should see them (send with sandbox_save).',
  schema: z.object({
    site: z.string().max(200).optional().describe('Site folder or name in the workspace, e.g. sites/bakery'),
    path: z.string().max(300).optional().describe(`Folder or .html file on the sandbox computer (relative to ${SANDBOX_WORKDIR})`),
    url: z.string().max(500).optional().describe('Public https link, or http://localhost:PORT on the sandbox computer'),
    focus: z.string().max(500).optional().describe('What the page is for, or what to look at closely'),
  }),
  label: () => 'Checking how it looks…',
  timeoutMs: 240_000,
  handler: async (a, ctx) => {
    const given = [a.site, a.path, a.url].filter(Boolean).length;
    if (given !== 1) return { ok: false, content: 'Give exactly one of site, path or url.', summary: 'Bad arguments' };
    const haveSandbox = !!ctx.services.sandboxes && ctx.services.sandboxes.needs() === null;
    const issues: DesignIssue[] = [];
    let target = '';
    let staticSrc: { html: string; css: string } | null = null;
    const notes: string[] = [];

    if (a.site) {
      const plan = planSite(ctx.services, ctx.owner, workspaceDir(ctx.services, ctx.owner), a.site, a.site.includes('/') ? a.site : '');
      if (plan.errors.length && !plan.files.length) return { ok: false, content: `Nothing to review: ${plan.errors.join(' ')}`, summary: 'Site not found' };
      for (const e of plan.errors) issues.push({ severity: 'high', issue: e, fix: 'Fix this before publishing.' });
      const text = (p: string) => plan.files.find((f) => f.path === p)?.data.toString('utf8') ?? '';
      staticSrc = { html: text('index.html'), css: plan.files.filter((f) => f.path.endsWith('.css')).map((f) => f.data.toString('utf8')).join('\n') };
      if (haveSandbox) {
        target = `${REVIEW_DIR}/site-${plan.slug.replace(/[^a-z0-9-]/gi, '')}`;
        try {
          await withSandbox(ctx, async (s) => {
            await s.exec(`rm -rf '${target}' && mkdir -p '${target}'`, { signal: ctx.signal });
            for (const f of plan.files) await s.writeFile(`${target}/${f.path}`, new Uint8Array(f.data));
          });
        } catch (e) {
          notes.push(`Could not open it in the browser (${(e as Error).message}); only the code was checked.`);
          target = '';
        }
      }
    } else if (a.path) {
      if (!haveSandbox) return { ok: false, content: 'Your sandbox computer is not set up, so a sandbox path cannot be reviewed. Save the site to the workspace and review it with site instead.', summary: 'No computer' };
      target = sandboxPath(a.path);
    } else if (a.url) {
      const local = /^http:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(a.url);
      if (!/^https?:\/\//i.test(a.url)) return { ok: false, content: 'url must start with http:// or https://.', summary: 'Bad arguments' };
      if (haveSandbox) target = a.url.replace('0.0.0.0', '127.0.0.1');
      else if (local) return { ok: false, content: 'A localhost address needs your sandbox computer, which is not set up.', summary: 'No computer' };
      else {
        try {
          const r = await safeFetch(ctx.services.fetchImpl, a.url, { signal: ctx.signal, lookup: ctx.services.lookup });
          staticSrc = { html: r.body.toString('utf8'), css: '' };
          notes.push('Only the HTML was checked (no computer to render it), so the CSS checks are rough.');
        } catch (e) {
          return { ok: false, content: `Could not load ${a.url}: ${(e as Error).message}`, summary: 'Link not working' };
        }
      }
    }

    let images: ImageInput[] = [];
    let rendered: RenderResult | null = null;
    if (target) {
      try {
        const out = await render(ctx, target);
        rendered = out.r;
        images = out.images;
        if (!rendered.ok) {
          notes.push(`The browser check failed: ${rendered.error ?? 'unknown error'}`);
          rendered = null;
        }
      } catch (e) {
        if (ctx.signal.aborted) throw e;
        notes.push(`The browser check failed: ${(e as Error).message}`);
      }
    }
    if (rendered) {
      issues.push(...renderIssues(rendered));
      if (rendered.html) staticSrc = { html: rendered.html, css: `${rendered.css ?? ''}\n${staticSrc?.css ?? ''}` };
    }
    if (staticSrc) issues.push(...lintDesign(staticSrc.html, staticSrc.css));
    if (!rendered && !staticSrc) return { ok: false, content: `Could not review it. ${notes.join(' ')}`.trim(), summary: 'Review failed' };

    const vision = await critique(ctx, images, a.focus);
    if (vision) issues.push(...vision.issues);
    else if (images.length) notes.push('The visual score was skipped (the model could not look at the screenshots this time); the measured checks above still apply.');
    const list = sortIssues(issues);
    const highs = list.filter((i) => i.severity === 'high').length;
    const meds = list.filter((i) => i.severity === 'medium').length;
    const score = vision?.score ?? null;
    const pass = highs === 0 && meds <= 1 && (score === null || score >= PASS_SCORE);
    const shots = (rendered?.views ?? []).filter((v) => v.shot).map((v) => v.shot!.replace(`${SANDBOX_WORKDIR}/`, ''));
    const lines = [
      pass ? 'PASSED the design review.' : 'NOT READY: fix the issues below, then run review_design again.',
      score !== null ? `Visual score: ${score}/10${vision?.verdict ? ` - ${vision.verdict}` : ''}` : '',
      list.length ? `Issues (${highs} high, ${meds} medium, ${list.length - highs - meds} low), most important first:` : 'No issues found.',
      ...list.slice(0, 14).map((i, n) => `${n + 1}. [${i.severity}] ${i.issue}${i.fix ? ` Fix: ${i.fix}` : ''}`),
      shots.length ? `Screenshots on your computer: ${shots.join(', ')}` : '',
      ...notes,
    ].filter(Boolean);
    return {
      ok: true,
      content: lines.join('\n'),
      summary: pass ? `Looks good${score !== null ? ` (${score}/10)` : ''}` : `${highs + meds} thing${highs + meds === 1 ? '' : 's'} to fix`,
    };
  },
});
