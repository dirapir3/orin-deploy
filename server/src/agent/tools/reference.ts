import { z } from 'zod';
import type { ImageInput } from '../../ai/types.js';
import { planSite } from '../sites.js';
import { SANDBOX_WORKDIR, sandboxPath } from '../sandbox/types.js';
import { workspaceDir } from '../workspace.js';
import { defineTool, type ToolContext } from './types.js';
import { withSandbox } from './sandbox.js';
import { webSearch } from './web.js';

/**
 * Reference sites: "make it look like stripe.com". study_reference finds the site (a name goes
 * through web search), opens it in a real browser on Orin's computer at desktop and phone sizes,
 * screenshots it, measures its design (fonts, type scale, colours by area, accent, radius,
 * shadows, container width, section order) and has the vision model write a design brief mapped
 * onto the design kit. compare_to_reference renders what she built the same way and scores how
 * close it is, side by side, with concrete fixes, so she can iterate without the user directing
 * pixels.
 */

const REF_ROOT = `${SANDBOX_WORKDIR}/references`;
const TOOL_DIR = '/home/user/.orin/reference';

export const REF_PY = String.raw`#!/usr/bin/env python3
import http.server, json, os, socketserver, sys, threading
from playwright.sync_api import sync_playwright

MEASURE = r"""
() => {
  const vis = el => { const r = el.getBoundingClientRect(); const cs = getComputedStyle(el); return r.width > 2 && r.height > 2 && cs.visibility !== 'hidden' && cs.display !== 'none' && parseFloat(cs.opacity) > 0.1; };
  const pick = (el) => { if (!el) return null; const cs = getComputedStyle(el); return { text: (el.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 70), font: cs.fontFamily.split(',')[0].replace(/["']/g, '').trim(), size: parseFloat(cs.fontSize), weight: cs.fontWeight, lh: cs.lineHeight, ls: cs.letterSpacing, transform: cs.textTransform, color: cs.color }; };
  const first = sel => [...document.querySelectorAll(sel)].find(vis);
  const type = { body: pick(document.body), h1: pick(first('h1')), h2: pick(first('h2')), h3: pick(first('h3')), p: pick(first('main p, section p, p')), nav: pick(first('header a, nav a')) };
  const W = innerWidth, H = Math.max(document.documentElement.scrollHeight, 1);
  const bg = {}, fg = {}, radius = {}, shadow = {};
  const add = (m, k, w) => { if (!k) return; m[k] = (m[k] || 0) + w; };
  const els = [...document.querySelectorAll('body *')].slice(0, 4000);
  for (const el of els) {
    if (!vis(el)) continue;
    const cs = getComputedStyle(el), r = el.getBoundingClientRect();
    const area = Math.min(r.width, W) * Math.min(r.height, 1200);
    if (cs.backgroundColor && !/rgba\([^)]*,\s*0\)$/.test(cs.backgroundColor) && cs.backgroundColor !== 'transparent') add(bg, cs.backgroundColor, area);
    if ([...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) add(fg, cs.color, (n => n)(1));
    if (cs.borderTopLeftRadius !== '0px' && r.height > 20) add(radius, cs.borderTopLeftRadius, 1);
    if (cs.boxShadow && cs.boxShadow !== 'none') add(shadow, cs.boxShadow.slice(0, 90), 1);
  }
  const top = (m, n) => Object.entries(m).sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => ({ v: k, w: Math.round(v) }));
  // primary call to action: first filled button or link in the top 1.2 screens
  let cta = null;
  for (const el of document.querySelectorAll('a, button')) {
    if (!vis(el)) continue; const r = el.getBoundingClientRect(); if (r.top + scrollY > 1100 || r.height < 28 || r.height > 90) continue;
    const cs = getComputedStyle(el); if (/rgba\([^)]*,\s*0\)$/.test(cs.backgroundColor) || cs.backgroundColor === 'transparent') continue;
    cta = { text: (el.innerText || '').trim().slice(0, 40), bg: cs.backgroundColor, color: cs.color, radius: cs.borderTopLeftRadius, height: Math.round(r.height), padX: cs.paddingLeft, weight: cs.fontWeight, font: cs.fontFamily.split(',')[0].replace(/["']/g, '') }; break;
  }
  // container width: most common width of wide, centred blocks
  const widths = {};
  for (const el of els) { const r = el.getBoundingClientRect(); if (r.width > 500 && r.width < W - 20 && Math.abs((r.left + r.right) / 2 - W / 2) < 6 && r.height > 60) add(widths, Math.round(r.width), 1); }
  // section outline in page order
  // the page's spine: descend while one child holds most of the page, then its children are the sections
  let spine = document.body;
  for (let i = 0; i < 12; i++) {
    const kids = [...spine.children].filter(vis);
    const big = kids.filter(k => k.getBoundingClientRect().height > H * 0.6);
    if (big.length === 1 && kids.filter(k => k.getBoundingClientRect().height > 120).length <= 3) spine = big[0]; else break;
  }
  let blocks = [...spine.children].filter(vis).filter(el => el.getBoundingClientRect().height > 100);
  if (blocks.length < 3) blocks = [...document.querySelectorAll('section')].filter(vis).filter(el => el.getBoundingClientRect().height > 120);
  const sections = [];
  for (const el of blocks) {
    const r = el.getBoundingClientRect(); const h = el.querySelector('h1,h2,h3');
    const kids = [...el.querySelectorAll('*')].filter(c => vis(c) && c.getBoundingClientRect().height > 80 && c.getBoundingClientRect().width > 140 && c.getBoundingClientRect().width < r.width * 0.55);
    const rows = {}; kids.forEach(c => add(rows, Math.round(c.getBoundingClientRect().top / 8), 1)); const cols = Math.max(1, ...Object.values(rows).map(v => Math.min(v, 6)));
    sections.push({ tag: el.tagName.toLowerCase(), heading: h ? (h.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 80) : '', top: Math.round(r.top + scrollY), height: Math.round(r.height), cols, images: el.querySelectorAll('img, picture, video, svg image').length, bg: getComputedStyle(el).backgroundColor });
    if (sections.length >= 16) break;
  }
  const vars = {};
  try { for (const s of document.styleSheets) { let rules; try { rules = s.cssRules; } catch (e) { continue; } for (const r of rules) { if (r.selectorText === ':root' || r.selectorText === 'html') { for (const p of r.style) if (p.startsWith('--') && Object.keys(vars).length < 50 && /color|font|radius|space|bg|text|accent|brand|primary/i.test(p)) vars[p] = r.style.getPropertyValue(p).trim().slice(0, 60); } } } } catch (e) {}
  const fonts = [...new Set([...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/["']/g, '')))].slice(0, 8);
  const header = first('header') || first('nav');
  const hr = header ? header.getBoundingClientRect() : null;
  return { title: document.title, url: location.href, width: W, height: H, textLen: (document.body.innerText || '').length, type, fonts, background: top(bg, 6), text: top(fg, 5), radius: top(radius, 5), shadow: top(shadow, 3), cta, container: top(widths, 3), header: hr ? { height: Math.round(hr.height), sticky: ['sticky', 'fixed'].includes(getComputedStyle(header).position) } : null, sections, vars, images: document.images.length };
}
"""

a = json.loads(os.environ['ORIN_REF'])
target, out = a['target'], a['out']
os.makedirs(out, exist_ok=True)
url = target
if not target.startswith(('http://', 'https://')):
    root, page = target, 'index.html'
    if os.path.isfile(root):
        root, page = os.path.dirname(root) or '.', os.path.basename(root)
    class Q(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *x, **k):
            super().__init__(*x, directory=root, **k)
        def log_message(self, *x):
            pass
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Q)
    srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/%s' % (srv.server_address[1], page)

UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'
UA_M = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36'
res = {'ok': True, 'url': url, 'views': {}}
with sync_playwright() as p:
    b = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'])
    for name, w, h, mob in [('desktop', 1440, 900, False), ('phone', 390, 844, True)]:
        c = b.new_context(viewport={'width': w, 'height': h}, is_mobile=mob, has_touch=mob, device_scale_factor=1, user_agent=UA_M if mob else UA, locale='en-US')
        pg = c.new_page()
        v = {}
        try:
            r = pg.goto(url, wait_until='domcontentloaded', timeout=45000)
            v['status'] = r.status if r else None
            try:
                pg.wait_for_load_state('networkidle', timeout=8000)
            except Exception:
                pass
            for label in ['Accept all', 'Accept', 'I agree', 'Agree', 'Got it', 'Allow all', 'OK']:
                try:
                    btn = pg.get_by_role('button', name=label, exact=False).first
                    if btn.is_visible(timeout=300):
                        btn.click(timeout=1500); pg.wait_for_timeout(400); break
                except Exception:
                    pass
            # scroll through once so lazy content and fonts load, then back to the top
            for y in range(0, 6000, 700):
                pg.evaluate('y => scrollTo(0, y)', y); pg.wait_for_timeout(120)
            pg.evaluate('scrollTo(0, 0)'); pg.wait_for_timeout(900)
            v['m'] = pg.evaluate(MEASURE)
            full = min(int(v['m'].get('height') or h), 3600 if not mob else 3000)
            pg.screenshot(path=os.path.join(out, name + '-fold.jpg'), type='jpeg', quality=60)
            pg.screenshot(path=os.path.join(out, name + '-full.jpg'), type='jpeg', quality=50, full_page=True, clip={'x': 0, 'y': 0, 'width': w, 'height': max(h, full)})
        except Exception as e:
            v['error'] = str(e)[:300]
        res['views'][name] = v
        c.close()
    b.close()
json.dump(res, open(os.path.join(out, 'measure.json'), 'w'), indent=1)
print(json.dumps(res))
`;

