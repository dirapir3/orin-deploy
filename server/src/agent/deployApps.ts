import { createHash } from 'node:crypto';
import { z } from 'zod';
import { defineTool, type AgentServices, type ToolContext, type ToolDef } from './tools/types.js';
import { sandboxPath, shq } from './sandbox/index.js';
import { log, sandboxNeeds, withSandbox } from './tools/sandbox.js';
import { holdSecret } from './sandbox/secrets.js';

/**
 * Hosting apps the user connects with their own token (Netlify, Vercel, Render): Orin deploys a project
 * from her computer (cloud or the user's local sandbox) to the user's own account and gets back a real,
 * public link. Tokens are checked before they are saved, stored encrypted, never shown to the model, and
 * never put on the sandbox: files come from the computer to this server and go to the host from here.
 * Every deploy, new site or service, and env var change waits for the user's approval first.
 */

export type DeployAppId = 'netlify' | 'vercel' | 'render';

const UA = 'Orin-Agent';
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((res, rej) => {
    const t = setTimeout(res, ms);
    signal?.addEventListener('abort', () => (clearTimeout(t), rej(new Error('Stopped.'))), { once: true });
  });

function tok(ctx: { owner: string; services: AgentServices }, id: DeployAppId, name: string): string {
  const c = ctx.services.store.getConnection(ctx.owner, id);
  if (!c?.accessToken) throw new Error(`${name} is not connected. Connect it on the Apps page.`);
  holdSecret(ctx.owner, `${name} token`, c.accessToken);
  return c.accessToken;
}
const connected = (svc: AgentServices, owner: string, id: DeployAppId) => Boolean(svc.store.getConnection(owner, id));
const needsApp = (id: DeployAppId, name: string) => ({ owner, services }: { owner: string; services: AgentServices }) =>
  connected(services, owner, id) ? null : `the user to connect ${name} on the Apps page (tap ${name}, paste a token)`;
const needsAppAndSandbox = (id: DeployAppId, name: string) => (p: { owner: string; services: AgentServices }) => needsApp(id, name)(p) ?? sandboxNeeds(p.services, p.owner);

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text.slice(0, 200) };
  }
}

