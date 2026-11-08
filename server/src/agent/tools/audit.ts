import { z } from 'zod';
import { commandRisk } from '../risk.js';
import { sandboxPath } from '../sandbox/types.js';
import { redactSecrets } from '../sandbox/secrets.js';
import { getSetting, setSetting } from '../sandbox/connections.js';
import type { AgentStore } from '../store.js';
import {
  AUDIT_MAX_ROUNDS,
  BLOCKER,
  classifyFailure,
  compareIntegrity,
  decide,
  parseScan,
  parseTestCounts,
  planChecks,
  runScript,
  scanScript,
  type Integrity,
  type PlannedCheck,
  type RunSummary,
  type Scan,
  type TestCounts,
  type Verdict,
} from '../auditCore.js';
import { defineTool, type ToolContext, type ToolResult } from './types.js';
import { hide, log, sandboxNeeds, short, withSandbox } from './sandbox.js';
import { failureLines, parseChecks } from './coding.js';

/**
 * code_audit: the engine of the Code Auditor skill. The parts a model must not do from memory:
 *  start:   detect the stack and the project's own commands, install what is missing, run every check,
 *           keep the results as the baseline plus a fingerprint of every test file
 *  recheck: run every check again (not just the one that failed) and compare with the baseline:
 *           fixed, still failing, regressions, test files changed. At most AUDIT_MAX_ROUNDS rounds.
 *  finish:  a fresh full run and a verdict only real results can give:
 *           READY | NOT_READY | BLOCKED | UNTESTED | NEEDS_REVIEW
 * Deleting, skipping or weakening a test, or changing the test command, blocks READY.
 */

interface AuditState {
  dir: string;
  startedAt: number;
  rounds: number;
  extra: string[];
  baseline: { scan: Scan; results: Record<string, number>; tests: number | null; failing: string[] };
  finished?: { at: number; verdict: Verdict };
}

const mem = new Map<string, AuditState>();
const memKey = (owner: string, dir: string) => `${owner}\u0000${dir}`;
const settingKey = (dir: string) => `code_audit:${dir}`;

function loadState(store: AgentStore, owner: string, dir: string): AuditState | null {
  const m = mem.get(memKey(owner, dir));
  if (m) return m;
  try {
    const s = getSetting<Partial<AuditState> | null>(store, owner, settingKey(dir), null);
    return s && s.baseline && s.dir === dir ? (s as AuditState) : null;
  } catch {
    return null;
  }
}

function saveState(store: AgentStore, owner: string, st: AuditState): void {
  mem.set(memKey(owner, st.dir), st);
  if (mem.size > 60) mem.delete(mem.keys().next().value as string);
  try {
    // the file list can be large; keep only what the comparison needs
    setSetting(store, owner, settingKey(st.dir), st);
  } catch {
    /* kept in memory only */
  }
}

/** tests only */
export function _resetAudits(): void {
  mem.clear();
}