interface TypeSample { text: string; font: string; size: number; weight: string; lh: string; ls: string; transform: string; color: string }
export interface Measure {
  title: string; url: string; width: number; height: number; textLen: number;
  type: Record<'body' | 'h1' | 'h2' | 'h3' | 'p' | 'nav', TypeSample | null>;
  fonts: string[];
  background: { v: string; w: number }[]; text: { v: string; w: number }[]; radius: { v: string; w: number }[]; shadow: { v: string; w: number }[];
  cta: { text: string; bg: string; color: string; radius: string; height: number; padX: string; weight: string; font: string } | null;
  container: { v: string; w: number }[];
  header: { height: number; sticky: boolean } | null;
  sections: { tag: string; heading: string; top: number; height: number; cols: number; images: number; bg: string }[];
  vars: Record<string, string>;
  images: number;
}
interface RefRun { ok: boolean; url: string; views: Record<'desktop' | 'phone', { status?: number | null; error?: string; m?: Measure }> }

const rgb = (c: string | undefined): [number, number, number] | null => {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)/.exec(c ?? '');
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
export const hex = (c: string | undefined): string => {
  const v = rgb(c);
  return v ? `#${v.map((n) => Math.round(n).toString(16).padStart(2, '0')).join('')}` : (c ?? '');
};
export const colorDistance = (a: string | undefined, b: string | undefined): number => {
  const x = rgb(a), y = rgb(b);
  if (!x || !y) return 999;
  return Math.round(Math.sqrt(x.reduce((s, v, i) => s + (v - (y[i] ?? 0)) ** 2, 0)));
};

