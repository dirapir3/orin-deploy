import { listFiles, runJsSandboxed, workspaceDir } from '../workspace.js';
import { z } from 'zod';
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { defineTool, type AgentServices } from './types.js';
import { assertPublicUrl } from '../net.js';
import { runCodeInSandbox } from './sandbox.js';

/**
 * Pluggable adapters that stay hidden from the model until configured (no fake results).
 *  - Code sandbox: E2B (E2B_API_KEY + `npm i @e2b/code-interpreter`) or local Docker (CODE_SANDBOX=docker).
 *  - Browser: Playwright + Chromium (BROWSER_ENABLED=1, `npm i playwright-core`, BROWSER_EXECUTABLE or `npx playwright install chromium`).
 */

const require = createRequire(import.meta.url);
function hasPackage(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}
// Dynamic import that TypeScript does not try to resolve (optional dependencies).
const importOptional = (name: string): Promise<Record<string, unknown>> => import(/* @vite-ignore */ name) as Promise<Record<string, unknown>>;

let dockerOk: boolean | undefined;
function hasDocker(): boolean {
  if (dockerOk === undefined) {
    try {
      dockerOk = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 4000 }).status === 0;
    } catch {
      dockerOk = false;
    }
  }
  return dockerOk;
}

export function codeSandboxNeeds(svc: AgentServices): string | null {
  const i = svc.config.integrations;
  if (i.codeSandbox === 'e2b') {
    if (svc.sandboxes) return svc.sandboxes.needs();
    if (!i.e2bKey) return 'E2B_API_KEY';
    if (!hasPackage('@e2b/code-interpreter')) return 'npm install @e2b/code-interpreter (in server/)';
    return null;
  }
  if (i.codeSandbox === 'docker') return hasDocker() ? null : 'Docker installed and running on the server';
  // No cloud sandbox: JavaScript runs locally in the user's workspace with the Node permission model.
  return null;
}

async function runE2B(svc: AgentServices, language: string, code: string, signal: AbortSignal) {
  const mod = await importOptional('@e2b/code-interpreter');
  const Sandbox = mod.Sandbox as { create(o: { apiKey: string; timeoutMs?: number }): Promise<{ runCode(c: string, o?: Record<string, unknown>): Promise<{ logs: { stdout: string[]; stderr: string[] }; error?: { name: string; value: string }; text?: string }>; kill(): Promise<void> }> };
  const sbx = await Sandbox.create({ apiKey: svc.config.integrations.e2bKey, timeoutMs: 120_000 });
  const onAbort = () => void sbx.kill().catch(() => undefined);
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    const exec = await sbx.runCode(code, { language: language === 'javascript' ? 'js' : language, timeoutMs: 60_000 });
    return { stdout: exec.logs.stdout.join(''), stderr: exec.logs.stderr.join('') + (exec.error ? `\n${exec.error.name}: ${exec.error.value}` : ''), result: exec.text ?? '' };
  } finally {
    signal.removeEventListener('abort', onAbort);
    await sbx.kill().catch(() => undefined);
  }
}

function runDocker(language: string, code: string, signal: AbortSignal): Promise<{ stdout: string; stderr: string; result: string }> {
  const image = language === 'javascript' ? 'node:22-alpine' : 'python:3.12-alpine';
  const cmd = language === 'javascript' ? ['node', '-e', code] : language === 'bash' ? ['sh', '-c', code] : ['python', '-c', code];
  return new Promise((resolve, reject) => {
    const p = spawn('docker', ['run', '--rm', '--network', 'none', '--memory', '256m', '--cpus', '0.5', '--pids-limit', '64', '--read-only', image, ...cmd], { signal, timeout: 60_000 });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-20_000)));
    p.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-20_000)));
    p.on('error', reject);
    p.on('close', () => resolve({ stdout, stderr, result: '' }));
  });
}

async function runLocal(svc: AgentServices, owner: string, code: string, signal: AbortSignal) {
  const root = workspaceDir(svc, owner);
  const before = new Set(listFiles(root).map((f) => `${f.path}:${f.modifiedAt}`));
  const r = await runJsSandboxed(root, code, signal);
  const changed = listFiles(root).filter((f) => !before.has(`${f.path}:${f.modifiedAt}`));
  return { stdout: r.stdout, stderr: r.stderr, result: changed.length ? `Files written: ${changed.map((f) => f.path).join(', ')}` : '' };
}

