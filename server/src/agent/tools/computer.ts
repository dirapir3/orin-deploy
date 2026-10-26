import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { commandRisk } from '../risk.js';
import { defineTool, type ToolContext } from './types.js';
import { SANDBOX_WORKDIR, sandboxPath, shq, type SandboxSession } from '../sandbox/index.js';
import { holdSecret, redactSecrets, resolveSecrets, secretsSchema } from '../sandbox/secrets.js';
import { BROWSER_PY, BROWSER_PY_VERSION } from '../sandbox/browserScript.js';
import { revealLogin } from '../vault.js';
import { hide, log, sandboxNeeds, secretNetRisk, short, withSandbox } from './sandbox.js';

/**
 * Orin's computer, the parts that make it work like a full workstation:
 *  - sandbox_edit_file: exact find-and-replace edits
 *  - sandbox_job: long builds and scripts in the background (Android/Gradle builds, big installs)
 *  - sandbox_browser: a real Chromium with page scripts, vault sign-ins and send-type holds
 *  - sandbox_live_view: a link where the user watches and uses that browser
 */

const STATE = '/home/user/.orin';

// ------------------------------------------------------------------ edit file

export const sandboxEditFileTool = defineTool({
  name: 'sandbox_edit_file',
  description: `Edit a text file on your computer with exact replacements: each edit swaps "old" (text that appears in the file exactly once, unless replace_all) for "new". All edits apply together or none do. Relative paths are inside ${SANDBOX_WORKDIR}. For a whole new file use sandbox_write_file.`,
  schema: z.object({
    path: z.string().min(1).max(300),
    edits: z.array(z.object({ old: z.string().min(1).max(200_000), new: z.string().max(200_000), replace_all: z.boolean().optional() })).min(1).max(50),
  }),
  label: (a) => `Editing ${short(a.path, 40)}…`,
  needs: ({ services }) => sandboxNeeds(services),
  handler: async (a, ctx) => {
    const p = sandboxPath(a.path);
    return withSandbox(ctx, async (s) => {
      let text = Buffer.from(await s.readFile(p)).toString('utf8');
      for (const [i, e] of a.edits.entries()) {
        const n = text.split(e.old).length - 1;
        if (n === 0) return { ok: false, content: `Edit ${i + 1}: the "old" text is not in ${p}. Nothing was changed. Read the file again and copy the text exactly.`, summary: 'Edit not applied' };
        if (n > 1 && !e.replace_all) return { ok: false, content: `Edit ${i + 1}: the "old" text appears ${n} times in ${p}. Add more surrounding text or set replace_all. Nothing was changed.`, summary: 'Edit not applied' };
        text = e.replace_all ? text.split(e.old).join(e.new) : text.replace(e.old, () => e.new);
      }
      await s.writeFile(p, text);
      log(ctx, 'file', `Edited ${p.replace(`${SANDBOX_WORKDIR}/`, '')}`);
      return { content: `Edited ${p}: ${a.edits.length} change${a.edits.length === 1 ? '' : 's'} applied.`, summary: `Edited ${p.split('/').pop()}` };
    });
  },
});

// ------------------------------------------------------------------ background jobs

const JOBS = `${STATE}/jobs`;
const jobId = () => `job-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}-${randomBytes(2).toString('hex')}`;