/** A compact, readable summary of what the browser measured on a page. */
export function summarizeMeasure(m: Measure, label: string): string {
  const t = (s: TypeSample | null, n: string) => (s ? `${n}: ${s.font} ${Math.round(s.size)}px/${s.weight}${s.ls !== 'normal' ? ` tracking ${s.ls}` : ''}${s.transform !== 'none' ? ` ${s.transform}` : ''} ${hex(s.color)}` : '');
  const lines = [
    `${label}: "${m.title}" (${m.url}), page ${m.height}px tall at ${m.width}px.`,
    `Fonts loaded: ${m.fonts.join(', ') || 'system fonts only'}.`,
    `Type: ${[t(m.type.h1, 'h1'), t(m.type.h2, 'h2'), t(m.type.h3, 'h3'), t(m.type.p, 'body'), t(m.type.nav, 'nav')].filter(Boolean).join('; ')}.`,
    `Backgrounds by area: ${m.background.map((b) => hex(b.v)).join(', ') || 'none'}. Text colours: ${m.text.map((b) => hex(b.v)).join(', ')}.`,
    m.cta ? `Main button "${m.cta.text}": ${hex(m.cta.bg)} with ${hex(m.cta.color)} text, radius ${m.cta.radius}, ${m.cta.height}px tall, padding ${m.cta.padX}, weight ${m.cta.weight}.` : 'No filled main button found near the top.',
    `Corner radius used most: ${m.radius.map((r) => r.v).join(', ') || 'square'}. Shadows: ${m.shadow.length ? m.shadow.map((s) => s.v).join(' | ') : 'none'}.`,
    `Content width: ${m.container.map((c) => `${c.v}px`).join(', ') || 'full width'}. Header: ${m.header ? `${m.header.height}px${m.header.sticky ? ', sticky' : ''}` : 'none'}.`,
    `Sections in order: ${m.sections.map((s, i) => `${i + 1}) ${s.tag}${s.heading ? ` "${s.heading}"` : ''}${s.cols > 1 ? ` ${s.cols} columns` : ''}${s.images ? `, ${s.images} images` : ''}, ${hex(s.bg)}`).join('; ')}.`,
    Object.keys(m.vars).length ? `CSS variables: ${Object.entries(m.vars).slice(0, 20).map(([k, v]) => `${k}: ${v}`).join('; ')}.` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/** Measured differences between the reference and the build, as fixes. Pure, so it is tested without a browser. */
export function diffMeasures(ref: Measure, got: Measure): string[] {
  const out: string[] = [];
  const fontOf = (m: Measure, k: 'h1' | 'p') => (m.type[k]?.font ?? '').toLowerCase();
  for (const k of ['h1', 'p'] as const) {
    const a = ref.type[k], b = got.type[k];
    if (!a || !b) continue;
    const name = k === 'h1' ? 'Headline' : 'Body text';
    if (fontOf(ref, k) && fontOf(ref, k) !== fontOf(got, k)) out.push(`${name} font is ${b.font}; the reference uses ${a.font} (load it from Google Fonts if it is there, else the closest free match).`);
    const ratio = b.size / a.size;
    if (ratio < 0.85 || ratio > 1.18) out.push(`${name} is ${Math.round(b.size)}px; the reference is ${Math.round(a.size)}px at this width.`);
    if (Math.abs(Number(a.weight) - Number(b.weight)) >= 200) out.push(`${name} weight is ${b.weight}; the reference is ${a.weight}.`);
  }
  const bgA = ref.background[0]?.v, bgB = got.background[0]?.v;
  if (bgA && bgB && colorDistance(bgA, bgB) > 40) out.push(`Main background is ${hex(bgB)}; the reference is ${hex(bgA)}.`);
  if (ref.cta && got.cta) {
    if (colorDistance(ref.cta.bg, got.cta.bg) > 60) out.push(`Main button colour is ${hex(got.cta.bg)}; the reference is ${hex(ref.cta.bg)} (set --accent).`);
    const ra = parseFloat(ref.cta.radius), rb = parseFloat(got.cta.radius);
    if (Number.isFinite(ra) && Number.isFinite(rb) && Math.abs(ra - rb) > Math.max(4, ra * 0.4)) out.push(`Main button radius is ${got.cta.radius}; the reference is ${ref.cta.radius}.`);
    if (Math.abs(ref.cta.height - got.cta.height) > 10) out.push(`Main button is ${got.cta.height}px tall; the reference is ${ref.cta.height}px.`);
  } else if (ref.cta && !got.cta) out.push(`The reference has a filled main button ("${ref.cta.text}", ${hex(ref.cta.bg)}) near the top; the build has none.`);
  const ca = Number(ref.container[0]?.v), cb = Number(got.container[0]?.v);
  if (ca && cb && Math.abs(ca - cb) > 120) out.push(`Content width is ${cb}px; the reference is ${ca}px (set --container).`);
  if (ref.header && got.header && ref.header.sticky !== got.header.sticky) out.push(`The reference header is ${ref.header.sticky ? '' : 'not '}sticky; the build's is ${got.header.sticky ? '' : 'not '}sticky.`);
  const sa = ref.sections.length, sb = got.sections.length;
  if (sa >= 3 && Math.abs(sa - sb) >= 3) out.push(`The build has ${sb} sections; the reference has ${sa}. Follow its section order.`);
  return out;
}

const slugOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '').replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').slice(0, 50) || 'reference';
  } catch {
    return u.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'reference';
  }
};
const SKIP_HOSTS = /(wikipedia|youtube|facebook|instagram|twitter|x\.com|linkedin|reddit|pinterest|crunchbase|bloomberg|tiktok|medium\.com|quora|amazon\.|apps\.apple|play\.google)/i;