const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, Math.floor(n * 0.25))}\n…[${t.length - n} characters cut]…\n${t.slice(-Math.ceil(n * 0.75))}`);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function scanProject(ctx: ToolContext, dir: string): Promise<Scan> {
  const r = await withSandbox(ctx, (s) => s.exec(scanScript(dir), { cwd: '/', timeoutMs: 120_000 }));
  return parseScan(r.stdout);
}

async function runPlan(ctx: ToolContext, dir: string, plan: PlannedCheck[]): Promise<RunSummary> {
  if (!plan.length) return { checks: [], plan, tests: null, counts: {} };
  const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(runScript(plan), { cwd: dir, timeoutMs: 14 * 60_000 })));
  const checks = parseChecks(r.stdout);
  const counts: Record<string, TestCounts | null> = {};
  let tests: number | null = null;
  for (const c of checks) {
    if (plan.find((x) => x.name === c.name)?.kind !== 'test') continue;
    const n = parseTestCounts(c.out);
    counts[c.name] = n;
    if (n) tests = (tests ?? 0) + n.passed + n.failed + n.skipped;
  }
  return { checks, plan, tests, counts };
}

function table(run: RunSummary, before?: Record<string, number>): string {
  return run.checks
    .map((c) => {
      const st = c.code === 0 ? 'PASS' : c.code === 124 ? 'TIMEOUT' : 'FAIL';
      let was = '';
      if (before && c.name in before) {
        if (before[c.name] === 0 && c.code !== 0) was = '  (REGRESSION: passed at the start)';
        else if (before[c.name] !== 0 && c.code === 0) was = '  (fixed)';
      }
      const n = run.counts[c.name];
      const cnt = n ? `  [${n.passed} passed${n.failed ? `, ${n.failed} failed` : ''}${n.skipped ? `, ${n.skipped} skipped` : ''}]` : '';
      const from = run.plan.find((p) => p.name === c.name)?.from;
      const cmd = c.cmd.length > 90 ? `${c.cmd.slice(0, 89)}…` : c.cmd;
      return `${st}  ${c.name}  (${c.secs}s)${cnt}${was}  $ ${cmd}${from ? `   (from ${from})` : ''}`;
    })
    .join('\n');
}

function failureDetail(run: RunSummary): string {
  return run.checks
    .filter((c) => c.code !== 0)
    .map((c) => {
      const cause = classifyFailure(c);
      return `--- ${c.name} failed (exit ${c.code}${cause !== 'code' ? `, looks like: ${cause.replace('_', ' ')}` : ''})\n${clip(failureLines(c.out, 60), 3500)}`;
    })
    .join('\n\n');
}

const resultsOf = (run: RunSummary) => Object.fromEntries(run.checks.map((c) => [c.name, c.code]));

/** one line in the computer log and the task's Activity, never in the chat */
function note(ctx: ToolContext, text: string, ok = true): void {
  try {
    log(ctx, 'command', text, ok);
  } catch {
    /* log is a nicety */
  }
  if (ctx.taskId) {
    try {
      ctx.services.store.addTaskEvent(ctx.taskId, 'note', text);
    } catch {
      /* Activity line is a nicety */
    }
  }
}

function integrityText(i: Integrity): string {
  const parts: string[] = [];
  if (i.violations) {
    const rows = [...i.deleted.map((d) => `- deleted: ${d}`), ...i.weakened.map((w) => `- weakened: ${w}`), ...i.skipsAdded.map((s) => `- skipped: ${s}`), ...i.commandsChanged.map((c) => `- ${c}`), ...(i.fewerTests ? [`- ${i.fewerTests}`] : [])];
    parts.push(`TEST INTEGRITY PROBLEMS (these block READY):\n${rows.join('\n')}`);
  }
  if (i.modified.length) parts.push(`Test files edited: ${i.modified.slice(0, 15).join(', ')}`);
  if (i.added.length) parts.push(`Test files added: ${i.added.slice(0, 15).join(', ')}`);
  if (i.changed.length) parts.push(`Files changed since the start: ${i.changed.slice(0, 30).join(', ')}${i.changed.length > 30 ? ` (+${i.changed.length - 30} more)` : ''}`);
  return parts.join('\n');
}

function stackLine(scan: Scan, plan: PlannedCheck[]): string {
  const stack: string[] = [];
  if (scan.has.includes('package.json')) stack.push(scan.has.includes('tsconfig.json') ? 'Node/TypeScript' : 'Node/JavaScript');
  if (scan.has.some((f) => ['pyproject.toml', 'requirements.txt', 'setup.py'].includes(f)) || scan.pyTests) stack.push('Python');
  if (scan.has.includes('go.mod')) stack.push('Go');
  if (scan.has.includes('Cargo.toml')) stack.push('Rust');
  const fw = ['react', 'vite', 'next', 'express', 'fastify', 'hono', 'vue', 'svelte', 'expo', 'react-native', 'jest', 'vitest', 'mocha', 'playwright'].filter((d) => scan.deps.includes(d));
  return `Stack: ${stack.join(' + ') || 'unknown'}${fw.length ? ` (${fw.join(', ')})` : ''}${scan.git ? `, git ${scan.git}` : ''}; ${plural(Object.keys(scan.files).length, 'file')}, ${plural(Object.keys(scan.tests).length, 'test file')}.\nChecks: ${plan.map((p) => `${p.name} (${p.from})`).join(', ') || 'none found'}.`;
}

const blockedNoComputer = (msg: string): ToolResult => ({
  ok: false,
  content: `VERDICT: BLOCKED\nThe computer could not be reached: ${msg}\nNothing was checked, so nothing is ready. Tell the user the audit could not run and that a working computer is needed (AI setup → Sandboxes: a cloud one, or the local phone sandbox running with its tunnel up).`,
  summary: 'Blocked: computer unreachable',
});

export const codeAuditTool = defineTool({
  name: 'code_audit',
  description:
    'The Code Auditor: audit a project on your computer and only call it ready when real checks say so. ' +
    '"start" detects the stack and the project\'s own commands (package.json scripts, tsconfig, pytest, go, cargo, Makefile, README), installs missing dependencies, runs every check and records the baseline and a fingerprint of the tests. ' +
    `"recheck" (after each round of fixes) runs every check again and compares with the baseline: fixed, still failing, regressions, tests changed; at most ${AUDIT_MAX_ROUNDS} rounds. ` +
    '"finish" runs everything fresh and gives the verdict: READY, NOT_READY, BLOCKED (needs the user: a login, key, network or service), UNTESTED (no tests) or NEEDS_REVIEW (a test was changed, with your reason). ' +
    'Fix the code, never the tests: deleting, skipping or weakening a test or changing the test command blocks READY. Use it before you call a build or a fix ready, and report its verdict as it is.',
  schema: z.object({
    action: z.enum(['start', 'recheck', 'finish']),
    path: z.string().max(300).optional().describe('project folder on your computer (default the working folder)'),
    extra_commands: z.array(z.string().min(2).max(300)).max(4).optional().describe('start only: more check commands the user or the docs ask for, e.g. "npm run e2e"'),
    test_change_reason: z.string().max(400).optional().describe('finish only: why a test had to change because the test itself was wrong; the user then reviews it'),
  }),
  label: (a) => (a.action === 'start' ? 'Auditing the code…' : a.action === 'recheck' ? 'Rechecking the fixes…' : 'Final check…'),
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  timeoutMs: 16 * 60_000,
  approval: (a) => {
    const risky = (a.extra_commands ?? []).map((c) => ({ c, why: commandRisk(c) })).find((x) => x.why);
    return risky ? { title: 'Run an audit check', headline: short(risky.c, 120), body: `This check ${risky.why}.`, content: risky.c, fields: [{ label: 'Runs in', value: sandboxPath(a.path) }] } : null;
  },
  handler: async (a, ctx): Promise<ToolResult> => {
    const dir = sandboxPath(a.path);
    const store = ctx.services.store;
    let scan: Scan;
    try {
      scan = await scanProject(ctx, dir);
    } catch (e) {
      note(ctx, 'Code audit blocked: computer unreachable', false);
      return blockedNoComputer((e as Error)?.message ?? String(e));
    }
    if (!scan.exists) return { ok: false, content: `There is no folder ${dir} on the computer. Find the project first (sandbox_list_files), or bring it here (git_clone or the uploaded files).`, summary: 'Project not found' };

    try {
      let st = loadState(store, ctx.owner, dir);

      // ---------- start (or a recheck/finish with no baseline: this run becomes the baseline)
      if (a.action === 'start' || !st) {
        const extra = a.extra_commands ?? st?.extra ?? [];
        const plan = planChecks(scan, { extra, pyInstall: true });
        const run = await runPlan(ctx, dir, plan);
        const after = plan.some((p) => p.kind === 'install') ? await scanProject(ctx, dir).catch(() => scan) : scan;
        const failing = run.checks.filter((c) => c.code !== 0).map((c) => c.name);
        st = { dir, startedAt: Date.now(), rounds: 0, extra, baseline: { scan: after, results: resultsOf(run), tests: run.tests, failing } };
        saveState(store, ctx.owner, st);
        const head = `${dir}\n${stackLine(after, plan)}`;
        if (a.action !== 'finish') {
          if (!run.checks.length) {
            note(ctx, 'Code audit: no checks found', false);
            return { ok: true, content: `${head}\n\nNo tests, type check, lint or build found. Add automated tests for the important behaviour (node --test, vitest or pytest) and a "test" script, then code_audit recheck. If you cannot, finish will say UNTESTED.`, summary: 'No checks found' };
          }
          const blocked = run.checks.filter((c) => c.code !== 0 && BLOCKER[classifyFailure(c)]);
          note(ctx, failing.length ? `Code audit baseline: ${failing.length} of ${run.checks.length} checks failing (${failing.join(', ')})` : `Code audit baseline: all ${run.checks.length} checks pass`, !failing.length);
          const next = !failing.length
            ? 'Everything passes already. If you are changing code, make the change, then recheck; otherwise call finish.'
            : blocked.length === failing.length
              ? 'Every failure looks like something only the user can fix (see "looks like"). Read the lines to confirm; if so, call finish and report BLOCKED with what the user must do. Do not work around it in a way that hides it.'
              : `Fix the cause of each failure in the source code (read the failing lines and the code they point to; never edit, skip or delete a test to make it pass), then code_audit recheck. Rounds: ${AUDIT_MAX_ROUNDS}.`;
          const intro = a.action === 'recheck' ? 'No audit was started for this folder (or it was lost), so this run is the baseline.\n' : '';
          return {
            ok: true,
            content: `${head}\n\n${intro}BASELINE (${run.tests !== null ? `${plural(run.tests, 'test')} counted` : 'test count not printed'})\n${table(run)}\n\n${failing.length ? failureDetail(run) : 'All checks pass.'}\n\nNext: ${next}`,
            summary: failing.length ? `Baseline: ${failing.length} of ${run.checks.length} failing` : `Baseline: all ${run.checks.length} pass`,
            display: { kind: 'code', stdout: redactSecrets(ctx.owner, table(run)), stderr: failing.length ? redactSecrets(ctx.owner, clip(failureDetail(run), 2000)) : '' },
          };
        }
      }

      const state = st;
      if (a.action === 'recheck' && state.rounds >= AUDIT_MAX_ROUNDS) {
        note(ctx, `Code audit: round limit (${AUDIT_MAX_ROUNDS}) reached`, false);
        return { ok: false, content: `Round limit reached: ${AUDIT_MAX_ROUNDS} rechecks already. Stop fixing and call code_audit finish; it reports what still fails so the user can decide.`, summary: 'Round limit reached' };
      }

      // ---------- recheck / finish: a fresh full run compared with the baseline
      const reqChanged = scan.files['requirements.txt'] !== state.baseline.scan.files['requirements.txt'];
      const plan = planChecks(scan, { extra: state.extra, pyInstall: reqChanged });
      const run = await runPlan(ctx, dir, plan);
      const nowScan = plan.some((p) => p.kind === 'install') ? await scanProject(ctx, dir).catch(() => scan) : scan;
      const failing = run.checks.filter((c) => c.code !== 0);
      // "fewer tests ran" only means something on a passing run: a test file that crashes counts as one test
      const testsPassed = run.checks.every((c) => c.code === 0 || run.plan.find((p) => p.name === c.name)?.kind !== 'test');
      const integ = compareIntegrity(state.baseline.scan, nowScan, state.baseline.tests, testsPassed ? run.tests : null);
      const regress = failing.filter((c) => state.baseline.results[c.name] === 0).map((c) => c.name);
      const fixed = run.checks.filter((c) => c.code === 0 && state.baseline.results[c.name] !== undefined && state.baseline.results[c.name] !== 0).map((c) => c.name);
      const dropped = Object.keys(state.baseline.results).filter((n) => !run.checks.some((c) => c.name === n) && !/install/.test(n));
      if (dropped.length) integ.commandsChanged.push(`checks that ran at the start no longer exist: ${dropped.join(', ')}`), (integ.violations += 1);
      const it = integrityText(integ);

      if (a.action === 'recheck') {
        state.rounds++;
        saveState(store, ctx.owner, state);
        note(ctx, `Code audit round ${state.rounds}: ${failing.length ? `${failing.length} of ${run.checks.length} failing` : `all ${run.checks.length} pass`}${regress.length ? `, regression in ${regress.join(', ')}` : ''}`, !failing.length);
        const left = AUDIT_MAX_ROUNDS - state.rounds;
        const next = integ.violations
          ? 'Put the tests listed above back the way they were and fix the code instead, then recheck.'
          : failing.length
            ? left > 0
              ? `Fix what still fails${regress.length ? ' (start with the regressions: a change broke something that worked)' : ''}, then recheck (${plural(left, 'round')} left). If a failure survived two different fixes, step back: re-read the error and the code, check the docs.`
              : 'No rounds left: call code_audit finish.'
            : 'Everything passes. Call code_audit finish for the verdict.';
        return {
          ok: true,
          content: [`${dir}  round ${state.rounds} of ${AUDIT_MAX_ROUNDS}`, table(run, state.baseline.results), '', fixed.length ? `Fixed since the start: ${fixed.join(', ')}` : '', regress.length ? `REGRESSIONS: ${regress.join(', ')}` : '', it, failing.length ? `\n${failureDetail(run)}` : '', '', `Next: ${next}`].filter((l, i, arr) => l !== '' || (i > 0 && arr[i - 1] !== '')).join('\n'),
          summary: failing.length ? `${failing.length} of ${run.checks.length} still failing` : `All ${run.checks.length} pass`,
          display: { kind: 'code', stdout: redactSecrets(ctx.owner, table(run, state.baseline.results)), stderr: failing.length ? redactSecrets(ctx.owner, clip(failureDetail(run), 2000)) : '' },
        };
      }

      // ---------- finish
      const { verdict, why } = decide(run, integ, a.test_change_reason);
      state.finished = { at: Date.now(), verdict };
      saveState(store, ctx.owner, state);
      const counts = Object.values(run.counts);
      const passed = counts.reduce((n, c) => n + (c?.passed ?? 0), 0);
      const skipped = counts.reduce((n, c) => n + (c?.skipped ?? 0), 0);
      const testsLine = run.tests !== null ? `Tests: ${passed} of ${run.tests} passed${skipped ? ` (${skipped} skipped)` : ''}.` : 'Tests: the test runner did not print a count.';
      const baseN = Object.keys(state.baseline.results).length;
      const startLine = `At the start: ${state.baseline.failing.length ? `${state.baseline.failing.length} of ${baseN} checks failed (${state.baseline.failing.join(', ')})` : baseN ? 'every check passed' : 'no checks'}; ${plural(state.rounds, 'recheck round')}.`;
      note(ctx, `Code audit verdict: ${verdict.replace('_', ' ')}${failing.length ? ` (${failing.map((c) => c.name).join(', ')} failing)` : ''}`, verdict === 'READY');
      const report = [
        `VERDICT: ${verdict}`,
        ...why.map((w) => `- ${w}`),
        '',
        dir,
        table(run, state.baseline.results),
        '',
        testsLine,
        startLine,
        fixed.length ? `Fixed during the audit: ${fixed.join(', ')}.` : '',
        regress.length ? `Regressions (passed at the start, fail now): ${regress.join(', ')}.` : '',
        it,
        failing.length ? `\n${failureDetail(run)}` : '',
        '',
        'Not covered by this audit: deployment, a real phone or device, and anything outside the checks above (using the UI by hand). Do not claim those were checked.',
        verdict === 'READY'
          ? 'Report READY with the checks and test numbers above and what you fixed.'
          : `Report this verdict as it is (${verdict}). Do not call the build ready or working. Say what still fails or blocks, and what the user can do.`,
      ]
        .filter((l) => l !== '')
        .join('\n');
      return {
        ok: verdict === 'READY',
        content: report,
        summary: verdict === 'READY' ? `Ready: all ${run.checks.length} checks pass` : { NOT_READY: 'Not ready', BLOCKED: 'Blocked', UNTESTED: 'Untested', NEEDS_REVIEW: 'Needs your review' }[verdict],
        display: { kind: 'code', stdout: redactSecrets(ctx.owner, `VERDICT: ${verdict}\n${table(run, state.baseline.results)}`), stderr: redactSecrets(ctx.owner, failing.length ? clip(failureDetail(run), 2000) : why.join('\n')) },
      };
    } catch (e) {
      note(ctx, 'Code audit blocked: computer stopped answering', false);
      return blockedNoComputer((e as Error)?.message ?? String(e));
    }
  },
});
