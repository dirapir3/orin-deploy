import { createHash } from 'node:crypto';
import type { AgentServices } from './tools/types.js';
import type { SiteFile } from './sites.js';
import { decrypt, domainMatches, revealLogin } from './vault.js';

/**
 * Deploying a checked site to hosts other than Orin's own server, and confirming that a public
 * link really serves the site before anyone is told it is live.
 */

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), reject(signal.reason ?? new Error('aborted'))), { once: true });
  });

export interface VerifyResult {
  ok: boolean;
  status: number;
  detail: string;
  attempts: number;
}

/**
 * GETs the public URL until it answers 200 with the expected text (the tail of index.html), or
 * gives up. Assets are checked too (up to 12), so a page with a broken stylesheet is not "live".
 */
export async function verifyPublicUrl(
  svc: AgentServices,
  url: string,
  expect: string,
  o: { assets?: string[]; signal?: AbortSignal; tries?: number; delayMs?: number } = {},
): Promise<VerifyResult> {
  const tries = o.tries ?? 4;
  let last: VerifyResult = { ok: false, status: 0, detail: 'not checked', attempts: 0 };
  for (let i = 1; i <= tries; i++) {
    try {
      const res = await svc.fetchImpl(url, { redirect: 'follow', signal: o.signal ?? AbortSignal.timeout(15_000), headers: { 'cache-control': 'no-cache' } });
      const body = await res.text();
      if (res.status !== 200) last = { ok: false, status: res.status, detail: `the link answered HTTP ${res.status}`, attempts: i };
      else if (expect && !body.includes(expect)) last = { ok: false, status: 200, detail: 'the link answered, but not with the new page yet', attempts: i };
      else {
        const broken: string[] = [];
        for (const a of (o.assets ?? []).slice(0, 12)) {
          const r = await svc.fetchImpl(new URL(a, url).toString(), { signal: o.signal ?? AbortSignal.timeout(15_000) });
          await r.arrayBuffer().catch(() => undefined);
          if (r.status !== 200) broken.push(`${a} (HTTP ${r.status})`);
        }
        if (!broken.length) return { ok: true, status: 200, detail: 'page and files load', attempts: i };
        last = { ok: false, status: 200, detail: `the page loads but these files do not: ${broken.join(', ')}`, attempts: i };
      }
    } catch (e) {
      if (o.signal?.aborted) throw e;
      last = { ok: false, status: 0, detail: `the link did not respond (${(e as Error).message})`, attempts: i };
    }
    if (i < tries) await sleep((o.delayMs ?? 1500) * i, o.signal);
  }
  return last;
}

// ---- Hugging Face Spaces (static)

export const HF_TOKEN_HELP =
  'To publish on Hugging Face, Orin needs a Hugging Face access token with write permission (a token, not your password: Hugging Face does not let apps sign in with a password). ' +
  'Create one at https://huggingface.co/settings/tokens (New token, type "Write"), then in Orin open Profile > Secure Vault and add a login: name "Hugging Face", site huggingface.co, username = your Hugging Face username, password = the token (it starts with hf_). ' +
  'If you already saved your Hugging Face password there, you can paste the token into that login\'s Notes instead.';

const HF_TOKEN_RE = /\bhf_[A-Za-z0-9]{20,}\b/;

/** Finds a Hugging Face token in the user's Secure Vault (password or notes of a huggingface.co login). Server-side only. */
export function findHfToken(svc: AgentServices, accountOwner: string): string | null {
  for (const row of svc.store.listVault(accountOwner)) {
    if (!domainMatches(row.domain, 'huggingface.co') && !/hugging\s*face/i.test(row.name)) continue;
    const { password } = revealLogin(row);
    const pm = HF_TOKEN_RE.exec(password);
    if (pm) return pm[0];
    let notes = '';
    try {
      notes = row.notesEnc ? decrypt(row.notesEnc) : '';
    } catch {
      notes = '';
    }
    const nm = HF_TOKEN_RE.exec(notes);
    if (nm) return nm[0];
  }
  return null;
}

export function hfSpaceName(name: string): string {
  return (
    name
      .normalize('NFKD')
      .replace(/[^A-Za-z0-9._-]+/g, '-')
      .replace(/^[-._]+|[-._]+$/g, '')
      .replace(/--+/g, '-')
      .slice(0, 90) || 'site'
  );
}