async function call<T>(svc: AgentServices, host: string, name: string, token: string, path: string, signal: AbortSignal, init: { method?: string; body?: unknown; raw?: Uint8Array; headers?: Record<string, string> } = {}): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', 'User-Agent': UA, ...(init.headers ?? {}) };
  if (init.body !== undefined) headers['Content-Type'] = 'application/json';
  if (init.raw) headers['Content-Type'] = 'application/octet-stream';
  const res = await svc.fetchImpl(`${host}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.raw ? (init.raw as unknown as BodyInit) : init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal,
  });
  const json = await readJson(res as unknown as Response);
  if (!res.ok) {
    const j = json as { message?: string; error?: { message?: string; code?: string } | string };
    const msg = typeof j.error === 'string' ? j.error : j.error?.message || j.message || '';
    if (res.status === 401 || res.status === 403) throw new Error(`${name} refused the token (HTTP ${res.status})${msg ? `: ${clip(msg, 160)}` : ''}. It may have expired or lack access; connect ${name} again on the Apps page.`);
    throw new Error(`${name} API error HTTP ${res.status}${msg ? `: ${clip(msg, 240)}` : ''}`);
  }
  return json as T;
}

const NETLIFY = 'https://api.netlify.com/api/v1';
const VERCEL = 'https://api.vercel.com';
const RENDER = 'https://api.render.com/v1';
const netlify = <T>(svc: AgentServices, t: string, p: string, s: AbortSignal, i?: Parameters<typeof call>[6]) => call<T>(svc, NETLIFY, 'Netlify', t, p, s, i);
const vercel = <T>(svc: AgentServices, t: string, p: string, s: AbortSignal, i?: Parameters<typeof call>[6]) => call<T>(svc, VERCEL, 'Vercel', t, p, s, i);
const render = <T>(svc: AgentServices, t: string, p: string, s: AbortSignal, i?: Parameters<typeof call>[6]) => call<T>(svc, RENDER, 'Render', t, p, s, i);

// ------------------------------------------------------------------ collecting the files

export const DEPLOY_MAX_FILES = 3000;
export const DEPLOY_MAX_BYTES = 60 * 1024 * 1024;
const DEPLOY_MAX_FILE = 25 * 1024 * 1024;

/** Lists a folder on the computer: relative path, size and sha1 per file, skipping what must never be uploaded. */
export function listScript(dir: string, source: boolean): string {
  // node_modules, .git and env/secret files are never uploaded; a source deploy (Vercel builds it) also skips build output
  const skipDirs = ['node_modules', '.git', '.hg', '.svn', '__pycache__', '.venv', 'venv', '.cache', '.orin', '.vercel', '.netlify', ...(source ? ['.next', '.nuxt', '.svelte-kit', '.turbo', '.expo', '.output'] : [])];
  return `python3 - ${shq(dir)} <<'PY'
import os, sys, json, hashlib
root = sys.argv[1]
if not os.path.isdir(root):
    print(json.dumps({"error": "No folder " + root})); sys.exit(0)
skip = set(${JSON.stringify(skipDirs)})
out = []; total = 0; big = []
for d, dirs, files in os.walk(root):
    dirs[:] = sorted(x for x in dirs if x not in skip and not (x.startswith('.') and x != '.well-known'))
    for f in sorted(files):
        if f.startswith('.env') or f in ('.DS_Store', '.npmrc', '.netrc', 'id_rsa', 'id_ed25519') or f.endswith(('.pem', '.key')):
            continue
        p = os.path.join(d, f)
        if os.path.islink(p) or not os.path.isfile(p):
            continue
        size = os.path.getsize(p)
        if size > ${DEPLOY_MAX_FILE}:
            big.append(os.path.relpath(p, root)); continue
        h = hashlib.sha1()
        with open(p, 'rb') as fh:
            for chunk in iter(lambda: fh.read(1 << 20), b''):
                h.update(chunk)
        out.append([os.path.relpath(p, root).replace(os.sep, '/'), size, h.hexdigest()])
        total += size
        if len(out) > ${DEPLOY_MAX_FILES} or total > ${DEPLOY_MAX_BYTES}:
            print(json.dumps({"error": "too_big", "files": len(out), "bytes": total})); sys.exit(0)
print(json.dumps({"files": out, "bytes": total, "skipped_big": big[:10]}))
PY`;
}

export interface DeployFile {
  path: string;
  size: number;
  sha: string;
}

async function collect(ctx: ToolContext, dir: string, source: boolean): Promise<{ files: DeployFile[]; bytes: number; read: (p: string) => Promise<Uint8Array> } | string> {
  return withSandbox(ctx, async (s) => {
    const r = await s.exec(listScript(dir, source), { cwd: '/home/user', timeoutMs: 120_000 });
    let j: { files?: [string, number, string][]; bytes?: number; error?: string; skipped_big?: string[] };
    try {
      j = JSON.parse(r.stdout.trim().split('\n').pop() ?? '{}');
    } catch {
      return `Could not list ${dir} on the computer: ${clip((r.stderr || r.stdout).trim(), 300)}`;
    }
    if (j.error === 'too_big') return `${dir} is too big to deploy from here (over ${DEPLOY_MAX_FILES} files or ${DEPLOY_MAX_BYTES / 1024 / 1024} MB). Deploy the build output folder (like dist or build), not the whole project.`;
    if (j.error) return j.error;
    const files = (j.files ?? []).map(([path, size, sha]) => ({ path, size, sha }));
    if (!files.length) return `${dir} has no files to deploy.`;
    // reading needs the computer again; each read is its own short use
    return { files, bytes: j.bytes ?? 0, read: (p: string) => withSandbox(ctx, (s2) => s2.readFile(`${dir}/${p}`)) };
  });
}

/** Runs fn over items with a few at a time. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

const sha1 = (b: Uint8Array) => createHash('sha1').update(b).digest('hex');

// ------------------------------------------------------------------ Netlify

interface NetlifySite {
  id: string;
  name: string;
  ssl_url?: string;
  url?: string;
  updated_at?: string;
  published_deploy?: { state?: string; published_at?: string } | null;
}
interface NetlifyDeploy {
  id: string;
  state: string;
  required?: string[];
  ssl_url?: string;
  deploy_ssl_url?: string;
  error_message?: string | null;
}

const siteSlug = (v: string) =>
  v
    .toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/\.(netlify|vercel)\.app.*$/, '')
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

export async function netlifyDeploy(ctx: ToolContext, dir: string, site: string | undefined, progress: (t: string) => void): Promise<{ url: string; siteName: string; uploaded: number; files: number; created: boolean }> {
  const t = tok(ctx, 'netlify', 'Netlify');
  const svc = ctx.services;
  const got = await collect(ctx, dir, false);
  if (typeof got === 'string') throw new Error(got);
  if (!got.files.some((f) => f.path === 'index.html')) throw new Error(`${dir} has no index.html at its top. Netlify serves files as they are: build the project first (npm run build) and deploy the output folder (dist, build or out).`);
  let s: NetlifySite | undefined;
  let created = false;
  if (site) {
    const slug = siteSlug(site);
    const found = await netlify<NetlifySite[]>(svc, t, `/sites?name=${encodeURIComponent(slug)}&filter=all&per_page=50`, ctx.signal);
    s = found.find((x) => x.id === site || x.name === slug);
    if (!s) {
      s = await netlify<NetlifySite>(svc, t, '/sites', ctx.signal, { method: 'POST', body: { name: slug } });
      created = true;
    }
  } else {
    s = await netlify<NetlifySite>(svc, t, '/sites', ctx.signal, { method: 'POST', body: {} });
    created = true;
  }
  progress(`Uploading to Netlify (${got.files.length} files)…`);
  const manifest: Record<string, string> = {};
  for (const f of got.files) manifest[`/${f.path}`] = f.sha;
  const d = await netlify<NetlifyDeploy>(svc, t, `/sites/${s.id}/deploys`, ctx.signal, { method: 'POST', body: { files: manifest, async: false } });
  const need = new Set(d.required ?? []);
  const todo = got.files.filter((f) => need.has(f.sha));
  const done = new Set<string>();
  await pool(todo, 4, async (f) => {
    if (done.has(f.sha)) return; // one upload per content
    done.add(f.sha);
    const body = await got.read(f.path);
    if (sha1(body) !== f.sha) throw new Error(`${f.path} changed while it was being deployed; deploy again.`);
    await netlify(svc, t, `/deploys/${d.id}/files/${f.path.split('/').map(encodeURIComponent).join('/')}`, ctx.signal, { method: 'PUT', raw: body });
  });
  let state = d.state;
  let last: NetlifyDeploy = d;
  for (let i = 0; i < 60 && !['ready', 'error'].includes(state); i++) {
    await sleep(2000, ctx.signal);
    last = await netlify<NetlifyDeploy>(svc, t, `/deploys/${d.id}`, ctx.signal);
    state = last.state;
  }
  if (state === 'error') throw new Error(`Netlify said the deploy failed${last.error_message ? `: ${last.error_message}` : ''}.`);
  if (state !== 'ready') throw new Error(`Netlify is still processing the deploy (state "${state}"). Check it with deploy_list in a minute.`);
  return { url: s.ssl_url || last.ssl_url || `https://${s.name}.netlify.app`, siteName: s.name, uploaded: done.size, files: got.files.length, created };
}