export const sandboxJobTool = defineTool({
  name: 'sandbox_job',
  description:
    'Run a long command in the background on your computer and check on it: Android/Gradle builds (they take 10 to 30 minutes), big installs, test suites, data jobs. action start runs the command and returns a job id at once; its whole output goes to a log file. action status shows whether it is still running, its exit code and the last lines of the log; check every few minutes until it finishes. action stop ends it, action list shows jobs. To build an Expo or React Native app into an Android APK, start the job `orin-android-build <project-folder>`: it installs packages, runs expo prebuild when there is no android folder, builds with settings sized for this machine (about 7 to 15 minutes the first time) and prints the APK path; then hand the APK to the user with sandbox_save on that one file. ' +
    'Your computer lives at most about an hour, so a long job starts on a fresh computer when the current one has little time left: put every step the job needs in the command (cd into the project, npm install, then the build). Files outside node_modules and build folders are restored on the fresh computer.',
  schema: z.object({
    action: z.enum(['start', 'status', 'stop', 'list']),
    command: z.string().max(20_000).optional().describe('start: the shell command (bash)'),
    cwd: z.string().max(300).optional().describe(`start: folder to run in, relative to ${SANDBOX_WORKDIR}`),
    id: z.string().max(60).optional().describe('status/stop: the job id from start (default: the latest job)'),
    lines: z.number().int().min(5).max(400).optional().describe('status: how many log lines to show (default 40)'),
    secrets: secretsSchema,
  }),
  label: (a) => (a.action === 'start' ? `Starting ${short(a.command ?? '', 40)}…` : a.action === 'status' ? 'Checking the job…' : a.action === 'stop' ? 'Stopping the job…' : 'Listing jobs…'),
  needs: ({ services }) => sandboxNeeds(services),
  timeoutMs: 180_000,
  approval: (a) => {
    if (a.action !== 'start' || !a.command) return null;
    const why = commandRisk(a.command) ?? (a.secrets?.length ? secretNetRisk(a.command) : null);
    return why
      ? { title: 'Run a background job that reaches outside', headline: short(a.command, 120), body: `Orin wants to run this on her computer in the background. It ${why}.`, content: a.command, fields: [{ label: 'Runs in', value: sandboxPath(a.cwd) }] }
      : null;
  },
  handler: async (a, ctx) => {
    const m = ctx.services.sandboxes!;
    if (a.action === 'start') {
      if (!a.command?.trim()) return { ok: false, content: 'start needs a command.', summary: 'No command' };
      const left = m.remainingMs(ctx.owner);
      let fresh = '';
      if (left !== null && left < 40 * 60_000) {
        await m.close(ctx.owner, 'a long job needs a fresh computer');
        fresh = ' It started on a fresh computer (the last one had little time left); your files were restored, without node_modules and build folders.';
      }
      const id = jobId();
      const cwd = sandboxPath(a.cwd);
      const { envs } = resolveSecrets(ctx, a.secrets);
      const base = `${JOBS}/${id}`;
      const wrapper = `mkdir -p ${JOBS}; echo $$ > ${base}.pid; cd ${shq(cwd)} && bash -lc "$ORIN_JOB_CMD" > ${base}.log 2>&1; echo $? > ${base}.exit`;
      await withSandbox(ctx, async (s) => {
        await s.writeFile(`${base}.cmd`, `${cwd}\n${a.command}`);
        await s.execBackground(`setsid bash -c ${shq(wrapper)}`, { cwd: '/', envs: { ...envs, ORIN_JOB_CMD: a.command! } });
      });
      m.markJob(ctx.owner);
      log(ctx, 'command', `Background job ${id}: ${short(a.command)}`);
      return { content: `Started job ${id} in ${cwd}.${fresh}\nLog: ${base}.log\nCheck it with sandbox_job action status (every few minutes for a build).`, summary: `Started ${id}` };
    }
    if (a.action === 'list') {
      const r = await withSandbox(ctx, (s) => s.exec(`cd ${JOBS} 2>/dev/null && for f in $(ls -t *.cmd 2>/dev/null | head -20); do j=\${f%.cmd}; st=running; [ -e $j.exit ] && st="exit $(cat $j.exit)"; echo "$j | $st | $(sed -n 2p $f | cut -c1-100)"; done`, { cwd: '/', timeoutMs: 30_000 }));
      return { content: r.stdout.trim() || 'No background jobs on this computer.', summary: 'Listed jobs' };
    }
    const id = a.id?.replace(/[^\w-]/g, '') || '$(ls -t *.cmd 2>/dev/null | head -1 | sed s/.cmd$//)';
    if (a.action === 'stop') {
      const r = await withSandbox(ctx, (s) => s.exec(`cd ${JOBS} 2>/dev/null || exit 3; j=${id}; [ -e $j.pid ] || exit 4; kill -TERM -- -$(cat $j.pid) 2>/dev/null || kill $(cat $j.pid) 2>/dev/null; sleep 1; [ -e $j.exit ] || echo 143 > $j.exit; echo $j`, { cwd: '/', timeoutMs: 30_000 }));
      return r.exitCode === 0 ? { content: `Stopped ${r.stdout.trim()}.`, summary: 'Stopped job' } : { ok: false, content: 'No such job on this computer (it may have been on an earlier computer).', summary: 'No such job' };
    }
    const n = a.lines ?? 40;
    const r = hide(
      ctx.owner,
      await withSandbox(ctx, (s) =>
        s.exec(`cd ${JOBS} 2>/dev/null || exit 3; j=${id}; [ -e $j.cmd ] || exit 4; echo "JOB $j"; if [ -e $j.exit ]; then echo "STATE finished, exit code $(cat $j.exit)"; else echo "STATE running for $(( ($(date +%s) - $(stat -c %Y $j.pid 2>/dev/null || stat -c %Y $j.cmd)) / 60 )) min"; fi; echo "LOG ${JOBS}/$j.log ($(wc -l < $j.log 2>/dev/null || echo 0) lines)"; echo ---; tail -n ${n} $j.log 2>/dev/null | cut -c1-400`, { cwd: '/', timeoutMs: 30_000 }),
      ),
    );
    if (r.exitCode !== 0) return { ok: false, content: 'No such job on this computer. Jobs from an earlier computer are gone (it lives about an hour); start it again.', summary: 'No such job' };
    const done = /STATE finished, exit code (\d+)/.exec(r.stdout);
    return { ok: !done || done[1] === '0', content: r.stdout, summary: done ? (done[1] === '0' ? 'Job finished' : `Job failed (exit ${done[1]})`) : 'Job running' };
  },
});

