import { z } from 'zod';
import { commandRisk } from '../risk.js';
import { defineTool, type AgentServices, type ToolContext } from './types.js';
import { SANDBOX_WORKDIR, sandboxPath, shq, type ExecResult, type SandboxSession } from '../sandbox/index.js';
import { copyToWorkspace, listRemote, SAVE_MAX_FILE, SAVE_PREFIX } from '../sandbox/persist.js';
import { MAX_FILE_BYTES, workspaceDir, writeBigFile, writeWsFile } from '../workspace.js';
import { redactSecrets, resolveSecrets, secretsSchema, type SecretRefs } from '../sandbox/secrets.js';

/**
 * Tools that work on Orin's own computer (a cloud sandbox, E2B by default). One sandbox per
 * agent is started on first use and reused, so files and installed packages carry over between
 * steps. Hidden from the model until a sandbox provider is configured.
 */

export function sandboxNeeds(svc: AgentServices): string | null {
  return svc.sandboxes ? svc.sandboxes.needs() : 'a sandbox provider (E2B_API_KEY)';
}

export function withSandbox<T>(ctx: ToolContext, fn: (s: SandboxSession) => Promise<T>): Promise<T> {
  const m = ctx.services.sandboxes;
  if (!m) throw new Error('The sandbox is not set up on this server.');
  return m.use(ctx.owner, fn, { signal: ctx.signal, incognito: ctx.incognito });
}

export const log = (ctx: ToolContext, kind: 'command' | 'code' | 'file' | 'save', text: string, ok = true, ms?: number) => ctx.services.sandboxes?.log(ctx.owner, kind, text, ok, ms === undefined ? {} : { ms });

