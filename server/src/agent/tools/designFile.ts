import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import type { ImageInput } from '../../ai/types.js';
import { likelyVision } from '../../ai/codeModel.js';
import { listPictures, readPicture } from '../designFiles.js';
import {
  bands,
  blocks,
  compareBlocks,
  crop,
  cssSize,
  decodeImage,
  diffImage,
  encodePng,
  fidelity,
  palette,
  resize,
  type Band,
  type Block,
  type CssSize,
  type Raster,
} from '../designImage.js';
import { planSite } from '../sites.js';
import { SANDBOX_WORKDIR, sandboxPath } from '../sandbox/types.js';
import { safePath, workspaceDir } from '../workspace.js';
import { defineTool, type ToolContext } from './types.js';
import { withSandbox } from './sandbox.js';

/**
 * Building from a design file the user sends (a mockup, a screenshot of another app, a Figma or
 * Sketch export), as-is. Two tools, used the way a careful front-end developer works:
 *   design_spec  - before writing code: measures the picture (screen size, exact colours, sections,
 *                  cards and buttons with their positions and sizes) and has the vision model write
 *                  down every text, font and component, checked against those measurements.
 *   match_design - after building: opens the build in a browser at the design's exact size,
 *                  overlays it on the design, measures how far off it is (colours, structure,
 *                  pixels, each block's position and size) and lists the fixes. Repeat until it matches.
 */

export const MATCH_PASS = 0.8;
const DIR = '/home/user/.orin/match';

const fmtBlock = (b: Block) => `${b.colour} box at x ${b.x}, y ${b.y}, ${b.w}x${b.h}${b.fill < 0.92 ? ' (rounded or partly covered)' : ''}`;

export function describeMeasurements(size: CssSize, pal: ReturnType<typeof palette>, bs: Band[], bl: Block[]): string {
  const lines: string[] = [];
  lines.push(`Screen: ${size.width} x ${size.height} CSS px (${size.kind}, drawn at ${size.dpr}x; found from ${size.how}). Build at width ${size.width}px; every number below is in CSS px.`);
  lines.push(`Colours by area (exact): ${pal.map((p) => `${p.hex} ${p.share}%`).join(', ')}`);
  const shown = bs.filter((b) => b.y1 - b.y0 >= 4).slice(0, 30);
  lines.push('Horizontal sections, top to bottom (background, and the left/right edges of what sits on it):');
  for (const b of shown) lines.push(`- y ${b.y0}-${b.y1} (${b.y1 - b.y0}px): ${b.bg}${b.content ? `, content x ${b.content.x0}-${b.content.x1}` : ', empty'}`);
  if (bl.length) {
    lines.push('Solid shapes (cards, buttons, bars, chips, avatars), top to bottom:');
    for (const b of bl) lines.push(`- ${fmtBlock(b)}`);
  }
  return lines.join('\n');
}

function llmFor(ctx: ToolContext) {
  const run = ctx.runLlm;
  const s = ctx.services.llm();
  const serverSees = s && s.provider.supportsVision ? { provider: s.provider, model: s.model } : null;
  // the turn's own model (the user's key) first, when it is one that reads pictures; a text-only
  // coding model (DeepSeek, Qwen-Coder...) would answer without seeing them, so use the server's then
  if (run && run.provider.supportsVision && (likelyVision(run.model) || !serverSees)) return run;
  return serverSees;
}

async function look(ctx: ToolContext, system: string, text: string, images: ImageInput[], maxOutputTokens = 6000): Promise<string | null> {
  const llm = llmFor(ctx);
  if (!llm) return null;
  let raw = '';
  try {
    for await (const c of llm.provider.streamChat({ model: llm.model, messages: [{ role: 'system', content: system }, { role: 'user', content: text, images }], maxOutputTokens, temperature: 0.1, signal: ctx.signal })) {
      if (c.type === 'delta') raw += c.text;
    }
  } catch {
    return null;
  }
  return raw.trim() || null;
}

const png = (r: Raster): ImageInput => ({ mimeType: 'image/png', data: encodePng(r).toString('base64') });