// ------------------------------------------------------------------ browser

const installed = new WeakMap<SandboxSession, string>();
const SCRIPT = `${STATE}/orin_browser.py`;

async function ensureScript(s: SandboxSession) {
  if (installed.get(s) === BROWSER_PY_VERSION) return;
  await s.writeFile(SCRIPT, BROWSER_PY);
  installed.set(s, BROWSER_PY_VERSION);
}

type El = { ref: number; tag: string; name: string; type?: string; href?: string; value?: string; filled?: boolean; form?: boolean; offscreen?: boolean };
interface PageResult {
  ok: boolean;
  error?: string;
  held?: boolean;
  control?: string;
  url?: string;
  title?: string;
  text?: string;
  more?: string;
  note?: string;
  elements?: El[];
  tabs?: number | { n: number; url: string; title: string }[];
  screenshot?: string;
  password?: string;
  stopped?: boolean;
}

/** The last page each owner saw, so an approval card can name the page and the control. */
const lastPage = new Map<string, { url: string; elements: El[] }>();

async function runBrowser(ctx: ToolContext, act: Record<string, unknown>, envs: Record<string, string> = {}): Promise<PageResult> {
  return withSandbox(ctx, async (s) => {
    await ensureScript(s);
    const r = await s.exec(`python3 ${SCRIPT}`, { cwd: '/home/user', timeoutMs: 150_000, signal: ctx.signal, envs: { ...envs, ORIN_ACT: JSON.stringify(act) } });
    const out = r.stdout.trim().split('\n').pop() ?? '';
    try {
      return JSON.parse(out) as PageResult;
    } catch {
      return { ok: false, error: `The browser did not answer (${short(r.stderr || r.stdout || 'no output', 300)}).` };
    }
  });
}

function elLine(e: El): string {
  const bits = [`[${e.ref}]`, e.type && e.tag === 'input' ? `input:${e.type}` : e.tag, e.name ? `"${e.name}"` : ''];
  if (e.href && e.tag === 'a') bits.push(`-> ${e.href}`);
  if (e.value) bits.push(`value="${e.value}"`);
  if (e.type === 'password') bits.push(e.filled ? '(filled)' : '(empty)');
  if (e.offscreen) bits.push('(below/above)');
  return bits.filter(Boolean).join(' ');
}

