import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';

/**
 * Pixel measurements for building from a design file (a mockup, screenshot or export the user
 * sends). Everything here is deterministic: it decodes the picture, works out its size in CSS
 * pixels, its exact colours, its horizontal bands and its solid blocks (cards, buttons, bars), and
 * compares a screenshot of the build against it. The vision model reads the picture; these numbers
 * keep the build honest about sizes, positions and colours the eye gets wrong.
 */

export interface Raster {
  w: number;
  h: number;
  /** RGBA, row-major */
  data: Uint8Array;
}

export const MAX_DESIGN_PIXELS = 4096 * 8192;

export function sniff(buf: Uint8Array): 'png' | 'jpeg' | 'webp' | 'gif' | null {
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length > 12 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'webp';
  if (buf.length > 6 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return 'gif';
  return null;
}

export function decodeImage(buf: Uint8Array): Raster {
  const kind = sniff(buf);
  if (kind === 'png') {
    const p = PNG.sync.read(Buffer.from(buf));
    if (p.width * p.height > MAX_DESIGN_PIXELS) throw new Error('The picture is too big to measure.');
    return { w: p.width, h: p.height, data: new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.length) };
  }
  if (kind === 'jpeg') {
    const j = jpeg.decode(Buffer.from(buf), { useTArray: true, maxResolutionInMP: 40, maxMemoryUsageInMB: 512 });
    return { w: j.width, h: j.height, data: j.data };
  }
  throw new Error(kind ? `A ${kind.toUpperCase()} picture cannot be measured here; send it as PNG or JPEG.` : 'That file is not a PNG or JPEG picture.');
}

export function encodePng(r: Raster): Buffer {
  const p = new PNG({ width: r.w, height: r.h });
  p.data = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.length);
  return PNG.sync.write(p);
}

/** Box-filter resize (good for shrinking, fine for small growth). Alpha is flattened onto white. */
export function resize(src: Raster, w: number, h: number): Raster {
  w = Math.max(1, Math.round(w));
  h = Math.max(1, Math.round(h));
  const out = new Uint8Array(w * h * 4);
  const sx = src.w / w;
  const sy = src.h / h;
  for (let y = 0; y < h; y++) {
    const y0 = Math.floor(y * sy);
    const y1 = Math.max(y0 + 1, Math.min(src.h, Math.floor((y + 1) * sy)));
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x * sx);
      const x1 = Math.max(x0 + 1, Math.min(src.w, Math.floor((x + 1) * sx)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * src.w + xx) * 4;
          const a = src.data[i + 3]! / 255;
          r += src.data[i]! * a + 255 * (1 - a);
          g += src.data[i + 1]! * a + 255 * (1 - a);
          b += src.data[i + 2]! * a + 255 * (1 - a);
          n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n;
      out[o + 1] = g / n;
      out[o + 2] = b / n;
      out[o + 3] = 255;
    }
  }
  return { w, h, data: out };
}

export function crop(src: Raster, x: number, y: number, w: number, h: number): Raster {
  x = Math.max(0, Math.min(src.w - 1, Math.round(x)));
  y = Math.max(0, Math.min(src.h - 1, Math.round(y)));
  w = Math.max(1, Math.min(src.w - x, Math.round(w)));
  h = Math.max(1, Math.min(src.h - y, Math.round(h)));
  const out = new Uint8Array(w * h * 4);
  for (let yy = 0; yy < h; yy++) out.set(src.data.subarray(((y + yy) * src.w + x) * 4, ((y + yy) * src.w + x + w) * 4), yy * w * 4);
  return { w, h, data: out };
}

// ---------------------------------------------------------------- size in CSS pixels

const PHONE = [320, 360, 375, 384, 390, 393, 402, 411, 412, 414, 428, 430, 440];
const TABLET = [600, 744, 768, 800, 810, 820, 834, 1024];
const DESKTOP = [1024, 1152, 1280, 1366, 1400, 1440, 1512, 1536, 1600, 1680, 1728, 1920];
const DPRS = [1, 2, 3, 4, 1.5, 2.625, 2.75, 3.5];