/** The design at a size a vision model reads well, plus close-up slices of a long screen so small text stays legible. */
function viewsOf(full: Raster, size: CssSize): ImageInput[] {
  const out: ImageInput[] = [];
  const maxW = size.kind === 'phone' ? 780 : 1440;
  const scale = Math.min(1, maxW / full.w);
  const whole = scale < 1 ? resize(full, full.w * scale, full.h * scale) : full;
  out.push(png(whole.h > 3000 ? resize(whole, (whole.w * 3000) / whole.h, 3000) : whole));
  // slices of ~1.2 screens high at 2 CSS px per px, so 11px text is ~22px tall
  const sliceCss = size.kind === 'phone' ? 520 : 700;
  const k = full.w / size.width;
  const n = Math.min(4, Math.ceil(size.height / sliceCss));
  if (n > 1 || size.kind !== 'phone') {
    for (let i = 0; i < n; i++) {
      const y = i * sliceCss * k;
      const part = crop(full, 0, y, full.w, Math.min(full.h - y, sliceCss * k));
      const target = Math.min(part.w, size.width * (size.kind === 'phone' ? 2 : 1.2));
      out.push(png(resize(part, target, (part.h * target) / part.w)));
    }
  }
  return out.slice(0, 5);
}

const SPEC_SYSTEM =
  'You are a senior front-end engineer who rebuilds designs pixel for pixel. You get a design file (first picture: the whole screen; then close-up slices top to bottom) and exact measurements taken from its pixels. ' +
  'Write the build spec another developer will code from without seeing the picture. Rules: copy every visible text exactly (case, punctuation, numbers, currency signs); give every size, gap and position in CSS px using the measurements (trust them over your eye for positions, sizes and colours); name the closest Google Font for each text style (weight, size, line height, letter spacing) and say how sure you are; describe icons precisely (shape, stroke or filled, size) so they can be drawn as inline SVG; note shadows, borders, corner radii, gradients, opacity and images (with what they show and their size). Never add, remove or "improve" anything. ' +
  'Format (plain text, no preamble):\nSCREEN: size, background, fonts to load\nTOKENS: colours (hex, role), radii, shadows, spacing scale\nLAYOUT: each section top to bottom with its box (x, y, w, h), padding, gap, alignment, and every element inside it with its text and style\nIMAGES & ICONS: each one with size and what to use\nWATCH OUT: details a quick rebuild would get wrong';

export const designSpecTool = defineTool({
  name: 'design_spec',
  description:
    'Before building from a design file the user sent (a mockup, an app screenshot, a Figma/Sketch/XD export as PNG or JPEG), call this to measure it. It works out the exact screen size in CSS px (and the 1x/2x/3x it was drawn at), the exact colours, every horizontal section and every solid card, button, bar and chip with its position and size, then writes a build spec: every text copied exactly, fonts, type sizes, spacing, radii, shadows, icons and layout. Code from the spec and the picture together, then check the build with match_design. ' +
    'path: the picture, as given in the [Picture N saved as ...] note on the user\'s message (designs/....png), or any picture in your workspace. One call per screen.',
  schema: z.object({
    path: z.string().max(400).describe('The design picture, e.g. designs/3fa2c1d4e5f6.png'),
    width: z.number().int().min(200).max(4000).optional().describe('The CSS width it was designed for, only if the user said (e.g. 390 or 1440); otherwise it is worked out'),
    notes: z.string().max(800).optional().describe('What the screen is and anything the user said about it'),
  }),
  label: () => 'Measuring the design…',
  timeoutMs: 180_000,
  handler: async (a, ctx) => {
    let pic;
    try {
      pic = readPicture(ctx.services, ctx.owner, a.path);
    } catch (e) {
      const have = listPictures(ctx.services, ctx.owner).slice(0, 6);
      return { ok: false, content: `${(e as Error).message}${have.length ? ` Pictures you have: ${have.join(', ')}.` : ''}`, summary: 'Picture not found' };
    }
    let full: Raster;
    try {
      full = decodeImage(pic.bytes);
    } catch (e) {
      return { ok: false, content: (e as Error).message, summary: 'Cannot read the picture' };
    }
    const size = cssSize(full.w, full.h, a.width);
    const css = resize(full, size.width, size.height);
    const pal = palette(css, 12);
    const bs = bands(css);
    const bl = blocks(css, bs[0]?.bg);
    const facts = describeMeasurements(size, pal, bs, bl);
    const spec = await look(ctx, SPEC_SYSTEM, `${a.notes ? `About this screen: ${a.notes}\n\n` : ''}Measurements from the pixels:\n${facts}`, viewsOf(full, size), 8000);
    const doc = `# Design spec: ${pic.path}\n\n## Measured from the pixels\n${facts}\n\n## Build spec\n${spec ?? '(the model could not look at the picture this time: build from the picture you see and the measurements)'}\n`;
    let saved = '';
    if (!pic.path.startsWith('/') && !ctx.incognito) {
      const rel = pic.path.replace(/\.[a-z]+$/i, '') + '.spec.md';
      try {
        const file = safePath(workspaceDir(ctx.services, ctx.owner), rel);
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, doc);
        saved = rel;
      } catch {
        /* the spec is still returned */
      }
    }
    return {
      ok: true,
      content:
        `${doc}\n` +
        `How to build it as-is: set the page/root to ${size.width}px wide on ${size.kind === 'phone' ? 'a phone (meta viewport width=device-width)' : 'desktop'}, load the named fonts, put every colour above into CSS variables, lay the sections out at the measured y positions and heights, and size each card/button to its measured box. ` +
        `Use real text, never images of text. Draw icons as inline SVG. ${size.kind === 'phone' ? 'A phone design stays this layout on a phone; for wider screens centre it (max-width) unless a desktop design was given too. ' : 'Keep the measured content width and centre it on wider screens. '}` +
        `Then run match_design with this path and your build, fix what it lists, and repeat until it says MATCHES.${saved ? ` (Spec saved as ${saved}.)` : ''}`,
      summary: `Measured a ${size.width}x${size.height} ${size.kind} design`,
    };
  },
});

