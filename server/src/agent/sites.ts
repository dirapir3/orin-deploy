import { createHash, randomBytes } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix } from 'node:path';
import { Script } from 'node:vm';
import type { AgentServices } from './tools/types.js';
import { listFiles, safePath } from './workspace.js';

/**
 * Tiny static hosting for sites the agent builds: files from the user's workspace are checked,
 * copied to <dataDir>/sites/<slug>/ and served at /v1/sites/<slug>/ in a sandboxed origin (see
 * agentExtra). The same checked file set is used for the other hosts (Hugging Face Spaces).
 */
export const SITE_EXTS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'txt', 'md', 'xml', 'woff', 'woff2', 'ttf', 'mp3', 'wav', 'mp4', 'webm', 'csv', 'webmanifest']);
const TEXT_EXTS = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'svg', 'txt', 'md', 'xml', 'csv', 'webmanifest']);
export const MAX_SITE_BYTES = 10_000_000;
export const MAX_SITE_FILES = 300;
const OWNER_FILE = '.owner';

export function sitesRoot(svc: AgentServices): string {
  const d = svc.config.agent.dataDir;
  return d === ':memory:' ? join(tmpdir(), `orin-sites-test-${process.pid}`) : join(d, 'sites');
}

export function siteBaseUrl(svc: AgentServices): string {
  return (svc.config.agent.publicUrl || process.env.SITES_BASE_URL || 'https://fobeorin.alwaysdata.net').replace(/\/+$/, '');
}

function ownerTag(owner: string): string {
  return createHash('sha256').update(`site:${owner}`).digest('hex').slice(0, 6);
}

function slugBase(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40)
      .replace(/-+$/, '') || 'site'
  );
}

/**
 * What the model passed as a site name, cleaned up: models often pass back the address they got
 * last time ("portfolio-b69192" or the whole link), which used to create a second site at
 * "portfolio-b69192-b69192". Strip the owner's own suffix and any link around it.
 */
export function normalizeSiteName(name: string, owner: string): string {
  let n = name.trim();
  const m = /\/v1\/sites\/([a-z0-9-]+)/i.exec(n);
  if (m) n = m[1]!;
  const tag = ownerTag(owner);
  let base = slugBase(n);
  while (base.endsWith(`-${tag}`) && base.length > tag.length + 1) base = base.slice(0, -(tag.length + 1));
  return base;
}

/** "My Cool Site!" -> "my-cool-site-1a2b3c" (the suffix ties the address to its owner). */
export function siteSlug(name: string, owner: string): string {
  return `${normalizeSiteName(name, owner)}-${ownerTag(owner)}`;
}

export interface SiteFile {
  /** path inside the site (index.html, css/style.css) */
  path: string;
  /** path inside the workspace */
  src: string;
  data: Buffer;
}

export interface SitePlan {
  name: string;
  slug: string;
  /** workspace folder the site comes from ('' = top level) */
  folder: string;
  files: SiteFile[];
  bytes: number;
  /** problems that would make the site broken: nothing is published while there are any */
  errors: string[];
  /** things worth fixing that do not block publishing */
  warnings: string[];
  /** automatic fixes applied to the published copy (the workspace is not changed) */
  fixes: string[];
}

const extOf = (p: string) => p.split('.').pop()?.toLowerCase() ?? '';
const isHtml = (p: string) => ['html', 'htm'].includes(extOf(p));