export interface CssSize {
  width: number;
  height: number;
  dpr: number;
  kind: 'phone' | 'tablet' | 'desktop';
  /** how the size was found */
  how: string;
}

/** Works out the CSS width, height and device pixel ratio a design was drawn at. */
export function cssSize(w: number, h: number, cssWidth?: number): CssSize {
  const kindOf = (cw: number): CssSize['kind'] => (cw < 600 ? 'phone' : cw < 1024 ? 'tablet' : 'desktop');
  if (cssWidth && cssWidth >= 200 && cssWidth <= 4000) {
    const dpr = Math.round((w / cssWidth) * 1000) / 1000;
    return { width: cssWidth, height: Math.round(h / dpr), dpr, kind: kindOf(cssWidth), how: 'width you gave' };
  }
  let best: CssSize | null = null;
  let bestErr = Infinity;
  for (const dpr of DPRS) {
    const cw = w / dpr;
    for (const known of [...PHONE, ...TABLET, ...DESKTOP]) {
      const err = Math.abs(cw - known) / known + (dpr === 1 || dpr === 2 || dpr === 3 ? 0 : 0.004) + (PHONE.includes(known) && dpr === 1 && w > 500 ? 1 : 0);
      if (err < bestErr) {
        bestErr = err;
        best = { width: known, height: Math.round(h / (w / known)), dpr: Math.round((w / known) * 1000) / 1000, kind: kindOf(known), how: `a ${known}px-wide screen at ${dpr}x` };
      }
    }
  }
  if (best && bestErr <= 0.012) return best;
  // unknown width: a tall narrow picture is a phone at 2x or 3x, anything wider is a desktop at 1x
  if (h > w * 1.4 && w > 700) {
    const dpr = w > 1100 ? 3 : 2;
    return { width: Math.round(w / dpr), height: Math.round(h / dpr), dpr, kind: 'phone', how: `a guess (${dpr}x phone)` };
  }
  return { width: w, height: h, dpr: 1, kind: kindOf(w), how: 'a guess (1x)' };
}

// ---------------------------------------------------------------- colours

export const hex = (r: number, g: number, b: number): string => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
const dist = (a: number[], b: number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);

export interface Swatch {
  hex: string;
  rgb: [number, number, number];
  share: number;
}