export function formatExec(r: ExecResult, fullPath?: string): string {
  const code = r.exitCode === null ? (r.timedOut ? 'stopped (time limit)' : 'stopped') : String(r.exitCode);
  const cut = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, Math.floor(n * 0.3))}\n\u2026[${t.length - n} characters cut here]\u2026\n${t.slice(-Math.ceil(n * 0.7))}`);
  const note = fullPath ? `\n\nThe output was long: all of it is saved in ${fullPath} on your computer. Read parts with sandbox_run (rg, sed -n, tail) instead of running the command again.` : '';
  return `exit code: ${code}\n\nstdout:\n${cut(r.stdout, 8000) || '(empty)'}\n\nstderr:\n${cut(r.stderr, 4000) || '(empty)'}${note}`;
}

/** Saves the whole (already redacted) output of a long command to a file on the computer. */
export async function keepFullOutput(ctx: ToolContext, r: ExecResult): Promise<string | undefined> {
  if (r.stdout.length <= 8000 && r.stderr.length <= 4000) return undefined;
  const path = `/home/user/.orin/out/cmd-${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15)}-${Math.random().toString(36).slice(2, 6)}.log`;
  try {
    await withSandbox(ctx, (s) => s.writeFile(path, `${r.stdout}${r.stderr ? `\n\n--- stderr ---\n${r.stderr}` : ''}`));
    return path;
  } catch {
    return undefined;
  }
}

/** Command output with any vault secret replaced by [secret:NAME]. */
export function hide(owner: string, r: ExecResult): ExecResult {
  return { ...r, stdout: redactSecrets(owner, r.stdout), stderr: redactSecrets(owner, r.stderr) };
}

/**
 * A vault key used with the internet is held for the user even for a plain read: a page or a
 * file Orin read could have told her to send the key somewhere. Local-only use runs straight away.
 */
export function secretNetRisk(code: string): string | null {
  const hosts = [...code.matchAll(/\bhttps?:\/\/([^/\s:'"`]+)/gi)].map((m) => m[1]!.toLowerCase()).filter((h) => !/^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(h));
  if (hosts.length) return `sends a key from your vault to ${[...new Set(hosts)].slice(0, 3).join(', ')}`;
  if (/\b(curl|wget|nc|ssh|scp|rsync|requests\.|httpx|urllib|aiohttp|http\.client|fetch\(|axios|got\(|socket\.)/i.test(code)) return 'sends a key from your vault over the internet';
  return null;
}

/** Approval-card lines naming the vault entries a run uses (names only, never values). */
export function secretFields(refs: SecretRefs): { label: string; value: string }[] {
  return refs?.length ? [{ label: 'Uses from your vault', value: refs.map((r) => `${r.name} as $${r.env}`).join(', ') }] : [];
}

export const short = (s: string, n = 80) => (s.length > n ? `${s.slice(0, n - 1)}…` : s).replace(/\s+/g, ' ');

export const sandboxRunTool = defineTool({
  name: 'sandbox_run',
  description:
    `Run a shell command (bash) on your own Linux computer: a private Ubuntu cloud machine with internet and sudo (no password). ` +
    'Installed: Python 3 with pip (requests, pandas, numpy, matplotlib, pillow, pypdf, pdfplumber, reportlab, python-docx, openpyxl, python-pptx, playwright), Node.js 22 LTS with npm, yarn, pnpm, npx expo and eas (EAS CLI), TypeScript, git, build-essential, cmake, ' +
    'Java 17 (default) and Java 21 ($JAVA21_HOME, for Capacitor), the Android SDK ($ANDROID_HOME: platforms 36 and 37, build-tools 36 and 37, NDK 27, CMake) with Gradle settings for this machine, orin-capacitor-build (web app to APK with Capacitor), orin-android-build (Expo/React Native app to APK), Capacitor CLI (cap), Chromium (use sandbox_browser), LibreOffice (soffice --headless --convert-to pdf), pandoc, ImageMagick, ffmpeg, poppler (pdftotext), qpdf, ghostscript, tesseract, zip/7z, jq, ripgrep, sqlite3. ' +
    `The working folder is ${SANDBOX_WORKDIR}; files and installed packages stay there while the computer is on (it turns off after about 10 quiet minutes and lives at most about an hour); changed files are then saved to the user's files under ${SAVE_PREFIX}/ and copied back next time, without node_modules and build folders. ` +
    'Long output is saved whole to a file and the reply names it. For a server that keeps running (npm run dev, npx expo start --web, python -m http.server) set background true, then use sandbox_preview for its link. For anything over a few minutes (Android builds, big installs) use sandbox_job. Edit files with sandbox_edit_file. Nothing here touches the user\'s real devices or accounts.',
  schema: z.object({
    command: z.string().min(1).max(20_000),
    cwd: z.string().max(300).optional().describe(`Folder to run in; relative paths are inside ${SANDBOX_WORKDIR}`),
    timeout_sec: z.number().int().min(5).max(600).optional().describe('Time limit, default 120 s'),
    background: z.boolean().optional().describe('Start it and return at once (for servers that keep running)'),
    secrets: secretsSchema,
  }),
  label: (a) => `Running ${short(a.command, 40)}…`,
  needs: ({ services }) => sandboxNeeds(services),
  timeoutMs: 660_000,
  approval: (a) => {
    const why = commandRisk(a.command) ?? (a.secrets?.length ? secretNetRisk(a.command) : null);
    return why
      ? {
          title: 'Run a command that reaches outside',
          headline: short(a.command, 120),
          body: `Orin wants to run this on her computer. It ${why}.${a.secrets?.length ? ' It uses keys from your Secure Vault; their values stay hidden.' : ''}`,
          content: a.command,
          fields: [{ label: 'Runs in', value: sandboxPath(a.cwd) }, ...secretFields(a.secrets)],
        }
      : null;
  },
  handler: async (a, ctx) => {
    const cwd = sandboxPath(a.cwd);
    const t0 = Date.now();
    const { envs, names } = resolveSecrets(ctx, a.secrets);
    if (a.background) {
      const r = await withSandbox(ctx, (s) => s.execBackground(a.command, { cwd, envs }));
      log(ctx, 'command', `Started in background: ${short(a.command)}`);
      return { content: `Started in the background${r.pid ? ` (pid ${r.pid})` : ''}: ${a.command}\nGive it a few seconds, then check it with sandbox_run (e.g. curl -s localhost:PORT) or get a link with sandbox_preview.`, summary: 'Started in background' };
    }
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(a.command, { cwd, timeoutMs: (a.timeout_sec ?? 120) * 1000, signal: ctx.signal, envs })));
    const ok = r.exitCode === 0;
    log(ctx, 'command', `${short(a.command)}${names.length ? ` (with ${names.join(', ')} from your vault)` : ''}`, ok, Date.now() - t0);
    const full = await keepFullOutput(ctx, r);
    return {
      ok,
      content: formatExec(r, full),
      summary: ok ? 'Command ran' : r.exitCode === null ? 'Command stopped' : `Command failed (exit ${r.exitCode})`,
      display: { kind: 'code', stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) },
    };
  },
});