// ------------------------------------------------------------------ Vercel

interface VercelDeployment {
  id: string;
  url: string;
  readyState?: string;
  status?: string;
  alias?: string[];
  errorMessage?: string;
  inspectorUrl?: string;
}

export async function vercelDeploy(ctx: ToolContext, dir: string, project: string, team: string | undefined, progress: (t: string) => void): Promise<{ url: string; inspector?: string; uploaded: number; files: number }> {
  const t = tok(ctx, 'vercel', 'Vercel');
  const svc = ctx.services;
  const q = team ? `teamId=${encodeURIComponent(team)}` : '';
  const got = await collect(ctx, dir, true);
  if (typeof got === 'string') throw new Error(got);
  progress(`Uploading to Vercel (${got.files.length} files)…`);
  const seen = new Set<string>();
  await pool(got.files, 4, async (f) => {
    if (seen.has(f.sha)) return;
    seen.add(f.sha);
    const body = await got.read(f.path);
    if (sha1(body) !== f.sha) throw new Error(`${f.path} changed while it was being deployed; deploy again.`);
    await vercel(svc, t, `/v2/files${q ? `?${q}` : ''}`, ctx.signal, { method: 'POST', raw: body, headers: { 'x-vercel-digest': f.sha } });
  });
  progress('Vercel is building…');
  const name = siteSlug(project) || 'orin-app';
  const d = await vercel<VercelDeployment>(svc, t, `/v13/deployments?skipAutoDetectionConfirmation=1${q ? `&${q}` : ''}`, ctx.signal, {
    method: 'POST',
    body: { name, project: name, target: 'production', files: got.files.map((f) => ({ file: f.path, sha: f.sha, size: f.size })) },
  });
  let last = d;
  let state = d.readyState ?? d.status ?? 'QUEUED';
  for (let i = 0; i < 100 && !['READY', 'ERROR', 'CANCELED'].includes(state); i++) {
    await sleep(3000, ctx.signal);
    last = await vercel<VercelDeployment>(svc, t, `/v13/deployments/${d.id}${q ? `?${q}` : ''}`, ctx.signal);
    state = last.readyState ?? last.status ?? state;
  }
  if (state === 'ERROR' || state === 'CANCELED') throw new Error(`Vercel's build failed${last.errorMessage ? `: ${last.errorMessage}` : ''}.${last.inspectorUrl ? ` Build log: ${last.inspectorUrl}` : ''} Fix it on your computer (run_checks with the build command) and deploy again.`);
  if (state !== 'READY') throw new Error(`Vercel is still building (state ${state}). ${last.inspectorUrl ? `Follow it at ${last.inspectorUrl}` : 'Check deploy_list in a minute.'}`);
  const alias = (last.alias ?? []).find((a) => a.endsWith('.vercel.app') && !a.includes('-git-')) ?? last.alias?.[0];
  return { url: `https://${alias ?? last.url}`, inspector: last.inspectorUrl, uploaded: seen.size, files: got.files.length };
}