// ---------------------------------------------------------------- match_design

export const MATCH_PY = String.raw`#!/usr/bin/env python3
import http.server, json, os, shutil, socketserver, subprocess, sys, threading
a = json.loads(os.environ['ORIN_MATCH'])
target, out, W, H, mobile = a['target'], a['out'], int(a['w']), int(a['h']), a['mobile']
os.makedirs(out, exist_ok=True)
url = target
if not target.startswith(('http://', 'https://', 'file://')):
    root, page = target, 'index.html'
    if os.path.isfile(root):
        root, page = os.path.dirname(root) or '.', os.path.basename(root)
    if not os.path.isfile(os.path.join(root, page)):
        print(json.dumps({'ok': False, 'error': 'No %s in %s' % (page, root)})); sys.exit(0)
    class Hd(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *x, **k): super().__init__(*x, directory=root, **k)
        def log_message(self, *x): pass
    srv = socketserver.ThreadingTCPServer(('127.0.0.1', 0), Hd); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = 'http://127.0.0.1:%d/%s' % (srv.server_address[1], page)
shot = os.path.join(out, 'build.png')
TEXTS = r"""
() => {
  const out = []; const seen = new Set();
  const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (tw.nextNode() && out.length < 80) {
    const el = tw.currentNode.parentElement; const t = tw.currentNode.textContent.trim();
    if (!el || !t || seen.has(el)) continue; seen.add(el);
    const r = el.getBoundingClientRect(); if (r.width < 1 || r.height < 1 || r.top > innerHeight * 3) continue;
    const cs = getComputedStyle(el);
    out.push({ t: t.slice(0, 60), x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height), font: cs.fontFamily.split(',')[0].replace(/["']/g, ''), size: parseFloat(cs.fontSize), weight: cs.fontWeight, color: cs.color });
  }
  const fonts = [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family.replace(/["']/g, ''));
  return { texts: out, fonts: [...new Set(fonts)], scrollW: document.documentElement.scrollWidth, scrollH: document.documentElement.scrollHeight };
}
"""
try:
    from playwright.sync_api import sync_playwright
except Exception:
    sync_playwright = None
if sync_playwright:
    res = {'ok': True, 'url': url, 'engine': 'playwright'}
    with sync_playwright() as p:
        b = p.chromium.launch(args=['--no-sandbox', '--disable-dev-shm-usage'])
        c = b.new_context(viewport={'width': W, 'height': min(H, 2000)}, is_mobile=mobile, has_touch=mobile, device_scale_factor=1)
        pg = c.new_page(); errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)[:200]))
        try:
            r = pg.goto(url, wait_until='load', timeout=30000)
            res['status'] = r.status if r else None
            try: pg.wait_for_load_state('networkidle', timeout=8000)
            except Exception: pass
            try: pg.evaluate('document.fonts.ready.then(() => 1)')
            except Exception: pass
            pg.wait_for_timeout(600)
            # a published Orin site runs inside a sandboxed iframe: read the frame with the most text
            best = None
            for fr in pg.frames:
                try:
                    d = fr.evaluate(TEXTS)
                except Exception:
                    continue
                if best is None or len(d.get('texts') or []) > len(best.get('texts') or []):
                    best = d
            res['dom'] = best or {'texts': [], 'fonts': [], 'scrollW': W, 'scrollH': H}
            full = max(H, int(res['dom'].get('scrollH') or H))
            pg.screenshot(path=shot, full_page=True, clip={'x': 0, 'y': 0, 'width': W, 'height': min(full, H)}, animations='disabled')
            res['shot'] = shot
        except Exception as e:
            res = {'ok': False, 'error': str(e)[:300]}
        res['errors'] = errs[:5]
        b.close()
    print(json.dumps(res)); sys.exit(0)
exe = next((shutil.which(x) for x in ['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable', 'headless_shell'] if shutil.which(x)), None)
if not exe:
    print(json.dumps({'ok': False, 'error': 'no browser on this computer (neither Playwright nor Chromium is installed)'})); sys.exit(0)
r = subprocess.run([exe, '--headless=new', '--no-sandbox', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=1', '--window-size=%d,%d' % (W, H), '--virtual-time-budget=6000', '--screenshot=' + shot, url], capture_output=True, text=True, timeout=90)
print(json.dumps({'ok': os.path.isfile(shot), 'url': url, 'engine': 'chromium', 'shot': shot if os.path.isfile(shot) else None, 'error': None if os.path.isfile(shot) else (r.stderr or r.stdout)[-300:]}))
`;