export const sandboxWriteFileTool = defineTool({
  name: 'sandbox_write_file',
  description: `Create or overwrite a text file on your sandbox computer (folders are created). Relative paths are inside ${SANDBOX_WORKDIR}. Use it for source code, configs and site files you then run or build with sandbox_run.`,
  schema: z.object({ path: z.string().min(1).max(300), content: z.string().max(1_000_000) }),
  label: (a) => `Writing ${short(a.path, 40)}…`,
  needs: ({ services }) => sandboxNeeds(services),
  handler: async (a, ctx) => {
    const p = sandboxPath(a.path);
    await withSandbox(ctx, (s) => s.writeFile(p, a.content));
    log(ctx, 'file', `Wrote ${p.replace(`${SANDBOX_WORKDIR}/`, '')}`);
    return { content: `Wrote ${p} (${Buffer.byteLength(a.content)} bytes).`, summary: `Wrote ${p.split('/').pop()}` };
  },
});

export const sandboxReadFileTool = defineTool({
  name: 'sandbox_read_file',
  description: `Read a text file from your sandbox computer (relative paths are inside ${SANDBOX_WORKDIR}). Long files are cut at 20,000 characters.`,
  schema: z.object({ path: z.string().min(1).max(300) }),
  label: (a) => `Reading ${short(a.path, 40)}…`,
  needs: ({ services }) => sandboxNeeds(services),
  handler: async (a, ctx) => {
    const p = sandboxPath(a.path);
    const data = await withSandbox(ctx, (s) => s.readFile(p));
    const text = redactSecrets(ctx.owner, Buffer.from(data).toString('utf8'));
    return { content: text.length > 20_000 ? `${text.slice(0, 20_000)}\n…(cut, ${text.length} characters in total)` : text || '(empty file)', summary: `Read ${p.split('/').pop()}` };
  },
});

export const sandboxListFilesTool = defineTool({
  name: 'sandbox_list_files',
  description: `List files in a folder of your sandbox computer (default ${SANDBOX_WORKDIR}), with sizes. node_modules, .git and caches are left out.`,
  schema: z.object({ path: z.string().max(300).optional() }),
  label: () => 'Listing sandbox files…',
  needs: ({ services }) => sandboxNeeds(services),
  handler: async (a, ctx) => {
    const dir = sandboxPath(a.path);
    const files = await withSandbox(ctx, (s) => listRemote(s, dir, 300));
    if (!files.length) return { content: `No files in ${dir}.`, summary: 'No files' };
    return { content: `${dir}:\n${files.map((f) => `${f.path}  (${f.size} bytes)`).join('\n')}`, summary: `${files.length} file${files.length === 1 ? '' : 's'}` };
  },
});