// ------------------------------------------------------------------ tools

const hostArg = z.enum(['netlify', 'vercel']);

export const deployProjectTool = defineTool({
  name: 'deploy_project',
  description:
    "Deploy a project folder from your computer to the user's own Netlify or Vercel account and get a real public link. Netlify serves files as they are: build first (run_checks with npm run build) and pass the output folder (dist / build / out) with index.html at its top. Vercel builds the source itself (Next.js, Vite, React, Svelte, static…): pass the project folder. site = the site/project name to create or update (same name updates it). node_modules, .git and .env files are never uploaded. The user approves first. Then check_site the link.",
  schema: z.object({
    host: hostArg,
    path: z.string().trim().min(1).max(300).describe('folder on your computer, e.g. /home/user/work/app/dist'),
    site: z.string().trim().min(1).max(80).optional().describe('site or project name, e.g. "fa-todo" (Netlify picks a random one when left out; required for Vercel)'),
    team: z.string().trim().max(80).optional().describe('Vercel team id, only for a team account'),
  }),
  label: (a) => `Deploying to ${a.host === 'netlify' ? 'Netlify' : 'Vercel'}…`,
  needs: (p) => {
    const n = needsApp('netlify', 'Netlify')(p);
    const v = needsApp('vercel', 'Vercel')(p);
    return n && v ? 'the user to connect Netlify or Vercel on the Apps page (tap it, paste a token)' : sandboxNeeds(p.services, p.owner);
  },
  approval: (a) => ({
    title: `Deploy to ${a.host === 'netlify' ? 'Netlify' : 'Vercel'}`,
    headline: a.site ?? (a.host === 'netlify' ? 'New Netlify site' : 'New Vercel project'),
    body: `Orin wants to publish ${a.path} to your ${a.host === 'netlify' ? 'Netlify' : 'Vercel'} account. It will be public on the internet.`,
    fields: [
      { label: 'Host', value: a.host === 'netlify' ? 'Netlify' : 'Vercel' },
      { label: 'Folder', value: a.path },
      { label: a.host === 'netlify' ? 'Site' : 'Project', value: a.site ?? '(new, random name)' },
    ],
  }),
  handler: async (a, ctx) => {
    if (!connected(ctx.services, ctx.owner, a.host)) return { ok: false, content: `${a.host === 'netlify' ? 'Netlify' : 'Vercel'} is not connected. Ask the user to connect it on the Apps page (they paste a token), or use the other host.`, summary: 'Not connected' };
    const dir = sandboxPath(a.path);
    const progress = (t: string) => log(ctx, 'command', t);
    if (a.host === 'netlify') {
      const r = await netlifyDeploy(ctx, dir, a.site, progress);
      return {
        content: `Live on Netlify: ${r.url} (site "${r.siteName}"${r.created ? ', new' : ''}). ${r.files} files, ${r.uploaded} uploaded (unchanged ones were reused). Now check_site the link before you tell the user.`,
        summary: 'Deployed to Netlify',
        display: { kind: 'page', url: r.url, title: r.siteName },
      };
    }
    if (!a.site) return { ok: false, content: 'Vercel needs a project name: pass site (like "fa-todo").', summary: 'Needs a name' };
    const r = await vercelDeploy(ctx, dir, a.site, a.team, progress);
    return {
      content: `Live on Vercel: ${r.url}. ${r.files} files sent (${r.uploaded} uploaded).${r.inspector ? ` Build details: ${r.inspector}` : ''} Now check_site the link before you tell the user.`,
      summary: 'Deployed to Vercel',
      display: { kind: 'page', url: r.url, title: siteSlug(a.site) },
    };
  },
});