function formatPage(owner: string, r: PageResult): string {
  if (!r.ok && !r.url) return r.error ?? 'The browser failed.';
  const parts = [`URL: ${r.url}`, `Title: ${r.title ?? ''}`];
  if (r.note) parts.push(`Note: ${r.note}`);
  if (r.error) parts.push(`Note: ${r.error}`);
  if (typeof r.tabs === 'number' && r.tabs > 1) parts.push(`Open tabs: ${r.tabs}`);
  if (r.screenshot) parts.push(`Screenshot saved: ${r.screenshot} (send it with sandbox_save)`);
  parts.push('', 'Page text:', r.text ?? '');
  if (r.more) parts.push(`…(${r.more})`);
  if (r.elements?.length) parts.push('', 'Elements (use the number as ref):', ...r.elements.map(elLine));
  return redactSecrets(owner, parts.join('\n'));
}

const browserActions = ['open', 'click', 'type', 'select', 'press', 'scroll', 'back', 'forward', 'reload', 'wait', 'read', 'screenshot', 'tabs', 'tab', 'close'] as const;

export const sandboxBrowserTool = defineTool({
  name: 'sandbox_browser',
  description:
    'Your real web browser (Chromium) on your computer. It runs page scripts, keeps cookies and sign-ins between calls, and the user can watch and use it live (sandbox_live_view). ' +
    'open a URL, then work the page with the numbered elements each result lists: click {ref}, type {ref, text} (enter true to press Enter after), select {ref, value}, press {key}, scroll {direction}, read {offset} for more text, screenshot (saved to a file), tabs / tab {n}, back, reload, wait, close. ' +
    'To sign in, type with login (the Secure Vault entry name) and field username or password instead of text; the value is typed for you, never shown, and only on the domain the login is saved for. ' +
    'A click or Enter that sends, submits, posts, buys, books, pays or deletes something is refused the first time: call it again with confirm true and the user is asked to approve it. ' +
    'For a code, a captcha or a step only the user can do, give them the live view and ask them (ask_user_step) to do it there.',
  schema: z.object({
    action: z.enum(browserActions),
    url: z.string().max(2000).optional(),
    ref: z.number().int().min(1).max(500).optional().describe('element number from the last result'),
    text: z.string().max(5000).optional().describe('type: the text; click: visible text when there is no ref'),
    login: z.string().max(120).optional().describe('type: Secure Vault entry to type from (instead of text)'),
    field: z.enum(['username', 'password']).optional().describe('type with login: which part to type'),
    enter: z.boolean().optional(),
    value: z.string().max(300).optional().describe('select: the option text'),
    key: z.string().max(40).optional().describe('press: e.g. Enter, Tab, Escape, ArrowDown'),
    direction: z.enum(['up', 'down', 'top', 'bottom']).optional(),
    offset: z.number().int().min(0).optional(),
    seconds: z.number().min(0.5).max(20).optional(),
    n: z.number().int().min(1).max(20).optional().describe('tab: which tab'),
    full_page: z.boolean().optional(),
    confirm: z.boolean().optional().describe('true to press a send/submit/buy/delete-type control after it was refused; the user approves it first'),
  }),
  label: (a) => (a.action === 'open' ? `Opening ${short(a.url ?? '', 40)}…` : a.action === 'type' && a.login ? 'Signing in…' : `Browser: ${a.action}…`),
  needs: ({ services }) => sandboxNeeds(services),
  timeoutMs: 170_000,
  approval: (a, ctx) => {
    if (!a.confirm || !['click', 'press', 'type'].includes(a.action)) return null;
    const page = lastPage.get(ctx.owner);
    const el = a.ref ? page?.elements.find((e) => e.ref === a.ref) : undefined;
    const control = el?.name || a.text || (a.action === 'press' ? `the ${a.key ?? 'Enter'} key` : 'the button');
    let host = '';
    try {
      host = page?.url ? new URL(page.url).host : '';
    } catch {}
    const filled = (page?.elements ?? []).filter((e) => e.value || e.filled).slice(0, 12);
    return {
      title: `Press "${short(control, 60)}"${host ? ` on ${host}` : ''}`,
      headline: page?.url ?? '',
      body: 'Orin wants to press a control in her browser that sends, submits, buys, books or deletes something.',
      fields: [{ label: 'Page', value: page?.url ?? 'unknown' }, ...filled.map((e) => ({ label: e.name || e.tag, value: e.type === 'password' ? '(hidden)' : e.value ?? '' }))],
    };
  },
  handler: async (a, ctx) => {
    if (a.action === 'close') {
      await runBrowser(ctx, { action: 'stop' });
      lastPage.delete(ctx.owner);
      return { content: 'Closed the browser (cookies and sign-ins stay in its profile on this computer).', summary: 'Closed browser' };
    }
    const act: Record<string, unknown> = { action: a.action };
    for (const k of ['url', 'ref', 'text', 'enter', 'value', 'key', 'direction', 'offset', 'seconds', 'n', 'full_page', 'confirm'] as const) if (a[k] !== undefined) act[k] = a[k];
    const envs: Record<string, string> = {};
    if (a.action === 'type' && a.login) {
      const row = ctx.services.store.findVault(ctx.owner.split('#')[0]!, a.login);
      if (!row) return { ok: false, content: `No Secure Vault entry named "${a.login}". Ask the user for the login with ask_secret, then try again.`, summary: 'No such login' };
      const { username, password } = revealLogin(row);
      const value = a.field === 'username' ? username : password;
      if (!value) return { ok: false, content: `The "${a.login}" entry has no ${a.field ?? 'password'} saved.`, summary: 'Login incomplete' };
      if (a.field !== 'username') holdSecret(ctx.owner, a.login, value);
      envs.ORIN_SECRET = value;
      act.text_env = 'ORIN_SECRET';
      act.domain = row.domain;
      delete act.text;
    }
    if (a.action === 'click' && a.ref === undefined && !a.text) return { ok: false, content: 'click needs ref (the element number) or text.', summary: 'Nothing to click' };
    const t0 = Date.now();
    const r = await runBrowser(ctx, act, envs);
    if (r.url) lastPage.set(ctx.owner, { url: r.url, elements: r.elements ?? [] });
    if (a.action === 'tabs' && Array.isArray(r.tabs)) return { content: r.tabs.map((t) => `${t.n}. ${t.title} — ${t.url}`).join('\n'), summary: `${r.tabs.length} tabs` };
    const ok = r.ok && !r.held;
    log(ctx, 'command', `Browser ${a.action}${a.url ? ` ${short(a.url, 60)}` : ''}`, ok || !!r.held, Date.now() - t0);
    if (r.held && !r.url) return { ok: false, content: `${r.error} (control: "${r.control}")`, summary: 'Needs confirm' };
    return {
      ok: ok || !!r.held,
      content: formatPage(ctx.owner, r),
      summary: r.held ? 'Needs confirm' : r.ok ? short(r.title || r.url || 'Browser', 60) : 'Browser step failed',
      display: a.action === 'open' && r.url ? { kind: 'page', url: r.url, title: r.title || r.url } : undefined,
    };
  },
});