export const sandboxSaveTool = defineTool({
  name: 'sandbox_save',
  description:
    "Copy a file or folder from your sandbox computer into the user's own files on Orin's server, where they stay after the sandbox closes and the user can open them. " +
    'To publish a site you built in the sandbox: build it, sandbox_save the folder with index.html (e.g. dist) to "sites/<name>", then call publish_site with that folder. ' +
    'To send the user a file you made (a PDF, an image, a document, an APK), save that one file: a file card appears in the chat that they tap to open or download. ' +
    'For folders, node_modules, .git, build folders and caches are skipped, and files over 2 MB; up to 20 MB per folder save. A single file can be up to 60 MB; one over 1 MB (an APK, a video) is saved under downloads/ and appears in chat for the user to download (files over 20 MB are lost if the server restarts).',
  schema: z.object({
    path: z.string().min(1).max(300).describe(`File or folder in the sandbox; relative paths are inside ${SANDBOX_WORKDIR}`),
    to: z.string().min(1).max(200).describe('Destination folder in the user\'s files, e.g. "sites/portfolio" or "projects/report"'),
  }),
  label: (a) => `Saving ${short(a.path, 30)}…`,
  needs: ({ services }) => sandboxNeeds(services),
  writes: true,
  handler: async (a, ctx) => {
    const p = sandboxPath(a.path);
    const to = a.to.replace(/^\/+|\/+$/g, '');
    const rep = await withSandbox(ctx, async (s) => {
      const kind = await s.exec(`if [ -d ${shq(p)} ]; then echo dir; elif [ -f ${shq(p)} ]; then echo file; else echo none; fi`, { cwd: '/', timeoutMs: 15_000 });
      const what = kind.stdout.trim();
      if (what === 'none') throw new Error(`Nothing at ${p} in the sandbox.`);
      if (what === 'dir') return copyToWorkspace(ctx.services, ctx.owner, s, { from: p, to });
      const name = p.split('/').pop()!;
      const data = await s.readFile(p);
      if (data.byteLength > SINGLE_MAX_FILE) return { saved: [], skipped: [`${name} (over ${SINGLE_MAX_FILE / 1_000_000} MB)`], bytes: 0 };
      const root = workspaceDir(ctx.services, ctx.owner);
      // Small files go where asked; a big one (an APK, a video) goes to downloads/, outside the 20 MB quota.
      const f = data.byteLength > MAX_FILE_BYTES ? writeBigFile(root, name, Buffer.from(data)) : writeWsFile(root, `${to}/${name}`, Buffer.from(data));
      return { saved: [f.path], skipped: [], bytes: data.byteLength, single: true };
    });
    const ok = rep.saved.length > 0;
    log(ctx, 'save', ok ? `Saved ${rep.saved.length} file${rep.saved.length === 1 ? '' : 's'} to ${to}/` : `Nothing saved from ${p}`, ok);
    return {
      ok,
      content: ok
        ? `Saved ${rep.saved.length} file${rep.saved.length === 1 ? '' : 's'} (${rep.bytes} bytes) to the user's files${'single' in rep ? '' : ` under ${to}/`}:\n${rep.saved.slice(0, 60).map((f) => ('single' in rep ? f : `${to}/${f}`)).join('\n')}${rep.skipped.length ? `\n\nSkipped: ${rep.skipped.slice(0, 20).join('; ')}` : ''}`
        : `Nothing was saved from ${p}.${rep.skipped.length ? ` Skipped: ${rep.skipped.slice(0, 20).join('; ')}` : ' The folder is empty.'}`,
      summary: ok ? `Saved ${rep.saved.length} file${rep.saved.length === 1 ? '' : 's'}` : 'Nothing saved',
      display: ok ? { kind: 'file', path: 'single' in rep ? rep.saved[0]! : `${to}/${rep.saved.length === 1 ? rep.saved[0] : ''}`.replace(/\/$/, ''), size: rep.bytes } : undefined,
    };
  },
});