/** https://user-my-site.static.hf.space/ for the Space user/my_site */
export function hfStaticUrl(namespace: string, space: string): string {
  return `https://${`${namespace}-${space}`.toLowerCase().replace(/[._]/g, '-')}.static.hf.space/`;
}

export class HostError extends Error {
  constructor(
    message: string,
    readonly needsUser = false,
  ) {
    super(message);
  }
}

async function hfJson(svc: AgentServices, token: string, url: string, init: RequestInit & { json?: unknown }, signal?: AbortSignal) {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) };
  let body = init.body;
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.json);
  }
  const res = await svc.fetchImpl(url, { method: init.method ?? 'GET', headers, body, signal: signal ?? AbortSignal.timeout(60_000) });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  return { status: res.status, data, text };
}

function hfError(what: string, r: { status: number; data: unknown; text: string }): HostError {
  const msg = (r.data && typeof r.data === 'object' && 'error' in r.data ? String((r.data as { error: unknown }).error) : r.text).slice(0, 300);
  if (r.status === 401) return new HostError(`Hugging Face rejected the saved token (${what}). It may be expired or mistyped. ${HF_TOKEN_HELP}`, true);
  if (r.status === 403) return new HostError(`Hugging Face refused (${what}): the saved token is probably read-only. Create a token with Write permission. ${msg}`, true);
  return new HostError(`Hugging Face ${what} failed (HTTP ${r.status}): ${msg}`);
}

const README_FRONT = (title: string) => `---\ntitle: ${title.replace(/[\n:]/g, ' ').slice(0, 60) || 'Site'}\ncolorFrom: red\ncolorTo: yellow\nsdk: static\napp_file: index.html\npinned: false\n---\n`;

export interface HfDeployResult {
  space: string;
  pageUrl: string;
  url: string;
  created: boolean;
  files: number;
}

/**
 * Creates (or updates) a public static Space under the token owner's account and commits the
 * files in one commit. Binary files go through the Hub's LFS upload, as the Hub requires.
 */