/** Turns "stripe.com", a full link, or a name like "the Linear website" into a URL. */
export async function resolveSite(ctx: ToolContext, site: string): Promise<{ url: string; via: string } | { error: string }> {
  const s = site.trim();
  if (/^https?:\/\//i.test(s)) return { url: s, via: 'link' };
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i.test(s)) return { url: `https://${s}`, via: 'address' };
  try {
    const { results } = await webSearch(ctx.services, `${s} official website`, ctx.signal, 8);
    const hit = results.find((r) => !SKIP_HOSTS.test(r.url));
    if (hit) return { url: hit.url, via: `web search ("${hit.title}")` };
    return { error: `A web search for "${s}" found no official site. Ask the user for the address.` };
  } catch (e) {
    return { error: `The web search for "${s}" failed: ${(e as Error).message}` };
  }
}

async function runRef(ctx: ToolContext, target: string, out: string): Promise<{ run: RefRun | null; error?: string; images: Record<string, ImageInput> }> {
  return withSandbox(ctx, async (s) => {
    await s.writeFile(`${TOOL_DIR}/ref.py`, REF_PY);
    const ex = await s.exec(`python3 ${TOOL_DIR}/ref.py`, { timeoutMs: 150_000, signal: ctx.signal, envs: { ORIN_REF: JSON.stringify({ target, out }) } });
    const line = ex.stdout.trim().split('\n').pop() ?? '';
    let run: RefRun | null = null;
    try {
      run = JSON.parse(line) as RefRun;
    } catch {
      return { run: null, error: (ex.stderr || ex.stdout).trim().slice(-400), images: {} };
    }
    const images: Record<string, ImageInput> = {};
    for (const n of ['desktop-fold', 'desktop-full', 'phone-full', 'phone-fold']) {
      try {
        images[n] = { mimeType: 'image/jpeg', data: Buffer.from(await s.readFile(`${out}/${n}.jpg`)).toString('base64') };
      } catch {
        /* that view failed */
      }
    }
    return { run, images };
  });
}