export const deployListTool = defineTool({
  name: 'deploy_list',
  description: "List the user's sites on Netlify or projects on Vercel with their links and latest deploy state.",
  schema: z.object({ host: hostArg, team: z.string().trim().max(80).optional() }),
  label: (a) => `Checking your ${a.host === 'netlify' ? 'Netlify sites' : 'Vercel projects'}…`,
  needs: (p) => (needsApp('netlify', 'Netlify')(p) && needsApp('vercel', 'Vercel')(p) ? 'the user to connect Netlify or Vercel on the Apps page' : null),
  handler: async (a, ctx) => {
    if (a.host === 'netlify') {
      const sites = await netlify<NetlifySite[]>(ctx.services, tok(ctx, 'netlify', 'Netlify'), '/sites?filter=all&per_page=30&sort_by=updated_at', ctx.signal);
      if (!sites.length) return { content: 'No Netlify sites yet.', summary: 'No sites' };
      return { content: sites.map((s) => `- ${s.name}: ${s.ssl_url || s.url} (${s.published_deploy?.state ?? 'no deploy yet'}${s.updated_at ? `, updated ${s.updated_at.slice(0, 10)}` : ''})`).join('\n'), summary: `${sites.length} sites` };
    }
    const q = a.team ? `&teamId=${encodeURIComponent(a.team)}` : '';
    const r = await vercel<{ projects: { name: string; id: string; updatedAt?: number; latestDeployments?: { url: string; readyState?: string; target?: string | null }[]; targets?: { production?: { alias?: string[]; readyState?: string } } }[] }>(ctx.services, tok(ctx, 'vercel', 'Vercel'), `/v9/projects?limit=30${q}`, ctx.signal);
    if (!r.projects?.length) return { content: 'No Vercel projects yet.', summary: 'No projects' };
    return {
      content: r.projects
        .map((p) => {
          const prod = p.targets?.production;
          const url = prod?.alias?.find((x) => x.endsWith('.vercel.app')) ?? prod?.alias?.[0] ?? p.latestDeployments?.[0]?.url;
          return `- ${p.name}: ${url ? `https://${url}` : 'not deployed'} (${prod?.readyState ?? p.latestDeployments?.[0]?.readyState ?? 'no deploy'})`;
        })
        .join('\n'),
      summary: `${r.projects.length} projects`,
    };
  },
});

// ---- Render (servers and APIs that run all the time, from a GitHub repo)

interface RenderService {
  id: string;
  name: string;
  type: string;
  suspended?: string;
  repo?: string;
  branch?: string;
  dashboardUrl?: string;
  serviceDetails?: { url?: string; plan?: string };
}

const rTok = (ctx: ToolContext) => tok(ctx, 'render', 'Render');
const rNeeds = needsApp('render', 'Render');