// ------------------------------------------------------------------ live view

export const sandboxLiveViewTool = defineTool({
  name: 'sandbox_live_view',
  description:
    "Get a link where the user watches your computer's screen live and can use it (tap, type, scroll): your browser runs there. Give it when they want to see what you're doing, or when a step needs them (a code, a captcha, a payment card); the link works while your computer is on.",
  schema: z.object({}),
  label: () => 'Opening the live view…',
  needs: ({ services }) => sandboxNeeds(services),
  timeoutMs: 120_000,
  handler: async (_a, ctx) => {
    const r = await runBrowser(ctx, { action: 'live' });
    if (!r.ok || !r.password) return { ok: false, content: r.error ?? 'The live view did not start.', summary: 'Live view failed' };
    const base = await withSandbox(ctx, async (s) => (s.publicUrl ? s.publicUrl(6080) : ''));
    if (!base) return { ok: false, content: 'The live view needs the cloud computer (E2B).', summary: 'No live view' };
    const url = `${base.replace(/\/$/, '')}/vnc.html?autoconnect=1&resize=scale&reconnect=1&show_dot=1&password=${encodeURIComponent(r.password)}`;
    log(ctx, 'command', 'Opened the live view');
    return {
      content: `Live view: ${url}\nIt shows your screen (the browser opens there once you use sandbox_browser) and works while your computer is on. Give the user this link as it is.`,
      summary: 'Live view ready',
      display: { kind: 'page', url, title: 'Live view of Orin’s computer' },
    };
  },
});