export const runCodeTool = defineTool({
  name: 'run_code',
  description:
    'Run a snippet of code and return stdout/stderr. Use for calculations on data, testing snippets, or generating files. With the cloud sandbox (when the sandbox_run tool is available) python, javascript and bash all run on your sandbox computer in its work folder, files stay there between calls, and pip/npm installs work (use sandbox_run for those). Without a cloud sandbox only javascript is available (Node ES module; top-level await ok); it runs in the user\'s workspace folder, so files written with fs (or write_file) become artifacts the user can open. No npm packages.',
  schema: z.object({ language: z.enum(['python', 'javascript', 'bash']), code: z.string().min(1).max(50_000) }),
  label: (a) => `Running ${a.language}…`,
  needs: ({ services }) => codeSandboxNeeds(services),
  handler: async (a, ctx) => {
    const svc = ctx.services;
    const mode = svc.config.integrations.codeSandbox;
    if (mode === 'none' && a.language !== 'javascript') {
      return { ok: false, content: `Only javascript can run on this server (no cloud sandbox is set up). Rewrite the code in JavaScript (Node).`, summary: 'Only JavaScript here' };
    }
    if (mode === 'e2b' && svc.sandboxes) {
      const r = await runCodeInSandbox(ctx, a.language, a.code);
      const ok = r.exitCode === 0;
      return {
        ok,
        content: `exit code: ${r.exitCode ?? 'stopped'}\n\nstdout:\n${r.stdout.slice(-8000) || '(empty)'}\n\nstderr:\n${r.stderr.slice(-4000) || '(empty)'}`,
        summary: ok ? 'Code ran' : 'Ran with errors',
        display: { kind: 'code', stdout: r.stdout.slice(-4000), stderr: r.stderr.slice(-2000) },
      };
    }
    const out =
      mode === 'e2b'
        ? await runE2B(svc, a.language, a.code, ctx.signal)
        : mode === 'docker'
          ? await runDocker(a.language, a.code, ctx.signal)
          : await runLocal(svc, ctx.owner, a.code, ctx.signal);
    return {
      content: `stdout:\n${out.stdout.slice(0, 8000) || '(empty)'}\n\nstderr:\n${out.stderr.slice(0, 4000) || '(empty)'}${out.result ? `\n\nresult:\n${out.result.slice(0, 4000)}` : ''}`,
      summary: out.stderr ? 'Ran with errors' : 'Code ran',
      display: { kind: 'code', stdout: out.stdout.slice(0, 4000), stderr: out.stderr.slice(0, 2000) },
    };
  },
});

// ---------------- browser ----------------
export function browserNeeds(svc: AgentServices): string | null {
  const i = svc.config.integrations;
  if (!i.browserEnabled) return 'BROWSER_ENABLED=1 with Chromium installed';
  if (!hasPackage('playwright-core') && !hasPackage('playwright')) return 'npm install playwright-core (in server/)';
  return null;
}

const actionSchema = z.object({
  type: z.enum(['click', 'fill', 'press', 'wait', 'scroll']),
  selector: z.string().max(300).optional().describe('CSS selector or text=Visible text'),
  value: z.string().max(2000).optional().describe('Text to type, key to press, or ms to wait'),
});

export const browseTool = defineTool({
  name: 'browse',
  description: 'Open a page in a real headless browser (runs JavaScript), optionally perform actions (click, fill, press, wait, scroll), and return the visible text. Never submit payments or send messages without the user\'s explicit confirmation.',
  schema: z.object({ url: z.string().min(4).max(2000), actions: z.array(actionSchema).max(15).optional() }),
  label: () => 'Browsing…',
  needs: ({ services }) => browserNeeds(services),
  handler: async (a, ctx) => {
    await assertPublicUrl(a.url, ctx.services.lookup);
    const mod = await importOptional(hasPackage('playwright-core') ? 'playwright-core' : 'playwright');
    type Page = { goto(u: string, o?: object): Promise<unknown>; click(s: string, o?: object): Promise<void>; fill(s: string, v: string): Promise<void>; keyboard: { press(k: string): Promise<void> }; waitForTimeout(ms: number): Promise<void>; mouse: { wheel(x: number, y: number): Promise<void> }; title(): Promise<string>; url(): string; innerText(s: string): Promise<string> };
    const chromium = mod.chromium as { launch(o: object): Promise<{ newPage(): Promise<Page>; close(): Promise<void> }> };
    const exe = ctx.services.config.integrations.browserExecutable;
    const browser = await chromium.launch({ headless: true, ...(exe ? { executablePath: exe } : {}) });
    const onAbort = () => void browser.close().catch(() => undefined);
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    try {
      const page = await browser.newPage();
      await page.goto(a.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      for (const act of a.actions ?? []) {
        if (act.type === 'click' && act.selector) await page.click(act.selector, { timeout: 10_000 });
        else if (act.type === 'fill' && act.selector) await page.fill(act.selector, act.value ?? '');
        else if (act.type === 'press') await page.keyboard.press(act.value ?? 'Enter');
        else if (act.type === 'wait') await page.waitForTimeout(Math.min(Number(act.value) || 1000, 10_000));
        else if (act.type === 'scroll') await page.mouse.wheel(0, Number(act.value) || 1500);
      }
      const finalUrl = page.url();
      await assertPublicUrl(finalUrl, ctx.services.lookup);
      const title = await page.title();
      const text = (await page.innerText('body')).replace(/\n{3,}/g, '\n\n').slice(0, 12_000);
      return { content: `Title: ${title}\nURL: ${finalUrl}\n\n${text}`, summary: `Opened ${title || finalUrl}`.slice(0, 80), display: { kind: 'page', url: finalUrl, title: title || finalUrl } };
    } finally {
      ctx.signal.removeEventListener('abort', onAbort);
      await browser.close().catch(() => undefined);
    }
  },
});