export const renderServicesTool = defineTool({
  name: 'render_services',
  description: "List the user's Render services (web services, static sites, workers) with their links, plan and the latest deploy state.",
  schema: z.object({ name: z.string().trim().max(80).optional().describe('only services whose name contains this') }),
  label: () => 'Checking your Render services…',
  needs: rNeeds,
  handler: async (a, ctx) => {
    const rows = await render<{ service: RenderService }[]>(ctx.services, rTok(ctx), `/services?limit=50${a.name ? `&name=${encodeURIComponent(a.name)}` : ''}`, ctx.signal);
    if (!rows.length) return { content: 'No Render services found.', summary: 'No services' };
    const lines = await Promise.all(
      rows.slice(0, 20).map(async ({ service: s }) => {
        let dep = '';
        try {
          const d = await render<{ deploy: { status: string; finishedAt?: string } }[]>(ctx.services, rTok(ctx), `/services/${s.id}/deploys?limit=1`, ctx.signal);
          if (d[0]) dep = `, last deploy ${d[0].deploy.status}${d[0].deploy.finishedAt ? ` ${d[0].deploy.finishedAt.slice(0, 16).replace('T', ' ')}` : ''}`;
        } catch {
          /* the list is still useful */
        }
        return `- ${s.name} (${s.type}, id ${s.id}${s.serviceDetails?.plan ? `, ${s.serviceDetails.plan}` : ''}${s.suspended === 'suspended' ? ', SUSPENDED' : ''}): ${s.serviceDetails?.url ?? s.dashboardUrl ?? ''}${s.repo ? ` from ${s.repo}${s.branch ? `@${s.branch}` : ''}` : ''}${dep}`;
      }),
    );
    return { content: lines.join('\n'), summary: `${rows.length} services` };
  },
});

export const renderDeployTool = defineTool({
  name: 'render_deploy',
  description: 'Start a new deploy of a Render service (it pulls the latest commit of its branch; push first with git_push), wait for it and report how it went. clear_cache rebuilds from scratch. The user approves first.',
  schema: z.object({ service: z.string().trim().min(3).max(80).describe('service id (srv-…) or exact name from render_services'), clear_cache: z.boolean().optional(), wait: z.boolean().optional().describe('wait up to 10 minutes for it to finish (default true)') }),
  label: () => 'Deploying on Render…',
  needs: rNeeds,
  approval: (a) => ({ title: 'Deploy on Render', headline: a.service, body: `Orin wants to deploy ${a.service} on your Render account. The service restarts with the newest commit.`, fields: [{ label: 'Service', value: a.service }, ...(a.clear_cache ? [{ label: 'Build cache', value: 'cleared' }] : [])] }),
  handler: async (a, ctx) => {
    const t = rTok(ctx);
    let id = a.service;
    if (!/^srv-|^crn-/.test(id)) {
      const rows = await render<{ service: RenderService }[]>(ctx.services, t, `/services?limit=50&name=${encodeURIComponent(a.service)}`, ctx.signal);
      const hit = rows.find((r) => r.service.name === a.service) ?? rows[0];
      if (!hit) return { ok: false, content: `No Render service named "${a.service}". Use render_services to see them.`, summary: 'Not found' };
      id = hit.service.id;
    }
    const d = await render<{ id: string; status: string }>(ctx.services, t, `/services/${id}/deploys`, ctx.signal, { method: 'POST', body: { clearCache: a.clear_cache ? 'clear' : 'do_not_clear' } });
    if (a.wait === false) return { content: `Render deploy ${d.id} started (${d.status}). Check it later with render_services.`, summary: 'Deploy started' };
    let status = d.status;
    for (let i = 0; i < 120 && !['live', 'build_failed', 'update_failed', 'canceled', 'deactivated', 'pre_deploy_failed'].includes(status); i++) {
      await sleep(5000, ctx.signal);
      status = (await render<{ status: string }>(ctx.services, t, `/services/${id}/deploys/${d.id}`, ctx.signal)).status;
    }
    const s = await render<RenderService>(ctx.services, t, `/services/${id}`, ctx.signal).catch(() => null);
    const url = s?.serviceDetails?.url;
    if (status !== 'live') return { ok: status === 'build_in_progress' || status === 'update_in_progress', content: `Render deploy ${d.id} ended as "${status}".${s?.dashboardUrl ? ` Logs: ${s.dashboardUrl}/deploys/${d.id}` : ''}`, summary: `Deploy ${status.replace(/_/g, ' ')}` };
    return { content: `Render deploy is live${url ? `: ${url}` : ''}. Check it with check_site before telling the user.`, summary: 'Deployed on Render', ...(url ? { display: { kind: 'page' as const, url, title: s?.name ?? 'Render' } } : {}) };
  },
});