/** The picture's main colours, exact (averaged within each colour, not blended across them). */
export function palette(r: Raster, max = 12): Swatch[] {
  const buckets = new Map<number, { n: number; r: number; g: number; b: number }>();
  const step = Math.max(1, Math.floor(Math.sqrt((r.w * r.h) / 250_000)));
  let total = 0;
  for (let y = 0; y < r.h; y += step) {
    for (let x = 0; x < r.w; x += step) {
      const i = (y * r.w + x) * 4;
      const R = r.data[i]!, G = r.data[i + 1]!, B = r.data[i + 2]!;
      const key = ((R >> 3) << 10) | ((G >> 3) << 5) | (B >> 3);
      const e = buckets.get(key) ?? { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += R; e.g += G; e.b += B;
      buckets.set(key, e);
      total++;
    }
  }
  const sorted = [...buckets.values()].sort((a, b) => b.n - a.n);
  const merged: { n: number; rgb: number[] }[] = [];
  for (const e of sorted) {
    const c = [e.r / e.n, e.g / e.n, e.b / e.n];
    const near = merged.find((m) => dist(m.rgb, c) < 14);
    if (near) near.n += e.n;
    else merged.push({ n: e.n, rgb: c });
  }
  return merged
    .filter((m) => m.n / total >= 0.002)
    .slice(0, max)
    .map((m) => ({ hex: hex(m.rgb[0]!, m.rgb[1]!, m.rgb[2]!), rgb: m.rgb.map(Math.round) as [number, number, number], share: Math.round((m.n / total) * 1000) / 10 }));
}

// ---------------------------------------------------------------- bands and blocks (in CSS pixels)

export interface Band {
  y0: number;
  y1: number;
  /** background colour of the band */
  bg: string;
  /** left/right edge of whatever sits on that background, or null when the band is empty */
  content: { x0: number; x1: number } | null;
}

/** Splits a screen (already at 1 CSS px per pixel) into horizontal bands by background colour. */
export function bands(r: Raster): Band[] {
  const rows: { bg: number[]; x0: number; x1: number }[] = [];
  for (let y = 0; y < r.h; y++) {
    // the row's background: the colour at its edges if they agree, else its most common colour
    const at = (x: number) => { const i = (y * r.w + x) * 4; return [r.data[i]!, r.data[i + 1]!, r.data[i + 2]!]; };
    const left = at(0), right = at(r.w - 1);
    const bg = dist(left, right) < 12 ? left : at(Math.floor(r.w / 2));
    let x0 = -1, x1 = -1;
    for (let x = 0; x < r.w; x++) {
      if (dist(at(x), bg) > 24) { if (x0 < 0) x0 = x; x1 = x; }
    }
    rows.push({ bg, x0, x1 });
  }
  const out: Band[] = [];
  let start = 0;
  for (let y = 1; y <= r.h; y++) {
    const a = rows[start]!, b = rows[y];
    const sameBg = b && dist(a.bg, b.bg) < 16;
    const sameEmpty = b && (a.x0 < 0) === (b.x0 < 0);
    if (!sameBg || !sameEmpty) {
      const seg = rows.slice(start, y);
      const filled = seg.filter((s) => s.x0 >= 0);
      const c = a.bg;
      out.push({
        y0: start,
        y1: y,
        bg: hex(c[0]!, c[1]!, c[2]!),
        content: filled.length ? { x0: Math.min(...filled.map((s) => s.x0)), x1: Math.max(...filled.map((s) => s.x1)) + 1 } : null,
      });
      start = y;
    }
  }
  // fold slivers (anti-aliasing, 1-2px lines) into their neighbour so the list stays readable
  const merged: Band[] = [];
  for (const b of out) {
    const last = merged[merged.length - 1];
    if (last && b.y1 - b.y0 <= 2 && last.bg === b.bg) {
      last.y1 = b.y1;
      if (b.content) last.content = last.content ? { x0: Math.min(last.content.x0, b.content.x0), x1: Math.max(last.content.x1, b.content.x1) } : b.content;
    } else if (last && last.bg === b.bg && !!last.content === !!b.content && b.y0 === last.y1) {
      last.y1 = b.y1;
      if (b.content && last.content) last.content = { x0: Math.min(last.content.x0, b.content.x0), x1: Math.max(last.content.x1, b.content.x1) };
    } else merged.push({ ...b });
  }
  return merged;
}

export interface Block {
  x: number;
  y: number;
  w: number;
  h: number;
  colour: string;
  rgb: [number, number, number];
  /** share of the box the colour fills (1 = a solid rectangle) */
  fill: number;
}

/**
 * Solid shapes in the screen: connected areas of one flat colour, at least ~16x16 CSS px, that are
 * not the page background. These are the cards, buttons, bars, chips and avatars of a UI.
 */
export function blocks(r: Raster, pageBg?: string, max = 40): Block[] {
  const W = r.w, H = r.h;
  const seen = new Uint8Array(W * H);
  const px = (i: number) => [r.data[i * 4]!, r.data[i * 4 + 1]!, r.data[i * 4 + 2]!];
  const bg = pageBg ? [parseInt(pageBg.slice(1, 3), 16), parseInt(pageBg.slice(3, 5), 16), parseInt(pageBg.slice(5, 7), 16)] : px(0);
  const out: Block[] = [];
  const stack: number[] = [];
  for (let start = 0; start < W * H; start++) {
    if (seen[start]) continue;
    const c = px(start);
    seen[start] = 1;
    if (dist(c, bg) < 10) continue;
    let n = 0, x0 = W, y0 = H, x1 = 0, y1 = 0, sr = 0, sg = 0, sb = 0;
    stack.length = 0;
    stack.push(start);
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % W, y = (i - x) / W;
      n++; sr += r.data[i * 4]!; sg += r.data[i * 4 + 1]!; sb += r.data[i * 4 + 2]!;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      const nb = [x > 0 ? i - 1 : -1, x < W - 1 ? i + 1 : -1, y > 0 ? i - W : -1, y < H - 1 ? i + W : -1];
      for (const j of nb) {
        if (j < 0 || seen[j]) continue;
        if (dist(px(j), c) <= 6) { seen[j] = 1; stack.push(j); }
      }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (w < 14 || h < 14 || n < 200) continue;
    if (w >= W - 1 && h >= H - 1) continue;
    const fill = n / (w * h);
    const area = w * h;
    // keep solid shapes; drop letters of big type (small, tall, half-filled)
    const solid = fill >= 0.75 || (area >= 6000 && fill >= 0.45) || (area >= 1200 && fill >= 0.6 && h <= w * 1.3);
    if (!solid) continue;
    out.push({ x: x0, y: y0, w, h, colour: hex(sr / n, sg / n, sb / n), rgb: [Math.round(sr / n), Math.round(sg / n), Math.round(sb / n)], fill: Math.round(fill * 100) / 100 });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x).slice(0, max);
}

// ---------------------------------------------------------------- comparing a build to the design

function gray(r: Raster): Float64Array {
  const g = new Float64Array(r.w * r.h);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * r.data[i * 4]! + 0.587 * r.data[i * 4 + 1]! + 0.114 * r.data[i * 4 + 2]!;
  return g;
}

/** Block SSIM (8x8 windows), 0..1. Both rasters must be the same size. */
export function ssim(a: Raster, b: Raster): number {
  const A = gray(a), B = gray(b);
  const k = 8, W = a.w, H = a.h;
  const c1 = (0.01 * 255) ** 2, c2 = (0.03 * 255) ** 2;
  let sum = 0, n = 0;
  for (let by = 0; by + k <= H; by += k) {
    for (let bx = 0; bx + k <= W; bx += k) {
      let ma = 0, mb = 0;
      for (let y = by; y < by + k; y++) for (let x = bx; x < bx + k; x++) { ma += A[y * W + x]!; mb += B[y * W + x]!; }
      ma /= k * k; mb /= k * k;
      let va = 0, vb = 0, cv = 0;
      for (let y = by; y < by + k; y++) for (let x = bx; x < bx + k; x++) {
        const da = A[y * W + x]! - ma, db = B[y * W + x]! - mb;
        va += da * da; vb += db * db; cv += da * db;
      }
      va /= k * k; vb /= k * k; cv /= k * k;
      sum += ((2 * ma * mb + c1) * (2 * cv + c2)) / ((ma * ma + mb * mb + c1) * (va + vb + c2));
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function pixelSimilarity(a: Raster, b: Raster): number {
  let d = 0;
  for (let i = 0; i < a.data.length; i += 4) d += Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!);
  return 1 - d / ((a.data.length / 4) * 3 * 255);
}

/** Share of a 12x20 grid of points where the two colours are within 30 of each other. */
export function colourProbes(a: Raster, b: Raster): number {
  let ok = 0, n = 0;
  for (let gy = 0; gy < 20; gy++) {
    for (let gx = 0; gx < 12; gx++) {
      const x = Math.round((gx / 11) * (a.w - 1)), y = Math.round((gy / 19) * (a.h - 1));
      const i = (y * a.w + x) * 4;
      if (dist([a.data[i]!, a.data[i + 1]!, a.data[i + 2]!], [b.data[i]!, b.data[i + 1]!, b.data[i + 2]!]) <= 30) ok++;
      n++;
    }
  }
  return ok / n;
}

export interface Fidelity {
  /** 0..1, each rescaled so a blank white page is 0 and an exact copy 1 */
  colour: number;
  structure: number;
  pixels: number;
  visual: number;
}

/** How close a screenshot is to the design, both at the same size. */
export function fidelity(design: Raster, shot: Raster): Fidelity {
  const white: Raster = { w: design.w, h: design.h, data: new Uint8Array(design.data.length).fill(255) };
  const half = (r: Raster) => resize(r, r.w / 2, r.h / 2);
  const q = (r: Raster) => resize(r, r.w / 4, r.h / 4);
  const dH = half(design), sH = half(shot), wH = half(white);
  const dQ = q(design), sQ = q(shot), wQ = q(white);
  const rel = (v: number, blank: number) => (blank >= 0.999 ? (v >= 0.999 ? 1 : 0) : Math.max(0, (v - blank) / (1 - blank)));
  const colour = rel(colourProbes(design, shot), colourProbes(design, white));
  const structure = rel(ssim(dH, sH), ssim(dH, wH));
  const pixels = rel(pixelSimilarity(dQ, sQ), pixelSimilarity(dQ, wQ));
  const r2 = (v: number) => Math.round(v * 1000) / 1000;
  return { colour: r2(colour), structure: r2(structure), pixels: r2(pixels), visual: r2((colour + structure + pixels) / 3) };
}

export interface BlockDiff {
  design: Block;
  yours: Block | null;
  /** colour found in the build at the centre of the design's block, when no match was found */
  thereColour?: string;
  dx: number;
  dy: number;
  dw: number;
  dh: number;
}

/** Matches each solid block of the design to the closest same-coloured block in the build. */
export function compareBlocks(dBlocks: Block[], sBlocks: Block[], shot: Raster): BlockDiff[] {
  const used = new Set<number>();
  const out: BlockDiff[] = [];
  for (const d of dBlocks) {
    let best = -1, bestCost = Infinity;
    sBlocks.forEach((s, i) => {
      if (used.has(i) || dist(s.rgb, d.rgb) > 28) return;
      const cost = Math.abs(s.x - d.x) + Math.abs(s.y - d.y) + Math.abs(s.w - d.w) + Math.abs(s.h - d.h);
      if (cost < bestCost) { bestCost = cost; best = i; }
    });
    if (best >= 0 && bestCost < Math.max(120, (d.w + d.h) * 1.2)) {
      used.add(best);
      const s = sBlocks[best]!;
      out.push({ design: d, yours: s, dx: s.x - d.x, dy: s.y - d.y, dw: s.w - d.w, dh: s.h - d.h });
    } else {
      const cx = Math.min(shot.w - 1, d.x + Math.floor(d.w / 2)), cy = Math.min(shot.h - 1, d.y + Math.floor(d.h / 2));
      const i = (cy * shot.w + cx) * 4;
      out.push({ design: d, yours: null, thereColour: hex(shot.data[i]!, shot.data[i + 1]!, shot.data[i + 2]!), dx: 0, dy: 0, dw: 0, dh: 0 });
    }
  }
  return out;
}

/** A heat map of where the build differs from the design (brighter = further off), at design size. */
export function diffImage(a: Raster, b: Raster): Raster {
  const out = new Uint8Array(a.data.length);
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.min(255, (Math.abs(a.data[i]! - b.data[i]!) + Math.abs(a.data[i + 1]! - b.data[i + 1]!) + Math.abs(a.data[i + 2]! - b.data[i + 2]!)) * 1.2);
    // faint copy of the design underneath so places can be told apart
    const base = (0.299 * a.data[i]! + 0.587 * a.data[i + 1]! + 0.114 * a.data[i + 2]!) * 0.25;
    out[i] = Math.min(255, base + d);
    out[i + 1] = base;
    out[i + 2] = base;
    out[i + 3] = 255;
  }
  return { w: a.w, h: a.h, data: out };
}