async function readImages(ctx: ToolContext, dir: string, names: string[]): Promise<Record<string, ImageInput>> {
  return withSandbox(ctx, async (s) => {
    const out: Record<string, ImageInput> = {};
    for (const n of names) {
      try {
        out[n] = { mimeType: 'image/jpeg', data: Buffer.from(await s.readFile(`${dir}/${n}.jpg`)).toString('base64') };
      } catch {
        /* missing */
      }
    }
    return out;
  });
}

async function askVision(ctx: ToolContext, system: string, user: string, images: ImageInput[]): Promise<string | null> {
  const llm = ctx.services.llm();
  if (!llm || !llm.provider.supportsVision || !images.length) return null;
  let raw = '';
  try {
    for await (const c of llm.provider.streamChat({ model: llm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: user, images }], maxOutputTokens: 6000, temperature: 0.2, signal: ctx.signal })) {
      if (c.type === 'delta') raw += c.text;
    }
  } catch {
    return null;
  }
  return raw.trim() || null;
}

export const BRIEF_PROMPT =
  'You are a senior designer briefing a developer who must rebuild the look of this website (screenshots: desktop top, desktop full page, phone full page) for a different client. Measured CSS facts follow; trust them over guesses for fonts, sizes and colours. ' +
  'Write a precise, compact design brief in plain text with these labelled parts: LOOK (3 sentences on the overall feel and what makes it recognisable); LAYOUT (each section in order: what it is, its layout, columns, alignment, imagery, background); TYPE (fonts, sizes, weights, tracking, case for headline, subhead, body, labels, nav); COLOUR (page background, surfaces, text, muted, accent and where it is used, gradients); COMPONENTS (buttons, nav, cards, badges, inputs: shape, radius, borders, shadows, hover feel); IMAGERY AND MOTIFS (photo style, illustrations, icons, patterns, motion); ' +
  'KIT (map it onto the developer\'s kit: style clean|editorial|bold, --accent hex, --bg hex, --text hex, heading font and body font as Google Fonts names (exact if free, else the closest free match, say which), --radius px, button shape pill|rounded|square, container width px, dark or light); MUST MATCH (the 6 details that make it read as this site). No preamble.';