export const renderCreateServiceTool = defineTool({
  name: 'render_create_service',
  description:
    "Create a new Render service from a GitHub repo on the user's Render account, free plan: a static_site (build command + publish folder) or a web_service (Node or Python server: build and start commands). Render must have access to the repo (the user links GitHub in Render once). Env vars can be given; secrets come from the user, never invented. The user approves first.",
  schema: z.object({
    type: z.enum(['static_site', 'web_service']),
    name: z.string().trim().min(2).max(60),
    repo: z.string().trim().min(5).max(200).describe('https://github.com/owner/repo'),
    branch: z.string().trim().max(100).optional(),
    root_dir: z.string().trim().max(200).optional(),
    build_command: z.string().trim().max(400).optional(),
    publish_path: z.string().trim().max(200).optional().describe('static_site: folder with index.html after the build, e.g. dist'),
    start_command: z.string().trim().max(400).optional().describe('web_service: e.g. npm start'),
    runtime: z.enum(['node', 'python', 'docker']).optional().describe('web_service runtime (default node)'),
    env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string().max(4000)).optional(),
    region: z.enum(['oregon', 'frankfurt', 'ohio', 'virginia', 'singapore']).optional(),
  }),
  label: (a) => `Creating ${a.name} on Render…`,
  needs: rNeeds,
  approval: (a) => ({
    title: 'Create Render service',
    headline: a.name,
    body: `Orin wants to create a free ${a.type === 'static_site' ? 'static site' : 'web service'} on your Render account from ${a.repo}.`,
    fields: [
      { label: 'Type', value: a.type === 'static_site' ? 'Static site' : `Web service (${a.runtime ?? 'node'})` },
      { label: 'Repo', value: `${a.repo}${a.branch ? ` @ ${a.branch}` : ''}` },
      ...(a.build_command ? [{ label: 'Build', value: a.build_command }] : []),
      ...(a.start_command ? [{ label: 'Start', value: a.start_command }] : []),
      ...(a.publish_path ? [{ label: 'Publish', value: a.publish_path }] : []),
      ...(a.env && Object.keys(a.env).length ? [{ label: 'Env vars', value: Object.keys(a.env).join(', ') }] : []),
      { label: 'Plan', value: 'Free' },
    ],
  }),
  handler: async (a, ctx) => {
    const t = rTok(ctx);
    const owners = await render<{ owner: { id: string; name: string } }[]>(ctx.services, t, '/owners?limit=5', ctx.signal);
    const ownerId = owners[0]?.owner.id;
    if (!ownerId) return { ok: false, content: 'Render did not return a workspace for this token.', summary: 'No workspace' };
    const envVars = Object.entries(a.env ?? {}).map(([key, value]) => ({ key, value }));
    const details =
      a.type === 'static_site'
        ? { buildCommand: a.build_command ?? '', publishPath: a.publish_path ?? 'public', pullRequestPreviewsEnabled: 'no' }
        : { runtime: a.runtime ?? 'node', plan: 'free', region: a.region ?? 'oregon', envSpecificDetails: a.runtime === 'docker' ? {} : { buildCommand: a.build_command ?? (a.runtime === 'python' ? 'pip install -r requirements.txt' : 'npm install'), startCommand: a.start_command ?? (a.runtime === 'python' ? 'python app.py' : 'npm start') } };
    const r = await render<{ service: RenderService; deployId?: string }>(ctx.services, t, '/services', ctx.signal, {
      method: 'POST',
      body: { type: a.type, name: a.name, ownerId, repo: a.repo, ...(a.branch ? { branch: a.branch } : {}), ...(a.root_dir ? { rootDir: a.root_dir } : {}), autoDeploy: 'yes', envVars, serviceDetails: details },
    });
    const url = r.service.serviceDetails?.url;
    return {
      content: `Created ${r.service.name} on Render (id ${r.service.id}). Its first deploy has started${url ? `; it will be at ${url}` : ''}. Follow it with render_services, then check_site the link. Dashboard: ${r.service.dashboardUrl ?? 'dashboard.render.com'}`,
      summary: 'Service created',
      ...(url ? { display: { kind: 'page' as const, url, title: r.service.name } } : {}),
    };
  },
});