export const sandboxPreviewTool = defineTool({
  name: 'sandbox_preview',
  description:
    'Get a temporary public https link to a server running on your sandbox computer (start it first with sandbox_run background:true, listening on 0.0.0.0). The link stops working when the sandbox closes, so for a lasting link save the built files with sandbox_save and use publish_site.',
  schema: z.object({ port: z.number().int().min(1).max(65535) }),
  label: (a) => `Opening port ${a.port}…`,
  needs: ({ services }) => sandboxNeeds(services),
  handler: async (a, ctx) => {
    const out = await withSandbox(ctx, async (s) => {
      if (!s.publicUrl) return null;
      const probe = await s.exec(`curl -s -o /dev/null -w '%{http_code}' --max-time 5 http://localhost:${a.port}/ || true`, { cwd: '/', timeoutMs: 15_000 });
      return { url: s.publicUrl(a.port), code: probe.stdout.trim() };
    });
    if (!out) return { ok: false, content: 'This sandbox provider has no public links.', summary: 'No public link' };
    const up = /^[1-5]\d\d$/.test(out.code) && out.code !== '000';
    log(ctx, 'command', `Preview link for port ${a.port}${up ? '' : ' (nothing answering yet)'}`, up);
    return {
      ok: up,
      content: up
        ? `Temporary link (works while the sandbox is open, about 10 quiet minutes): ${out.url}\nThe server answered with HTTP ${out.code}.`
        : `Nothing is answering on port ${a.port} inside the sandbox yet (curl got ${out.code || 'no answer'}). Start the server with sandbox_run background:true on 0.0.0.0:${a.port}, wait a few seconds, and try again. Do not give the user this link until it answers: ${out.url}`,
      summary: up ? 'Preview link ready' : 'Server not answering',
      display: up ? { kind: 'page', url: out.url, title: `Preview on port ${a.port}` } : undefined,
    };
  },
});

export const sandboxCloseTool = defineTool({
  name: 'sandbox_close',
  description: `Save changed files (to the user's files under ${SAVE_PREFIX}/) and shut your sandbox computer down now. It also closes by itself after about 10 quiet minutes, so only use this when the user asks or the work is clearly finished.`,
  schema: z.object({}),
  label: () => 'Closing the sandbox…',
  needs: ({ services }) => sandboxNeeds(services),
  handler: async (_a, ctx) => {
    const closed = await ctx.services.sandboxes!.close(ctx.owner, 'Orin finished the work');
    return { content: closed ? `The sandbox is closed; changed files were saved under ${SAVE_PREFIX}/.` : 'No sandbox was open.', summary: closed ? 'Sandbox closed' : 'No sandbox open' };
  },
});

/** One file the user is sent with sandbox_save (an APK is ~25 MB). */
const SINGLE_MAX_FILE = 60_000_000;

export const sandboxTools = [sandboxRunTool, sandboxWriteFileTool, sandboxReadFileTool, sandboxListFilesTool, sandboxSaveTool, sandboxPreviewTool, sandboxCloseTool];

/** run_code on the sandbox: the code is written to a file in the work folder and run there. */
export async function runCodeInSandbox(ctx: ToolContext, language: 'python' | 'javascript' | 'bash', code: string, secrets?: SecretRefs): Promise<ExecResult> {
  const { envs, names } = resolveSecrets(ctx, secrets);
  const ext = language === 'python' ? 'py' : language === 'javascript' ? 'mjs' : 'sh';
  const file = `${SANDBOX_WORKDIR}/.orin/run.${ext}`;
  const cmd = language === 'python' ? `python3 ${file}` : language === 'javascript' ? `node ${file}` : `bash ${file}`;
  const t0 = Date.now();
  const r = await withSandbox(ctx, async (s) => {
    await s.writeFile(file, code);
    return s.exec(cmd, { timeoutMs: 120_000, signal: ctx.signal, envs });
  });
  log(ctx, 'code', `Ran ${language} (${code.split('\n').length} line${code.includes('\n') ? 's' : ''})${names.length ? ` with ${names.join(', ')} from your vault` : ''}`, r.exitCode === 0, Date.now() - t0);
  return hide(ctx.owner, r);
}