export async function deployToHuggingFace(svc: AgentServices, token: string, name: string, files: SiteFile[], signal?: AbortSignal): Promise<HfDeployResult> {
  const API = 'https://huggingface.co';
  const who = await hfJson(svc, token, `${API}/api/whoami-v2`, {}, signal);
  if (who.status !== 200) throw hfError('checking the account', who);
  const ns = String((who.data as { name?: string })?.name ?? '');
  if (!ns) throw new HostError('Hugging Face did not say which account the token belongs to.');
  const space = hfSpaceName(name);
  const repo = `${ns}/${space}`;

  const create = await hfJson(svc, token, `${API}/api/repos/create`, { method: 'POST', json: { type: 'space', name: space, sdk: 'static', private: false } }, signal);
  let created = true;
  if (create.status === 409) {
    created = false;
    const info = await hfJson(svc, token, `${API}/api/spaces/${repo}`, {}, signal);
    if (info.status !== 200) throw hfError('opening the existing Space', info);
    const sdk = (info.data as { sdk?: string; cardData?: { sdk?: string } })?.sdk ?? (info.data as { cardData?: { sdk?: string } })?.cardData?.sdk;
    if (sdk && sdk !== 'static') throw new HostError(`The Space ${repo} already exists and runs ${sdk}, not a static site. Pick another site name.`);
  } else if (create.status !== 200 && create.status !== 201) throw hfError('creating the Space', create);

  // README with the Space settings (sdk: static); keep the site's own README text if it has one
  const out = files.filter((f) => f.path.toLowerCase() !== 'readme.md');
  const ownReadme = files.find((f) => f.path.toLowerCase() === 'readme.md')?.data.toString('utf8') ?? '';
  const readme = /^---\n[\s\S]*?sdk:\s*static[\s\S]*?\n---/.test(ownReadme) ? ownReadme : README_FRONT(name) + (ownReadme ? `\n${ownReadme.replace(/^---\n[\s\S]*?\n---\n?/, '')}` : `\n${name}, built and published by Orin.\n`);
  out.push({ path: 'README.md', src: 'README.md', data: Buffer.from(readme, 'utf8') });

  // which files must go through LFS
  const pre = await hfJson(
    svc,
    token,
    `${API}/api/spaces/${repo}/preupload/main`,
    { method: 'POST', json: { files: out.map((f) => ({ path: f.path, size: f.data.length, sample: f.data.subarray(0, 512).toString('base64') })) } },
    signal,
  );
  if (pre.status !== 200) throw hfError('preparing the upload', pre);
  const modes = new Map(((pre.data as { files?: { path: string; uploadMode: string; shouldIgnore?: boolean }[] })?.files ?? []).map((f) => [f.path, f]));
  const lfs = out.filter((f) => modes.get(f.path)?.uploadMode === 'lfs');
  const lfsInfo = new Map(lfs.map((f) => [f.path, { oid: createHash('sha256').update(f.data).digest('hex'), size: f.data.length }]));

  if (lfs.length) {
    const batch = await hfJson(
      svc,
      token,
      `${API}/spaces/${repo}.git/info/lfs/objects/batch`,
      {
        method: 'POST',
        headers: { Accept: 'application/vnd.git-lfs+json', 'Content-Type': 'application/vnd.git-lfs+json' },
        body: JSON.stringify({ operation: 'upload', transfers: ['basic'], hash_algo: 'sha256', ref: { name: 'main' }, objects: [...lfsInfo.values()] }),
      },
      signal,
    );
    if (batch.status !== 200) throw hfError('starting the image/binary upload', batch);
    type Action = { href: string; header?: Record<string, string> };
    const objects = (batch.data as { objects?: { oid: string; error?: { message?: string }; actions?: { upload?: Action; verify?: Action } }[] })?.objects ?? [];
    for (const obj of objects) {
      if (obj.error) throw new HostError(`Hugging Face refused a file upload: ${obj.error.message ?? 'unknown error'}`);
      const up = obj.actions?.upload;
      if (!up) continue; // already stored on the Hub
      if (up.header && 'chunk_size' in up.header) throw new HostError('A file is too large for a single upload. Keep each image under 5 MB.');
      const f = lfs.find((x) => lfsInfo.get(x.path)!.oid === obj.oid)!;
      const put = await svc.fetchImpl(up.href, { method: 'PUT', headers: { ...(up.header ?? {}) }, body: new Uint8Array(f.data), signal: signal ?? AbortSignal.timeout(120_000) });
      if (put.status >= 300) throw new HostError(`Uploading ${f.path} to Hugging Face failed (HTTP ${put.status}).`);
      const ver = obj.actions?.verify;
      if (ver) {
        const v = await svc.fetchImpl(ver.href, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/vnd.git-lfs+json', Accept: 'application/vnd.git-lfs+json', ...(ver.header ?? {}) },
          body: JSON.stringify({ oid: obj.oid, size: f.data.length }),
          signal: signal ?? AbortSignal.timeout(60_000),
        });
        if (v.status >= 300) throw new HostError(`Hugging Face could not confirm the upload of ${f.path} (HTTP ${v.status}).`);
      }
    }
  }

  const lines = [JSON.stringify({ key: 'header', value: { summary: created ? `Publish ${space} from Orin` : `Update ${space} from Orin`, description: '' } })];
  for (const f of out) {
    if (modes.get(f.path)?.shouldIgnore) continue;
    const info = lfsInfo.get(f.path);
    lines.push(
      info
        ? JSON.stringify({ key: 'lfsFile', value: { path: f.path, algo: 'sha256', oid: info.oid, size: info.size } })
        : JSON.stringify({ key: 'file', value: { path: f.path, content: f.data.toString('base64'), encoding: 'base64' } }),
    );
  }
  const commit = await hfJson(svc, token, `${API}/api/spaces/${repo}/commit/main`, { method: 'POST', headers: { 'Content-Type': 'application/x-ndjson' }, body: `${lines.join('\n')}\n` }, signal);
  if (commit.status !== 200 && commit.status !== 201) throw hfError('uploading the files', commit);
  return { space: repo, pageUrl: `${API}/spaces/${repo}`, url: hfStaticUrl(ns, space), created, files: out.length };
}