export const renderEnvTool = defineTool({
  name: 'render_set_env',
  description: 'Add or change one environment variable on a Render service (use for API keys the user gave; the service needs a deploy to pick it up). The user approves first; the value is never shown back.',
  schema: z.object({ service: z.string().trim().min(3).max(80).describe('service id (srv-…)'), key: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).max(120), value: z.string().min(1).max(8000) }),
  label: (a) => `Setting ${a.key} on Render…`,
  needs: rNeeds,
  approval: (a) => ({ title: 'Set Render env var', headline: `${a.key} on ${a.service}`, body: `Orin wants to set ${a.key} on your Render service ${a.service}.`, fields: [{ label: 'Service', value: a.service }, { label: 'Variable', value: a.key }, { label: 'Value', value: `${a.value.length} characters (hidden)` }] }),
  handler: async (a, ctx) => {
    ctx.secrets?.add(a.value);
    await render(ctx.services, rTok(ctx), `/services/${encodeURIComponent(a.service)}/env-vars/${encodeURIComponent(a.key)}`, ctx.signal, { method: 'PUT', body: { value: a.value } });
    return { content: `${a.key} is set on ${a.service}. Run render_deploy for the service to use it.`, summary: `${a.key} set` };
  },
});

// ------------------------------------------------------------------ registry

export interface DeployAppSpec {
  id: DeployAppId;
  name: string;
  description: string;
  tokenLabel: string;
  tokenHelp: string;
  tokenUrl: string;
  verify: (svc: AgentServices, token: string, signal: AbortSignal) => Promise<string>;
}

export const DEPLOY_APPS: DeployAppSpec[] = [
  {
    id: 'netlify',
    name: 'Netlify',
    description: 'Publishes sites Orin builds to your own Netlify account with a real link; each deploy asks you first.',
    tokenLabel: 'Personal access token',
    tokenHelp: 'Netlify → User settings → Applications → Personal access tokens → New access token.',
    tokenUrl: 'https://app.netlify.com/user/applications#personal-access-tokens',
    verify: async (svc, token, signal) => {
      const u = await netlify<{ email?: string; full_name?: string; slug?: string }>(svc, token, '/user', signal);
      return u.email || u.full_name || u.slug || 'Netlify';
    },
  },
  {
    id: 'vercel',
    name: 'Vercel',
    description: 'Builds and hosts Next.js, React, Vite and static apps on your Vercel account; each deploy asks you first.',
    tokenLabel: 'Access token',
    tokenHelp: 'Vercel → Account settings → Tokens → Create (scope: your account, or the team Orin should use).',
    tokenUrl: 'https://vercel.com/account/tokens',
    verify: async (svc, token, signal) => {
      const u = await vercel<{ user?: { username?: string; email?: string } }>(svc, token, '/v2/user', signal);
      return u.user?.username || u.user?.email || 'Vercel';
    },
  },
  {
    id: 'render',
    name: 'Render',
    description: 'Lists, creates and redeploys your Render servers and sites from GitHub, and sets their env vars; changes ask you first.',
    tokenLabel: 'API key (rnd_…)',
    tokenHelp: 'Render → Account settings → API keys → Create API key.',
    tokenUrl: 'https://dashboard.render.com/u/settings#api-keys',
    verify: async (svc, token, signal) => {
      const o = await render<{ owner: { name?: string; email?: string } }[]>(svc, token, '/owners?limit=1', signal);
      return o[0]?.owner.email || o[0]?.owner.name || 'Render';
    },
  },
];

export const deployAppTools: Record<DeployAppId, ToolDef[]> = {
  netlify: [deployProjectTool, deployListTool],
  vercel: [deployProjectTool, deployListTool],
  render: [renderServicesTool, renderDeployTool, renderCreateServiceTool, renderEnvTool],
};

/** Each tool once (deploy_project and deploy_list serve both Netlify and Vercel). */
export const allDeployAppTools: ToolDef[] = [deployProjectTool, deployListTool, renderServicesTool, renderDeployTool, renderCreateServiceTool, renderEnvTool];