export const COMPARE_PROMPT =
  'You compare a rebuilt page against the reference design it must match. Images: 1) reference desktop, 2) build desktop, 3) reference phone, 4) build phone (some may be missing). The build has different text and images on purpose; judge only the design: layout and section order, proportions and spacing, typography, colour, components (buttons, nav, cards), imagery treatment and overall feel. ' +
  'Reply with ONLY JSON: {"similarity": <1-10, 10 = a designer would say it is the same design system>, "verdict": "<one sentence>", "differences": [{"area": "<section or component>", "reference": "<what the reference does>", "build": "<what the build does>", "fix": "<specific CSS/HTML change>"}]} with at most 8 differences, the most visible first. Be strict: same colours but a different layout is 5 at most.';

export function parseCompare(raw: string): { similarity: number | null; verdict: string; differences: { area: string; reference: string; build: string; fix: string }[] } {
  const m = /\{[\s\S]*\}/.exec(raw);
  try {
    const j = JSON.parse(m ? m[0] : raw) as { similarity?: unknown; verdict?: unknown; differences?: unknown };
    const sim = Number(j.similarity);
    const diffs = Array.isArray(j.differences) ? (j.differences as Record<string, unknown>[]) : [];
    return {
      similarity: Number.isFinite(sim) ? Math.max(1, Math.min(10, Math.round(sim))) : null,
      verdict: typeof j.verdict === 'string' ? j.verdict.slice(0, 300) : '',
      differences: diffs.slice(0, 8).map((d) => ({ area: String(d.area ?? '').slice(0, 80), reference: String(d.reference ?? '').slice(0, 240), build: String(d.build ?? '').slice(0, 240), fix: String(d.fix ?? '').slice(0, 300) })),
    };
  } catch {
    return { similarity: null, verdict: '', differences: [] };
  }
}

export const REF_PASS = 8;