/** Local references in HTML (src, href, poster, srcset) and CSS (url(), @import). */
export function localRefs(text: string, kind: 'html' | 'css' | 'js'): string[] {
  const out: string[] = [];
  const push = (raw: string | undefined) => {
    const v = (raw ?? '').trim();
    if (!v || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#|\{|\$)/i.test(v)) return; // http:, data:, mailto:, //cdn, #anchor, templates
    const clean = v.split(/[?#]/)[0]!;
    if (clean) out.push(clean);
  };
  if (kind === 'html') {
    // ignore anything inside <script> or <style> blocks and comments for attribute scanning
    const body = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, (s) => s.replace(/>[\s\S]*<\/script>$/i, '></script>'));
    const attr = /<(?:link|script|img|source|video|audio|iframe|a|embed|track|input)\b[^>]*?\s(?:src|href|poster|data-src)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
    let m: RegExpExecArray | null;
    while ((m = attr.exec(body))) push(m[1] ?? m[2] ?? m[3]);
    const srcset = /\ssrcset\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
    while ((m = srcset.exec(body))) for (const part of (m[1] ?? m[2] ?? '').split(',')) push(part.trim().split(/\s+/)[0]);
    for (const style of text.match(/<style\b[^>]*>[\s\S]*?<\/style>/gi) ?? []) out.push(...localRefs(style, 'css'));
  } else if (kind === 'css') {
    const re = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)"']*))\s*\)|@import\s+(?:"([^"]*)"|'([^']*)')/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) push(m[1] ?? m[2] ?? m[3] ?? m[4] ?? m[5]);
  }
  return out;
}

/** Root-relative links ("/style.css") would point at Orin's own home page, not the site: make them relative. */
export function rewriteRootRelative(text: string, kind: 'html' | 'css', depth: number): { text: string; count: number } {
  const up = depth > 0 ? '../'.repeat(depth) : './';
  let count = 0;
  const fix = (v: string) => {
    count++;
    return up + v.slice(1);
  };
  let out = text;
  if (kind === 'html') {
    out = out.replace(/(<(?:link|script|img|source|video|audio|iframe|a|embed|track|form)\b[^>]*?\s(?:src|href|poster|action)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi, (_s, pre: string, q: string, v: string) => `${pre}${q}${fix(v)}${q}`);
    out = out.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style>)/gi, (_s, a: string, css: string, b: string) => {
      const r = rewriteRootRelative(css, 'css', depth);
      count += r.count;
      return a + r.text + b;
    });
  } else {
    out = out.replace(/url\(\s*(["']?)(\/(?!\/)[^)"']*)\1\s*\)/gi, (_s, q: string, v: string) => `url(${q}${fix(v)}${q})`);
  }
  return { text: out, count };
}

/** Syntax check for classic browser scripts (modules and non-JS script types are skipped). */
export function scriptSyntaxError(code: string, filename: string): string | null {
  if (/^\s*(?:import\s[\s\S]*?from\s|import\s*['"{*]|export\s)/m.test(code)) return null; // ES module syntax: browsers check it
  try {
    new Script(code, { filename });
    return null;
  } catch (e) {
    const err = e as Error;
    const line = /:(\d+)\n/.exec(err.stack ?? '')?.[1];
    return `${filename}${line ? ` line ${line}` : ''}: ${err.message}`;
  }
}

function inlineScripts(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const attrs = m[1] ?? '';
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && !['text/javascript', 'application/javascript'].includes(type)) continue; // module, json, babel, templates
    if (m[2]!.trim()) out.push(m[2]!);
  }
  return out;
}

function pickFolder(wsRoot: string, all: Set<string>, name: string, folder: string): string {
  const given = folder.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\/index\.html?$/i, '');
  if (given) {
    safePath(wsRoot, given); // rejects paths outside the workspace
    return given;
  }
  const raw = name.trim().replace(/^\/+|\/+$/g, '');
  for (const cand of [raw, slugBase(raw), `sites/${raw}`, `sites/${slugBase(raw)}`]) if (cand && all.has(`${cand}/index.html`)) return cand;
  return '';
}

/**
 * Works out which files make up the site and checks them, without publishing anything:
 * a named folder publishes everything in it; the top level publishes index.html and only the
 * files it (transitively) uses, so private notes and data in the workspace are never published.
 */
export function planSite(svc: AgentServices, owner: string, wsRoot: string, name: string, folder = ''): SitePlan {
  const wsFiles = listFiles(wsRoot);
  const all = new Set(wsFiles.map((f) => f.path));
  const dir = pickFolder(wsRoot, all, name, folder);
  const prefix = dir ? `${dir}/` : '';
  const plan: SitePlan = { name: normalizeSiteName(name, owner), slug: siteSlug(name, owner), folder: dir, files: [], bytes: 0, errors: [], warnings: [], fixes: [] };
  if (!all.has(`${prefix}index.html`)) {
    const found = wsFiles.filter((f) => /(^|\/)index\.html$/.test(f.path)).map((f) => f.path);
    plan.errors.push(
      `There is no ${prefix}index.html in the workspace.${found.length ? ` Found: ${found.slice(0, 5).join(', ')}; pass the folder that holds it.` : ' Write the home page as index.html first (ideally in its own folder, e.g. sites/<name>/index.html).'}`,
    );
    return plan;
  }
  const inDir = wsFiles.filter((f) => f.path.startsWith(prefix) && !f.path.slice(prefix.length).split('/').some((s) => s.startsWith('.')));
  const allowed = inDir.filter((f) => SITE_EXTS.has(extOf(f.path)));
  let chosen: string[];
  if (dir) chosen = allowed.map((f) => f.path);
  else {
    // top level: follow references from index.html, plus any file whose path appears in the text of a used file (fetch('data.json'))
    const set = new Set<string>(['index.html']);
    const queue = ['index.html'];
    const texts = new Map<string, string>();
    while (queue.length) {
      const p = queue.shift()!;
      if (!TEXT_EXTS.has(extOf(p))) continue;
      const t = readFileSync(safePath(wsRoot, p), 'utf8');
      texts.set(p, t);
      const kind = isHtml(p) ? 'html' : extOf(p) === 'css' ? 'css' : null;
      const refs = kind ? localRefs(t, kind).map((r) => (r.startsWith('/') ? r.slice(1) : posix.normalize(posix.join(posix.dirname(p), decodeURI(r))))) : [];
      for (const f of allowed) if (!set.has(f.path) && (refs.includes(f.path) || (['js', 'mjs', 'html', 'htm'].includes(extOf(p)) && t.includes(f.path)))) {
        set.add(f.path);
        queue.push(f.path);
      }
    }
    chosen = [...set];
  }
  const skipped = inDir.filter((f) => !SITE_EXTS.has(extOf(f.path))).map((f) => f.path);
  if (dir && skipped.length) plan.warnings.push(`Not published (file type not allowed on a static site): ${skipped.slice(0, 8).join(', ')}`);
  if (chosen.length > MAX_SITE_FILES) plan.errors.push(`Too many files (${chosen.length}); the limit is ${MAX_SITE_FILES}.`);

  let rootFixes = 0;
  for (const src of chosen) {
    const rel = src.slice(prefix.length);
    let data = readFileSync(safePath(wsRoot, src));
    const depth = rel.split('/').length - 1;
    if (isHtml(rel) || extOf(rel) === 'css') {
      const r = rewriteRootRelative(data.toString('utf8'), isHtml(rel) ? 'html' : 'css', depth);
      if (r.count) {
        rootFixes += r.count;
        data = Buffer.from(r.text, 'utf8');
      }
    }
    plan.files.push({ path: rel, src, data });
  }
  plan.bytes = plan.files.reduce((n, f) => n + f.data.length, 0);
  if (plan.bytes > MAX_SITE_BYTES) plan.errors.push(`The site is ${(plan.bytes / 1e6).toFixed(1)} MB; the limit is ${MAX_SITE_BYTES / 1e6} MB.`);
  if (rootFixes) plan.fixes.push(`Made ${rootFixes} link${rootFixes === 1 ? '' : 's'} starting with "/" relative, so they point inside the site.`);

  // content checks
  const have = new Set(plan.files.map((f) => f.path));
  const missing: string[] = [];
  const missingPages: string[] = [];
  for (const f of plan.files) {
    const ext = extOf(f.path);
    if (isHtml(f.path)) {
      const html = f.data.toString('utf8');
      if (f.path === 'index.html' && !/<[a-z!][^>]*>/i.test(html)) plan.errors.push(html.trim() ? 'index.html has no HTML in it.' : 'index.html is empty.');
      for (const ref of localRefs(html, 'html')) {
        let target = posix.normalize(posix.join(posix.dirname(f.path), safeDecode(ref)));
        if (target.endsWith('/') || target === '.') target = posix.join(target, 'index.html');
        if (target.startsWith('..')) continue;
        if (have.has(target) || have.has(`${target}/index.html`)) continue;
        // a missing page link or favicon is a dead link; a missing stylesheet, script or image breaks the page
        if (/\.(?:html?|ico)$/i.test(target) || !/\.[a-z0-9]+$/i.test(target)) missingPages.push(`${f.path} -> ${ref}`);
        else missing.push(`${f.path} -> ${ref}`);
      }
      inlineScripts(html).forEach((code, i) => {
        const err = scriptSyntaxError(code, `${f.path} (inline script ${i + 1})`);
        if (err) plan.errors.push(`JavaScript syntax error in ${err}`);
      });
      if (/<\/html>\s*\S/i.test(html.replace(/<!--[\s\S]*?-->/g, ''))) plan.warnings.push(`${f.path} has content after </html>.`);
      if (!/<\/html>/i.test(html) && /<html/i.test(html)) plan.warnings.push(`${f.path} has no closing </html>; it may have been cut off.`);
    } else if (ext === 'css') {
      for (const ref of localRefs(f.data.toString('utf8'), 'css')) {
        const target = posix.normalize(posix.join(posix.dirname(f.path), safeDecode(ref)));
        if (!target.startsWith('..') && !have.has(target)) missing.push(`${f.path} -> ${ref}`);
      }
    } else if (ext === 'js') {
      const err = scriptSyntaxError(f.data.toString('utf8'), f.path);
      if (err) plan.errors.push(`JavaScript syntax error in ${err}`);
    } else if (ext === 'json' || ext === 'webmanifest') {
      try {
        JSON.parse(f.data.toString('utf8'));
      } catch (e) {
        plan.errors.push(`${f.path} is not valid JSON: ${(e as Error).message}`);
      }
    }
  }
  if (missingPages.length) plan.warnings.push(`Links to pages that do not exist (dead links): ${missingPages.slice(0, 8).join('; ')}`);
  if (missing.length) plan.errors.push(`Links to files that do not exist in the site: ${missing.slice(0, 10).join('; ')}${missing.length > 10 ? ` (+${missing.length - 10} more)` : ''}. Write those files or fix the links.`);
  return plan;
}

function safeDecode(s: string): string {
  try {
    return decodeURI(s);
  } catch {
    return s;
  }
}

export interface PublishResult {
  slug: string;
  url: string;
  files: number;
  bytes: number;
  updated: boolean;
  plan: SitePlan;
}

/** Copies a checked plan to the sites folder (atomic swap). Throws if the plan has errors. */
export function publishPlan(svc: AgentServices, owner: string, plan: SitePlan): PublishResult {
  if (plan.errors.length) throw new Error(plan.errors.join(' '));
  const root = sitesRoot(svc);
  const dir = join(root, plan.slug);
  const ownerHash = createHash('sha256').update(owner).digest('hex');
  const updated = existsSync(dir);
  if (updated) {
    const prev = existsSync(join(dir, OWNER_FILE)) ? readFileSync(join(dir, OWNER_FILE), 'utf8').trim() : '';
    if (prev !== ownerHash) throw new Error('That site address belongs to someone else. Pick another name.');
  }
  // build in a fresh folder, then swap, so visitors never see a half-copied site
  const staging = join(root, `.staging-${plan.slug}-${Date.now()}`);
  const old = join(root, `.old-${plan.slug}-${Date.now()}`);
  mkdirSync(staging, { recursive: true });
  try {
    for (const f of plan.files) {
      const dest = safePath(staging, f.path);
      mkdirSync(join(dest, '..'), { recursive: true });
      writeFileSync(dest, f.data);
    }
    writeFileSync(join(staging, OWNER_FILE), ownerHash);
    if (updated) cpSync(dir, old, { recursive: true });
    try {
      if (updated) rmSync(dir, { recursive: true, force: true });
      cpSync(staging, dir, { recursive: true });
    } catch (e) {
      // put the previous version back so a failed update never leaves the site down
      if (updated && existsSync(old)) {
        rmSync(dir, { recursive: true, force: true });
        cpSync(old, dir, { recursive: true });
      }
      throw e;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
  return { slug: plan.slug, url: `${siteBaseUrl(svc)}/v1/sites/${plan.slug}/`, files: plan.files.length, bytes: plan.bytes, updated, plan };
}

export function publishSite(svc: AgentServices, owner: string, wsRoot: string, name: string, folder = ''): PublishResult {
  return publishPlan(svc, owner, planSite(svc, owner, wsRoot, name, folder));
}

export function unpublishSite(svc: AgentServices, owner: string, name: string): boolean {
  const dir = join(sitesRoot(svc), siteSlug(name, owner));
  if (!existsSync(dir)) return false;
  const prev = existsSync(join(dir, OWNER_FILE)) ? readFileSync(join(dir, OWNER_FILE), 'utf8').trim() : '';
  if (prev !== createHash('sha256').update(owner).digest('hex')) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}

/** Text a page must contain once it is live: the tail of the file (the storage shim only touches the head). */
export function fingerprint(data: Buffer): string {
  const t = data.toString('utf8').trim();
  return t.slice(-80);
}

/**
 * Published pages run in a CSP sandbox (an opaque origin), where localStorage, sessionStorage
 * and document.cookie throw. This shim, injected into served HTML, swaps in working stand-ins
 * so typical web apps (to-do lists, games with high scores) work instead of crashing. When the
 * page runs inside the site frame (siteFrame), the frame keeps the data in Orin's own storage
 * under a key for this site only, and hands it back through the frame's name on the next visit.
 */
export const STORAGE_SHIM =
  '<script>/* orin-site-shim */(function(){var K="orinstore:";var all={};try{if(String(window.name).indexOf(K)===0)all=JSON.parse(window.name.slice(K.length))||{}}catch(e){}' +
  'function save(){try{window.name=K+JSON.stringify(all)}catch(e){}try{if(window.parent!==window)window.parent.postMessage({type:"orin-site-store",store:all},"*")}catch(e){}}' +
  'function mk(n){var d=all[n]||(all[n]={});var s={getItem:function(k){k=String(k);return Object.prototype.hasOwnProperty.call(d,k)?d[k]:null},setItem:function(k,v){d[String(k)]=String(v);save()},removeItem:function(k){delete d[String(k)];save()},clear:function(){for(var k in d)delete d[k];save()},key:function(i){var ks=Object.keys(d);return i<ks.length?ks[i]:null}};Object.defineProperty(s,"length",{get:function(){return Object.keys(d).length}});return s}' +
  '["localStorage","sessionStorage"].forEach(function(n){try{window[n].getItem("_")}catch(e){try{Object.defineProperty(window,n,{value:mk(n),configurable:true})}catch(_){}}});' +
  'try{document.cookie}catch(e){var c="";try{Object.defineProperty(document,"cookie",{get:function(){return c},set:function(v){var p=String(v).split(";")[0];c=c?c+"; "+p:p},configurable:true})}catch(_){}}' +
  'if(window.parent!==window)addEventListener("load",function(){try{window.parent.postMessage({type:"orin-site-title",title:document.title},"*")}catch(e){}});})();</script>';

export function injectShim(html: string): string {
  if (html.includes('orin-site-shim')) return html;
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + STORAGE_SHIM + html.slice(head.index + head[0].length);
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + STORAGE_SHIM + html.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + STORAGE_SHIM + html.slice(doctype[0].length);
  return STORAGE_SHIM + html;
}

/**
 * The page a browser gets when it opens a site link directly: a frame around the sandboxed site.
 * The frame is Orin's own code (no site content runs in it); it keeps the site's saved data in
 * localStorage under orin-site:<slug> so to-do lists and the like survive a reload, and gives it
 * back to the sandboxed page through the iframe's name. Messages are only taken from that iframe.
 */
export function siteFrame(slug: string): string {
  const key = JSON.stringify(`orin-site:${slug}`).replace(/</g, "\\u003c");
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">' +
    '<title>Site</title><style>html,body{margin:0;height:100%;background:#fff}iframe{border:0;width:100%;height:100%;display:block}</style></head><body><script>' +
    `(function(){var K=${key};function load(st){try{return JSON.parse(st.getItem(K)||"{}")||{}}catch(e){return {}}}` +
    'var f=document.createElement("iframe");' +
    'f.name="orinstore:"+JSON.stringify({localStorage:load(localStorage),sessionStorage:load(sessionStorage)});' +
    'f.setAttribute("sandbox","allow-scripts allow-forms allow-popups allow-modals allow-downloads");' +
    'f.setAttribute("allow","autoplay; fullscreen; clipboard-write; microphone; camera; geolocation");f.title="Site";' +
    'f.src=location.href;document.body.appendChild(f);' +
    'addEventListener("message",function(e){if(e.source!==f.contentWindow||!e.data||typeof e.data!=="object")return;var d=e.data;' +
    'if(d.type==="orin-site-store"&&d.store&&typeof d.store==="object"){["localStorage","sessionStorage"].forEach(function(n){var v=d.store[n];if(!v||typeof v!=="object")return;var s=JSON.stringify(v);if(s.length>2e6)return;try{(n==="localStorage"?localStorage:sessionStorage).setItem(K,s)}catch(_){}});}' +
    'else if(d.type==="orin-site-title"&&typeof d.title==="string"&&d.title.trim())document.title=d.title.slice(0,120);});})();' +
    '</script></body></html>'
  );
}

// ---- editing a site that is already live: list, reopen, preview, compare

const PREVIEW_PREFIX = '_p-';

export interface SiteInfo {
  slug: string;
  name: string;
  url: string;
  files: number;
  bytes: number;
  updatedAt: number;
}

function ownerHashOf(owner: string): string {
  return createHash('sha256').update(owner).digest('hex');
}

function ownsDir(dir: string, owner: string): boolean {
  const f = join(dir, OWNER_FILE);
  return existsSync(f) && readFileSync(f, 'utf8').trim() === ownerHashOf(owner);
}

/** Files of a published site folder (relative paths, the owner marker left out). */
function siteDirFiles(dir: string): { path: string; data: Buffer; mtime: number }[] {
  const out: { path: string; data: Buffer; mtime: number }[] = [];
  const walk = (d: string, rel: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const abs = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(abs, r);
      else if (e.isFile()) out.push({ path: r, data: readFileSync(abs), mtime: statSync(abs).mtimeMs });
    }
  };
  if (existsSync(dir)) walk(dir, '');
  return out;
}

/** The user's own live sites on Orin (previews left out), newest first. */
export function listSites(svc: AgentServices, owner: string): SiteInfo[] {
  const root = sitesRoot(svc);
  if (!existsSync(root)) return [];
  const tag = ownerTag(owner);
  const out: SiteInfo[] = [];
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name.startsWith('.') || e.name.startsWith(PREVIEW_PREFIX) || !e.name.endsWith(`-${tag}`)) continue;
    const dir = join(root, e.name);
    if (!ownsDir(dir, owner)) continue;
    const files = siteDirFiles(dir);
    out.push({
      slug: e.name,
      name: e.name.slice(0, -(tag.length + 1)),
      url: `${siteBaseUrl(svc)}/v1/sites/${e.name}/`,
      files: files.length,
      bytes: files.reduce((n, f) => n + f.data.length, 0),
      updatedAt: Math.max(0, ...files.map((f) => f.mtime)),
    });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

export interface SiteDiff {
  /** a live version exists */
  live: boolean;
  added: string[];
  changed: string[];
  removed: string[];
}

/** What publishing this plan would change on the live site. */
export function diffPlan(svc: AgentServices, plan: SitePlan): SiteDiff {
  const dir = join(sitesRoot(svc), plan.slug);
  const live = existsSync(dir);
  const old = new Map(siteDirFiles(dir).map((f) => [f.path, fingerprintHash(f.data)]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const f of plan.files) {
    const h = old.get(f.path);
    if (h === undefined) added.push(f.path);
    else if (h !== fingerprintHash(f.data)) changed.push(f.path);
    old.delete(f.path);
  }
  return { live, added, changed, removed: [...old.keys()] };
}

function fingerprintHash(b: Buffer): string {
  return createHash('sha256').update(b).digest('hex');
}

/** "2 changed (index.html, style.css), 1 new (app.js)" or "no changes". */
export function describeDiff(d: SiteDiff): string {
  if (!d.live) return 'new site';
  const part = (n: string[], label: string) => (n.length ? `${n.length} ${label} (${n.slice(0, 4).join(', ')}${n.length > 4 ? ', …' : ''})` : '');
  const s = [part(d.changed, 'changed'), part(d.added, 'new'), part(d.removed, 'removed')].filter(Boolean).join(', ');
  return s || 'no changes';
}

export interface PreviewResult {
  url: string;
  slug: string;
  diff: SiteDiff;
}

/**
 * Puts a checked plan at a private preview link (an unguessable address, replaced by the next
 * preview of the same site), so changes can be opened and tested before the live site changes.
 */
export function previewPlan(svc: AgentServices, owner: string, plan: SitePlan): PreviewResult {
  if (plan.errors.length) throw new Error(plan.errors.join(' '));
  const root = sitesRoot(svc);
  mkdirSync(root, { recursive: true });
  const pointer = join(root, `.preview-${plan.slug}`);
  if (existsSync(pointer)) {
    const prev = readFileSync(pointer, 'utf8').trim();
    if (prev.startsWith(PREVIEW_PREFIX)) rmSync(join(root, prev), { recursive: true, force: true });
  }
  const slug = `${PREVIEW_PREFIX}${randomBytes(9).toString('hex')}`;
  const dir = join(root, slug);
  mkdirSync(dir, { recursive: true });
  for (const f of plan.files) {
    const dest = safePath(dir, f.path);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, f.data);
  }
  writeFileSync(join(dir, OWNER_FILE), ownerHashOf(owner));
  writeFileSync(pointer, slug);
  return { url: `${siteBaseUrl(svc)}/v1/sites/${slug}/`, slug, diff: diffPlan(svc, plan) };
}

/** Removes the preview of a site (after it is published, or with the site). */
export function dropPreview(svc: AgentServices, slug: string): void {
  const root = sitesRoot(svc);
  const pointer = join(root, `.preview-${slug}`);
  if (!existsSync(pointer)) return;
  const prev = readFileSync(pointer, 'utf8').trim();
  if (prev.startsWith(PREVIEW_PREFIX)) rmSync(join(root, prev), { recursive: true, force: true });
  rmSync(pointer, { force: true });
}

export interface OpenResult {
  name: string;
  slug: string;
  folder: string;
  url: string;
  files: string[];
  /** files were copied from the live site into the workspace */
  restored: boolean;
  /** the workspace folder already differed from the live site and was left as it was */
  pendingEdits: SiteDiff | null;
}

/**
 * Reopens one of the user's live sites for editing: makes sure its files are in the workspace at
 * sites/<name>/ (copied from the live site when missing). Edits there never touch the live site
 * until it is published again. Unsaved workspace edits are only replaced with `overwrite`.
 */
export function openSite(svc: AgentServices, owner: string, wsRoot: string, name: string, overwrite = false): OpenResult {
  const slug = siteSlug(name, owner);
  const dir = join(sitesRoot(svc), slug);
  if (!existsSync(dir) || !ownsDir(dir, owner)) {
    const mine = listSites(svc, owner).map((s) => s.name);
    throw new Error(`No live site called "${normalizeSiteName(name, owner)}".${mine.length ? ` Your sites: ${mine.join(', ')}.` : ' You have no sites published on Orin yet.'}`);
  }
  const base = normalizeSiteName(name, owner);
  const all = new Set(listFiles(wsRoot).map((f) => f.path));
  let folder = pickFolder(wsRoot, all, base, '');
  if (!folder) folder = `sites/${base}`;
  const live = siteDirFiles(dir);
  const url = `${siteBaseUrl(svc)}/v1/sites/${slug}/`;
  const hasWs = all.has(`${folder}/index.html`);
  if (hasWs && !overwrite) {
    const d = diffPlan(svc, planSite(svc, owner, wsRoot, base, folder));
    const pending = d.added.length || d.changed.length || d.removed.length ? d : null;
    return { name: base, slug, folder, url, files: listFiles(wsRoot).filter((f) => f.path.startsWith(`${folder}/`)).map((f) => f.path), restored: false, pendingEdits: pending };
  }
  if (hasWs && overwrite) {
    for (const f of listFiles(wsRoot)) if (f.path.startsWith(`${folder}/`)) rmSync(safePath(wsRoot, f.path), { force: true });
  }
  for (const f of live) {
    const dest = safePath(wsRoot, `${folder}/${f.path}`);
    mkdirSync(join(dest, '..'), { recursive: true });
    writeFileSync(dest, f.data);
  }
  return { name: base, slug, folder, url, files: live.map((f) => `${folder}/${f.path}`), restored: true, pendingEdits: null };
}