interface MatchRun {
  ok: boolean;
  error?: string | null;
  url?: string;
  engine?: string;
  status?: number | null;
  shot?: string | null;
  errors?: string[];
  dom?: { texts: { t: string; x: number; y: number; w: number; h: number; font: string; size: number; weight: string; color: string }[]; fonts: string[]; scrollW: number; scrollH: number };
}

const MATCH_SYSTEM =
  'You check a build against its design file, as a pixel-perfect front-end reviewer. Picture 1 is the design, picture 2 is the build at the same size, picture 3 is a heat map of where they differ (bright red = different). Measurements follow. ' +
  'List every visible difference that matters, most visible first: missing or wrong text, wrong font or weight, wrong sizes or spacing, wrong colours, missing or wrong icons and images, wrong radii or shadows, elements in the wrong place, and anything added that is not in the design. For each one give the exact CSS/markup fix with numbers (e.g. "card radius 28px not 12px", "title 22px/800 not 20px/700", "gap between quick actions 12px"). ' +
  'Then a line SCORE: N/10 for how faithful the build is (10 = a person could not tell them apart, 8 = same design with small offsets, 5 = clearly the same idea but visibly off, 2 = a different design). Be strict and concrete; never praise.';

export const matchDesignTool = defineTool({
  name: 'match_design',
  description:
    'Check a build against the design file it was built from, and get the exact fixes. It opens your build in a real browser on your computer at the design\'s exact screen size, lays the screenshot over the design and measures how close it is (colours, structure, pixels, and every card/button/bar\'s position and size against the design\'s), then looks at the two side by side and lists every visible difference with a CSS fix. Says MATCHES when the build is faithful (visual match 80% or more and score 8/10 or more), otherwise NOT YET. ' +
    'Fix everything it lists and run it again (up to four rounds) before you show the user; if it still does not match, tell them the score and what is still off. ' +
    'design: the picture path (designs/....png). Give exactly one of site (a site folder in your workspace), path (a folder or .html file on your computer, e.g. a Vite dist folder or the web build you will package as an app), or url (a public link, or http://localhost:PORT on your computer). For an Expo/React Native app, export it for web (npx expo export -p web) and check the dist folder.',
  schema: z.object({
    design: z.string().max(400).describe('The design picture, e.g. designs/3fa2c1d4e5f6.png'),
    site: z.string().max(200).optional(),
    path: z.string().max(300).optional().describe(`Folder or .html file on the sandbox computer (relative to ${SANDBOX_WORKDIR})`),
    url: z.string().max(500).optional(),
    width: z.number().int().min(200).max(4000).optional().describe('The CSS width the design was made for, only if known (otherwise the same as design_spec worked out)'),
  }),
  label: () => 'Comparing it with the design…',
  timeoutMs: 300_000,
  handler: async (a, ctx) => {
    const given = [a.site, a.path, a.url].filter(Boolean).length;
    if (given !== 1) return { ok: false, content: 'Give exactly one of site, path or url, plus design.', summary: 'Bad arguments' };
    let pic;
    try {
      pic = readPicture(ctx.services, ctx.owner, a.design);
    } catch (e) {
      return { ok: false, content: (e as Error).message, summary: 'Design not found' };
    }
    let full: Raster;
    try {
      full = decodeImage(pic.bytes);
    } catch (e) {
      return { ok: false, content: (e as Error).message, summary: 'Cannot read the design' };
    }
    const size = cssSize(full.w, full.h, a.width);
    const design = resize(full, size.width, size.height);
    if (!ctx.services.sandboxes || ctx.services.sandboxes.needs(ctx.owner) !== null) {
      return { ok: false, content: 'match_design needs your sandbox computer (it opens the build in a browser there), which is not set up. Add one in AI setup > Sandboxes.', summary: 'No computer' };
    }
    let target = '';
    if (a.site) {
      const plan = planSite(ctx.services, ctx.owner, workspaceDir(ctx.services, ctx.owner), a.site, a.site.includes('/') ? a.site : '');
      if (!plan.files.length) return { ok: false, content: `Nothing to check: ${plan.errors.join(' ') || 'the site folder is empty'}`, summary: 'Site not found' };
      target = `${DIR}/site-${plan.slug.replace(/[^a-z0-9-]/gi, '')}`;
      await withSandbox(ctx, async (s) => {
        await s.exec(`rm -rf '${target}' && mkdir -p '${target}'`, { signal: ctx.signal });
        for (const f of plan.files) await s.writeFile(`${target}/${f.path}`, new Uint8Array(f.data));
      });
    } else if (a.path) target = sandboxPath(a.path);
    else {
      if (!/^https?:\/\//i.test(a.url!)) return { ok: false, content: 'url must start with http:// or https://.', summary: 'Bad arguments' };
      target = a.url!.replace('0.0.0.0', '127.0.0.1');
    }

    let run: MatchRun;
    let shotBytes: Uint8Array | null = null;
    try {
      const out = await withSandbox(ctx, async (s) => {
        await s.writeFile(`${DIR}/match.py`, MATCH_PY);
        const ex = await s.exec(`python3 ${DIR}/match.py`, { timeoutMs: 150_000, signal: ctx.signal, envs: { ORIN_MATCH: JSON.stringify({ target, out: DIR, w: size.width, h: size.height, mobile: size.kind === 'phone' }) } });
        const line = ex.stdout.trim().split('\n').pop() ?? '';
        let r: MatchRun;
        try {
          r = JSON.parse(line) as MatchRun;
        } catch {
          r = { ok: false, error: `the browser did not run: ${(ex.stderr || ex.stdout).trim().slice(-400)}` };
        }
        const bytes = r.ok && r.shot ? await s.readFile(r.shot) : null;
        return { r, bytes };
      });
      run = out.r;
      shotBytes = out.bytes;
    } catch (e) {
      return { ok: false, content: `Could not open the build in a browser: ${(e as Error).message}`, summary: 'Browser failed' };
    }
    if (!run.ok || !shotBytes) {
      const noBrowser = /no browser/i.test(run.error ?? '');
      return {
        ok: false,
        content: `The build could not be checked: ${run.error ?? 'no screenshot'}.${noBrowser ? ' This computer has no browser: install one (pip install playwright && python -m playwright install --with-deps chromium, or on Termux: pkg install chromium), or switch the default sandbox to a cloud one in AI setup > Sandboxes.' : ''}`,
        summary: noBrowser ? 'No browser on the computer' : 'Build did not load',
      };
    }
    let shot = decodeImage(shotBytes);
    if (shot.w !== design.w || shot.h !== design.h) {
      // a page shorter than the design: pad with its own bottom colour is wrong, so pad with white (counts as a difference)
      const padded: Raster = { w: design.w, h: design.h, data: new Uint8Array(design.w * design.h * 4).fill(255) };
      const src = shot.w === design.w ? shot : resize(shot, design.w, (shot.h * design.w) / shot.w);
      const rows = Math.min(src.h, design.h);
      padded.data.set(src.data.subarray(0, rows * design.w * 4));
      shot = padded;
    }
    const fid = fidelity(design, shot);
    const dBands = bands(design);
    const dBlocks = blocks(design, dBands[0]?.bg);
    const sBlocks = blocks(shot, bands(shot)[0]?.bg, 80);
    const bd = compareBlocks(dBlocks, sBlocks, shot);
    const off = bd.filter((d) => !d.yours || Math.abs(d.dx) > 3 || Math.abs(d.dy) > 3 || Math.abs(d.dw) > 3 || Math.abs(d.dh) > 3);
    const blockLines = off.slice(0, 18).map((d) =>
      d.yours
        ? `- ${fmtBlock(d.design)}: yours is at x ${d.yours.x}, y ${d.yours.y}, ${d.yours.w}x${d.yours.h} (off by ${d.dx}px x, ${d.dy}px y, ${d.dw}px wide, ${d.dh}px tall)`
        : `- ${fmtBlock(d.design)}: not found in your build (that spot is ${d.thereColour})`,
    );
    const palD = palette(design, 8), palS = palette(shot, 8);
    const missingColours = palD.filter((p) => p.share >= 1 && !palS.some((q) => Math.hypot(q.rgb[0] - p.rgb[0], q.rgb[1] - p.rgb[1], q.rgb[2] - p.rgb[2]) < 18)).map((p) => `${p.hex} (${p.share}% of the design)`);
    const dom = run.dom;
    const wide = dom && dom.scrollW > size.width + 2 ? `The page is ${dom.scrollW - size.width}px wider than the screen (sideways scrolling).` : '';
    const measured = [
      `Visual match: ${Math.round(fid.visual * 100)}% (colours ${Math.round(fid.colour * 100)}%, structure ${Math.round(fid.structure * 100)}%, pixels ${Math.round(fid.pixels * 100)}%; 100% = identical, 0% = a blank page). Pass is ${MATCH_PASS * 100}%.`,
      `Blocks: ${bd.length - off.length} of ${bd.length} of the design's solid shapes are in place within 3px.${blockLines.length ? `\n${blockLines.join('\n')}` : ''}`,
      missingColours.length ? `Colours in the design that your build does not use: ${missingColours.join(', ')}.` : '',
      wide,
      run.errors?.length ? `Script errors: ${run.errors.join(' | ')}` : '',
      dom ? `Fonts that loaded: ${dom.fonts.join(', ') || 'none (only system fonts)'}.` : '',
      dom?.texts.length ? `Your text, as rendered (x, y, size/weight font, colour):\n${dom.texts.slice(0, 40).map((t) => `- "${t.t}" ${t.x},${t.y} ${t.size}px/${t.weight} ${t.font} ${t.color}`).join('\n')}` : '',
    ].filter(Boolean).join('\n');
    const diff = diffImage(design, shot);
    const view = (r: Raster) => png(size.kind === 'phone' ? r : resize(r, Math.min(r.w, 1200), (r.h * Math.min(r.w, 1200)) / r.w));
    const verdict = await look(ctx, MATCH_SYSTEM, `Design size ${size.width}x${size.height} CSS px.\n${measured}`, [view(design), view(shot), view(diff)], 5000);
    const score = verdict ? Number(/SCORE:\s*(\d+(?:\.\d+)?)/i.exec(verdict)?.[1] ?? NaN) : NaN;
    const pass = fid.visual >= MATCH_PASS && (Number.isNaN(score) ? off.length <= Math.max(1, bd.length * 0.15) : score >= 8);
    // keep the overlay pictures so the user can see them on request
    let files = '';
    if (!pic.path.startsWith('/') && !ctx.incognito) {
      try {
        const base = pic.path.replace(/\.[a-z]+$/i, '');
        const root = workspaceDir(ctx.services, ctx.owner);
        writeFileSync(safePath(root, `${base}-shot.png`), encodePng(shot));
        writeFileSync(safePath(root, `${base}-diff.png`), encodePng(diff));
        files = `Your screenshot and the difference map are saved as ${base}-shot.png and ${base}-diff.png in your workspace.`;
      } catch {
        /* optional */
      }
    }
    return {
      ok: true,
      content:
        `${pass ? 'MATCHES' : 'NOT YET'}: ${pass ? 'the build is faithful to the design.' : 'the build is still visibly different from the design. Fix the differences below, then run match_design again.'}\n` +
        `Checked ${run.url} at ${size.width}x${size.height} (${size.kind}) with ${run.engine}.\n\n${measured}\n\n` +
        (verdict ? `Side by side:\n${verdict}` : 'The side-by-side look was skipped (no model that can see pictures answered); go by the measurements.') +
        (files ? `\n\n${files}` : ''),
      summary: `${pass ? 'Matches' : 'Not yet'}: ${Math.round(fid.visual * 100)}% visual${Number.isNaN(score) ? '' : `, ${score}/10`}`,
    };
  },
});

export const designFileTools = [designSpecTool, matchDesignTool];