export const studyReferenceTool = defineTool({
  name: 'study_reference',
  description:
    'Study a website the user wants their site or app to look like ("make it like stripe.com", "same theme as the Linear website"). Give a name or an address: a name is found with web search. It opens the site in a real browser on your computer at desktop and phone sizes, takes screenshots, measures the real design (fonts, type sizes, colours by area, the main button, corner radius, shadows, content width, header, the sections in order, CSS variables) and writes a design brief mapped onto your design kit. ' +
    'Then build: design_kit with the style the brief names, set the kit tokens (:root --accent, --bg, --text, fonts, --radius, --container) to the reference values, follow its section order and components, and use the user\'s own content. Copy the design, not the brand: never their logo, photos, illustrations or wording (unless it is the user\'s own site). ' +
    'Finally run compare_to_reference with the same reference and fix the differences until it passes. Screenshots are saved on your computer under references/<name>/.',
  schema: z.object({
    site: z.string().min(2).max(300).describe('The site name or address, e.g. "stripe.com", "https://linear.app", "the Airbnb website"'),
    focus: z.string().max(400).optional().describe('What to take from it, if the user said (e.g. "the pricing section", "just the colours")'),
  }),
  label: (a) => `Studying ${a.site.slice(0, 40)}…`,
  timeoutMs: 300_000,
  handler: async (a, ctx) => {
    if (!ctx.services.sandboxes || ctx.services.sandboxes.needs() !== null) return { ok: false, content: 'Studying a site needs your computer (sandbox), which is not set up. Use fetch_page for its text instead.', summary: 'No computer' };
    const where = await resolveSite(ctx, a.site);
    if ('error' in where) return { ok: false, content: where.error, summary: 'Site not found' };
    const slug = slugOf(where.url);
    const dir = `${REF_ROOT}/${slug}`;
    const { run, error, images } = await runRef(ctx, where.url, dir);
    const d = run?.views.desktop, p = run?.views.phone;
    if (!run || !d?.m) return { ok: false, content: `Could not open ${where.url} in the browser: ${error ?? d?.error ?? 'unknown error'}. Try another page of the site or ask the user for a different reference.`, summary: 'Could not open it' };
    if ((d.status && d.status >= 400) || d.m.textLen < 80) return { ok: false, content: `${where.url} answered with ${d.status ?? 'an empty page'} (${d.m.textLen} characters of text); it may block automated browsers. Try another page of the site (a product or pricing page), or ask the user for screenshots.`, summary: 'Site blocked the browser' };
    const facts = [summarizeMeasure(d.m, 'Desktop'), p?.m ? `Phone: h1 ${Math.round(p.m.type.h1?.size ?? 0)}px, body ${Math.round(p.m.type.p?.size ?? 0)}px, ${p.m.sections.length} sections, header ${p.m.header ? `${p.m.header.height}px` : 'none'}.` : ''].filter(Boolean).join('\n');
    const imgs = ['desktop-fold', 'desktop-full', 'phone-full'].map((n) => images[n]).filter(Boolean) as ImageInput[];
    const brief = await askVision(ctx, BRIEF_PROMPT, `Site: ${where.url}${a.focus ? `\nTake mainly: ${a.focus}` : ''}\n\nMeasured:\n${facts}`, imgs);
    await withSandbox(ctx, (s) => s.writeFile(`${dir}/brief.md`, `# Design brief: ${where.url}\n\n${brief ?? '(no visual brief this time)'}\n\n## Measured\n${facts}\n`));
    return {
      content: [
        `Reference: ${where.url} (found by ${where.via}). Saved as reference "${slug}" with screenshots in references/${slug}/ on your computer.`,
        '',
        brief ? `Design brief:\n${brief}` : 'The visual brief was skipped (the model could not look at the screenshots); build from the measured facts below.',
        '',
        `Measured in the browser:\n${facts}`,
        '',
        `Next: design_kit (style from the brief), set the tokens to these values, build with the user's content in the reference's section order, then compare_to_reference reference="${slug}" and fix until it passes (similarity ${REF_PASS}/10). Do not copy their logo, photos or wording.`,
      ].join('\n'),
      summary: `Studied ${slug}`,
    };
  },
});

export const compareToReferenceTool = defineTool({
  name: 'compare_to_reference',
  description:
    'Check how close what you built is to a reference site you studied with study_reference. It renders your build at the same desktop and phone sizes, measures the same things, and compares them side by side with the reference screenshots: a similarity score out of 10 plus the measured and visible differences, each with a fix. Passes at 8. ' +
    'Fix the differences and compare again (up to three rounds) without asking the user about details, then run review_design. Give the reference name study_reference returned, and exactly one of site (workspace site), path (folder on your computer) or url.',
  schema: z.object({
    reference: z.string().min(1).max(120).describe('Reference name from study_reference, e.g. "stripe-com"'),
    site: z.string().max(200).optional(),
    path: z.string().max(300).optional(),
    url: z.string().max(500).optional(),
  }),
  label: () => 'Comparing it with the reference…',
  timeoutMs: 300_000,
  handler: async (a, ctx) => {
    if (!ctx.services.sandboxes || ctx.services.sandboxes.needs() !== null) return { ok: false, content: 'Comparing needs your computer (sandbox), which is not set up.', summary: 'No computer' };
    if ([a.site, a.path, a.url].filter(Boolean).length !== 1) return { ok: false, content: 'Give exactly one of site, path or url.', summary: 'Bad arguments' };
    const slug = slugOf(a.reference.includes('.') || a.reference.startsWith('http') ? (a.reference.startsWith('http') ? a.reference : `https://${a.reference}`) : a.reference);
    const refDir = `${REF_ROOT}/${slug}`;
    let refMeasure: RefRun | null = null;
    try {
      refMeasure = await withSandbox(ctx, async (s) => JSON.parse(Buffer.from(await s.readFile(`${refDir}/measure.json`)).toString('utf8')) as RefRun);
    } catch {
      return { ok: false, content: `No studied reference called "${slug}". Run study_reference first.`, summary: 'Reference not studied' };
    }
    let target = '';
    if (a.site) {
      const plan = planSite(ctx.services, ctx.owner, workspaceDir(ctx.services, ctx.owner), a.site, a.site.includes('/') ? a.site : '');
      if (!plan.files.length) return { ok: false, content: `Nothing to compare: ${plan.errors.join(' ')}`, summary: 'Site not found' };
      target = `${TOOL_DIR}/build-${plan.slug.replace(/[^a-z0-9-]/gi, '')}`;
      await withSandbox(ctx, async (s) => {
        await s.exec(`rm -rf '${target}' && mkdir -p '${target}'`, { signal: ctx.signal });
        for (const f of plan.files) await s.writeFile(`${target}/${f.path}`, new Uint8Array(f.data));
      });
    } else if (a.path) target = sandboxPath(a.path);
    else target = a.url!.replace('0.0.0.0', '127.0.0.1');
    const buildDir = `${refDir}/build`;
    const { run, error, images } = await runRef(ctx, target, buildDir);
    const got = run?.views.desktop?.m;
    if (!run || !got) return { ok: false, content: `Could not open the build in the browser: ${error ?? run?.views.desktop?.error ?? 'unknown error'}`, summary: 'Could not open it' };
    const ref = refMeasure.views.desktop?.m;
    const measured = ref ? diffMeasures(ref, got) : [];
    const refImgs = await readImages(ctx, refDir, ['desktop-full', 'phone-full']);
    const ordered = [refImgs['desktop-full'], images['desktop-full'], refImgs['phone-full'], images['phone-full']].filter(Boolean) as ImageInput[];
    const raw = await askVision(ctx, COMPARE_PROMPT, `Reference: ${refMeasure.url}. Compare the design only.`, ordered);
    const v = raw ? parseCompare(raw) : null;
    const sim = v?.similarity ?? null;
    const pass = sim !== null ? sim >= REF_PASS && measured.length <= 2 : measured.length === 0;
    const lines = [
      pass ? `MATCHES the reference${sim !== null ? ` (similarity ${sim}/10)` : ''}. Now run review_design, then share it.` : `NOT CLOSE ENOUGH yet${sim !== null ? `: similarity ${sim}/10 (needs ${REF_PASS})` : ''}. Fix these, then compare_to_reference again.`,
      v?.verdict ? `Verdict: ${v.verdict}` : '',
      measured.length ? `Measured differences:\n${measured.map((m, i) => `${i + 1}. ${m}`).join('\n')}` : 'Measured: fonts, sizes, colours, button and width are close.',
      v?.differences.length ? `Visible differences, most visible first:\n${v.differences.map((d, i) => `${i + 1}. ${d.area}: reference ${d.reference}; yours ${d.build}. Fix: ${d.fix}`).join('\n')}` : '',
      !v ? 'The side-by-side visual check was skipped this time (the model could not look at the screenshots); only measurements were compared.' : '',
      `Screenshots: references/${slug}/ (reference) and references/${slug}/build/ (yours).`,
    ].filter(Boolean);
    return { content: lines.join('\n'), summary: pass ? `Matches the reference (${sim ?? '-'}/10)` : `Similarity ${sim ?? '-'}/10` };
  },
});
