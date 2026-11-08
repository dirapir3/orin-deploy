import { commandRisk } from './risk.js';
import { shq } from './sandbox/types.js';
import type { CheckResult } from './tools/coding.js';

/**
 * The pure half of the Code Auditor (no sandbox, no store): scanning a project, choosing its checks,
 * reading test counts, telling a code bug from a blocker, the test-integrity guard and the verdict.
 * tools/audit.ts runs these against the user's computer.
 */

export const AUDIT_MAX_ROUNDS = 6;
const MAX_FILES = 2500;
const SKIP_DIRS = ['node_modules', '.git', 'dist', 'build', 'out', '.next', '.nuxt', '.expo', '.venv', 'venv', '__pycache__', '.pytest_cache', 'target', 'coverage', '.turbo', '.cache', 'android', 'ios', '.gradle'];

export type CheckKind = 'install' | 'typecheck' | 'lint' | 'test' | 'build' | 'doc' | 'extra';
export interface PlannedCheck {
  name: string;
  cmd: string;
  kind: CheckKind;
  /** where the command came from, in words */
  from: string;
}

export interface TestStat {
  cases: number;
  asserts: number;
  skips: number;
}

export interface Scan {
  exists: boolean;
  has: string[];
  git: string | null;
  tools: string[];
  scripts: Record<string, string>;
  deps: string[];
  makeTargets: string[];
  docs: string[];
  /** path -> "crc size" for project files (dependency and build folders left out) */
  files: Record<string, string>;
  tests: Record<string, TestStat>;
  pyTests: boolean;
  jsTests: boolean;
}

// ------------------------------------------------------------------ scanning

const CASE_RE = String.raw`(^|[^a-zA-Z_.])(it|test)(\.each\([^)]*\))?[[:space:]]*\(|def test_|func Test|#\[test\]`;
const ASSERT_RE = String.raw`expect[[:space:]]*\(|assert|\.should[.(]|t\.(equal|deepEqual|strictEqual|ok|is|true|false|throws|match)[[:space:]]*\(|t\.(Error|Fatal)|panic!`;
const SKIP_RE = String.raw`\.(skip|todo|only)[[:space:]]*\(|(^|[^a-zA-Z_])x(it|describe|test)[[:space:]]*\(|pytest\.mark\.(skip|xfail)|pytest\.skip|unittest\.skip|t\.Skip|#\[ignore\]|skip:[[:space:]]*true`;
const DOC_RE = String.raw`^[[:space:]]*(\$ )?((npm|pnpm|yarn)( run)? (test|lint|typecheck|check|build)[^&;|<>#]*|npx (tsc|vitest|jest|eslint|mocha)[^&;|<>#]*|make (test|check|lint)[^&;|<>#]*|(python3? -m )?pytest[^&;|<>#]*|go (test|vet) [^&;|<>#]*|cargo (test|clippy)[^&;|<>#]*|ruff check[^&;|<>#]*|mypy [^&;|<>#]*)[[:space:]]*$`;

export function scanScript(dir: string): string {
  const prune = SKIP_DIRS.map((d) => `-name ${shq(d)}`).join(' -o ');
  return String.raw`
set +e
cd ${shq(dir)} 2>/dev/null || { echo "<<<MISSING"; exit 0; }
for f in package.json package-lock.json pnpm-lock.yaml yarn.lock tsconfig.json pyproject.toml requirements.txt setup.py setup.cfg pytest.ini tox.ini go.mod Cargo.toml Makefile README.md CONTRIBUTING.md AGENTS.md ruff.toml .ruff.toml; do [ -e "$f" ] && echo "<<<HAS $f"; done
[ -d node_modules ] && echo "<<<HAS node_modules"
for t in node npm python3 go cargo ruff make git; do command -v $t >/dev/null 2>&1 && echo "<<<TOOL $t"; done
[ -d .git ] && echo "<<<GIT $(git rev-parse --short HEAD 2>/dev/null || echo none)"
if [ -f package.json ] && command -v node >/dev/null 2>&1; then
  echo "<<<PKG $(node -e 'try{const p=require("./package.json");console.log(JSON.stringify({scripts:p.scripts||{},deps:Object.keys(Object.assign({},p.dependencies,p.devDependencies))}))}catch(e){console.log("{}")}' 2>/dev/null)"
fi
[ -f Makefile ] && grep -oE '^(test|check|lint|typecheck)[A-Za-z0-9_-]*:' Makefile | tr -d ':' | head -3 | sed 's/^/<<<MAKE /'
for f in README.md CONTRIBUTING.md AGENTS.md; do [ -f "$f" ] && cat "$f"; done 2>/dev/null | grep -oE ${shq(DOC_RE)} | sed -E 's/^[[:space:]]*(\$ )?//; s/[[:space:]]+$//' | sort -u | head -12 | sed 's/^/<<<DOC /'
find . \( ${prune} \) -prune -o -type f -size -3000k -print 2>/dev/null | head -${MAX_FILES} | tr '\n' '\0' | xargs -0 cksum 2>/dev/null | sed 's/^/<<<F /'
find . \( ${prune} \) -prune -o -type f \( -path '*/test/*' -o -path '*/tests/*' -o -path '*/__tests__/*' -o -name '*.test.*' -o -name '*.spec.*' -o -name 'test_*.py' -o -name '*_test.py' -o -name '*_test.go' \) -print 2>/dev/null | grep -E '\.(m?[jt]sx?|cjs|py|go|rs)$' | head -400 | while IFS= read -r f; do
  c=$(grep -cE ${shq(CASE_RE)} "$f" 2>/dev/null); [ -n "$c" ] || c=0
  a=$(grep -cE ${shq(ASSERT_RE)} "$f" 2>/dev/null); [ -n "$a" ] || a=0
  s=$(grep -cE ${shq(SKIP_RE)} "$f" 2>/dev/null); [ -n "$s" ] || s=0
  echo "<<<T $c|$a|$s|$f"
done
true
`;
}

export function parseScan(stdout: string): Scan {
  const scan: Scan = { exists: !/^<<<MISSING$/m.test(stdout), has: [], git: null, tools: [], scripts: {}, deps: [], makeTargets: [], docs: [], files: {}, tests: {}, pyTests: false, jsTests: false };
  for (const line of stdout.split('\n')) {
    let m: RegExpExecArray | null;
    if ((m = /^<<<HAS (.+)$/.exec(line))) scan.has.push(m[1]!.trim());
    else if ((m = /^<<<TOOL (\S+)$/.exec(line))) scan.tools.push(m[1]!);
    else if ((m = /^<<<GIT (\S+)$/.exec(line))) scan.git = m[1] === 'none' ? null : m[1]!;
    else if ((m = /^<<<PKG (.*)$/.exec(line))) {
      try {
        const p = JSON.parse(m[1]!) as { scripts?: Record<string, string>; deps?: string[] };
        scan.scripts = p.scripts ?? {};
        scan.deps = p.deps ?? [];
      } catch {
        /* unreadable package.json: no scripts */
      }
    } else if ((m = /^<<<MAKE (\S+)$/.exec(line))) scan.makeTargets.push(m[1]!);
    else if ((m = /^<<<DOC (.+)$/.exec(line))) scan.docs.push(m[1]!.trim());
    else if ((m = /^<<<F (\d+) (\d+) \.\/(.+)$/.exec(line))) scan.files[m[3]!] = `${m[1]} ${m[2]}`;
    else if ((m = /^<<<T (\d+)\|(\d+)\|(\d+)\|\.\/(.+)$/.exec(line))) scan.tests[m[4]!] = { cases: Number(m[1]), asserts: Number(m[2]), skips: Number(m[3]) };
  }
  const paths = Object.keys(scan.tests);
  scan.pyTests = paths.some((p) => p.endsWith('.py'));
  scan.jsTests = paths.some((p) => /\.(m?js|cjs)$/.test(p));
  return scan;
}

// ------------------------------------------------------------------ which checks

const norm = (cmd: string) =>
  cmd
    .replace(/^CI=1 /, '')
    .replace(/ --silent$/, '')
    .replace(/^(pnpm|yarn)( run)? /, 'npm run ')
    .replace(/^npm (test|t)$/, 'npm run test')
    .replace(/^npm (test|t) /, 'npm run test ')
    .replace(/^python3? -m pytest/, 'pytest')
    .replace(/\s+/g, ' ')
    .trim();

// a fresh bytecode cache: a fix written in the same second with the same size would otherwise run the old .pyc
const PYTEST =
  'export PYTHONPYCACHEPREFIX="$(mktemp -d)"; python3 -m pytest -q --maxfail=25 -p no:cacheprovider; c=$?; if [ $c -gt 1 ] && ! python3 -c "import pytest" 2>/dev/null; then python3 -m pip install -q pytest >/dev/null 2>&1 && python3 -m pytest -q --maxfail=25 -p no:cacheprovider; c=$?; fi; exit $c';

/** The checks for this project: its own scripts, config, Makefile and README commands, plus any extra commands. */
export function planChecks(scan: Scan, opts: { extra?: string[]; pyInstall?: boolean } = {}): PlannedCheck[] {
  const out: PlannedCheck[] = [];
  const has = (f: string) => scan.has.includes(f);
  const covered = new Set<string>();
  const add = (c: PlannedCheck) => {
    if (out.some((x) => x.name === c.name)) return;
    out.push(c);
    covered.add(norm(c.cmd));
  };
  if (has('package.json')) {
    if (!has('node_modules') && (scan.deps.length || Object.keys(scan.scripts).length)) {
      const cmd = has('pnpm-lock.yaml')
        ? 'npx --yes pnpm@9 install --frozen-lockfile'
        : has('yarn.lock')
          ? 'npx --yes yarn@1 install --frozen-lockfile --silent'
          : has('package-lock.json')
            ? 'npm ci --no-audit --no-fund --loglevel=error'
            : 'npm install --no-audit --no-fund --loglevel=error';
      if (scan.deps.length) add({ name: 'install', cmd, kind: 'install', from: 'dependencies not installed yet' });
    }
    const s = scan.scripts;
    const real = (k: string) => typeof s[k] === 'string' && s[k]!.trim() !== '' && !/no test specified/.test(s[k]!);
    for (const k of ['typecheck', 'lint', 'test', 'build'] as const) {
      if (real(k)) add({ name: k, cmd: `CI=1 npm run ${k} --silent`, kind: k, from: `package.json "${k}" script` });
    }
    if (!real('typecheck') && real('check') && !/\btest\b/.test(s.check!)) add({ name: 'typecheck', cmd: 'CI=1 npm run check --silent', kind: 'typecheck', from: 'package.json "check" script' });
    if (!out.some((c) => c.kind === 'typecheck') && has('tsconfig.json') && scan.deps.includes('typescript')) add({ name: 'typecheck', cmd: 'npx --no-install tsc --noEmit -p .', kind: 'typecheck', from: 'tsconfig.json' });
    if (!real('test') && scan.jsTests) add({ name: 'test', cmd: 'node --test', kind: 'test', from: 'test files (node --test)' });
  }
  if (has('pyproject.toml') || has('requirements.txt') || has('setup.py') || scan.pyTests) {
    if (has('requirements.txt') && opts.pyInstall) add({ name: 'pip-install', cmd: 'python3 -m pip install -q -r requirements.txt', kind: 'install', from: 'requirements.txt' });
    if (scan.pyTests) add({ name: 'pytest', cmd: PYTEST, kind: 'test', from: 'test_*.py files (pytest)' });
    covered.add('pytest');
    if (scan.tools.includes('ruff') && (has('ruff.toml') || has('.ruff.toml'))) add({ name: 'ruff', cmd: 'ruff check .', kind: 'lint', from: 'ruff.toml' });
  }
  if (has('go.mod')) {
    add({ name: 'go-vet', cmd: 'go vet ./...', kind: 'lint', from: 'go.mod' });
    add({ name: 'go-test', cmd: 'go test ./...', kind: 'test', from: 'go.mod' });
  }
  if (has('Cargo.toml')) add({ name: 'cargo-test', cmd: 'cargo test -q', kind: 'test', from: 'Cargo.toml' });
  if (has('Makefile') && scan.tools.includes('make')) {
    for (const t of scan.makeTargets.slice(0, 2)) add({ name: `make-${t}`, cmd: `make ${t}`, kind: /test|check/.test(t) ? 'test' : 'lint', from: 'Makefile' });
  }
  const isTest = (c: string) => /\b(test|pytest|vitest|jest|mocha)\b/.test(c);
  let docs = 0;
  for (const d of scan.docs) {
    if (docs >= 3) break;
    if (covered.has(norm(d)) || commandRisk(d) || /[|;&<>`$]/.test(d) || /\b(dev|start|serve|watch|deploy|publish)\b|--watch/.test(d)) continue;
    docs++;
    add({ name: `doc-${docs}`, cmd: d, kind: isTest(d) ? 'test' : 'doc', from: 'README' });
  }
  (opts.extra ?? []).slice(0, 4).forEach((cmd, i) => add({ name: `extra-${i + 1}`, cmd, kind: isTest(cmd) ? 'test' : 'extra', from: 'asked for in this audit' }));
  return out;
}

export function runScript(checks: PlannedCheck[]): string {
  return String.raw`
set +e
run() { name="$1"; shift; start=$(date +%s); out=$( (timeout "$T" bash -lc "$*") 2>&1 ); code=$?; secs=$(( $(date +%s) - start ));
  echo "<<<CHECK $name|$code|$secs|$*"; printf '%s\n' "$out" | tail -c 7000; echo ">>>"; }
[ -n "$T" ] || T=300
${checks.map((c) => `run ${shq(c.name)} ${shq(c.cmd)}`).join('\n')}
true
`;
}

// ------------------------------------------------------------------ results

export interface TestCounts {
  passed: number;
  failed: number;
  skipped: number;
}

/** How many tests ran, from node --test, vitest, jest, pytest, mocha, go or cargo output. null when it does not say. */
export function parseTestCounts(raw: string): TestCounts | null {
  const t = raw.replace(/\x1b\[[0-9;]*m/g, '');
  const last = (re: RegExp): number | null => {
    const all = [...t.matchAll(re)];
    return all.length ? Number(all[all.length - 1]![1]) : null;
  };
  const np = last(/^(?:#|ℹ) pass (\d+)/gm);
  if (np !== null) return { passed: np, failed: last(/^(?:#|ℹ) fail (\d+)/gm) ?? 0, skipped: (last(/^(?:#|ℹ) skipped (\d+)/gm) ?? 0) + (last(/^(?:#|ℹ) todo (\d+)/gm) ?? 0) };
  const cargo = [...t.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  if (cargo.length) return cargo.reduce((a, m) => ({ passed: a.passed + Number(m[1]), failed: a.failed + Number(m[2]), skipped: a.skipped + Number(m[3]) }), { passed: 0, failed: 0, skipped: 0 });
  const jestLine = [...t.matchAll(/^\s*Tests:?\s+(.*\d+ (?:passed|failed).*)$/gm)].pop()?.[1];
  const pyLine = [...t.matchAll(/^[=\s]*(\d+ (?:passed|failed)[^\n]*?)(?: in [\d.]+s)?[=\s]*$/gm)].pop()?.[1];
  const src = jestLine ?? pyLine;
  if (src) {
    const num = (re: RegExp) => Number(re.exec(src)?.[1] ?? 0);
    const r = { passed: num(/(\d+) passed/), failed: num(/(\d+) failed/) + num(/(\d+) errors?\b/), skipped: num(/(\d+) skipped/) + num(/(\d+) (?:todo|pending|xfailed|deselected)/) };
    if (r.passed || r.failed || r.skipped) return r;
  }
  const mp = last(/^\s*(\d+) passing/gm);
  if (mp !== null) return { passed: mp, failed: last(/^\s*(\d+) failing/gm) ?? 0, skipped: last(/^\s*(\d+) pending/gm) ?? 0 };
  const goOk = (t.match(/^(ok|FAIL)\s+\S+\s+[\d.]+s/gm) ?? []).length;
  if (goOk) {
    const passed = (t.match(/^--- PASS/gm) ?? []).length;
    const failed = (t.match(/^--- FAIL/gm) ?? []).length;
    if (passed || failed) return { passed, failed, skipped: (t.match(/^--- SKIP/gm) ?? []).length };
  }
  if (/^(no tests ran|collected 0 items)/m.test(t) || /No test files found/i.test(t)) return { passed: 0, failed: 0, skipped: 0 };
  return null;
}

export type FailureCause = 'code' | 'timeout' | 'crash' | 'network' | 'credential' | 'service' | 'missing_tool';

/** Why a check failed: a bug to fix in code, or something only the user can unblock. */
export function classifyFailure(c: Pick<CheckResult, 'code' | 'out'>): FailureCause {
  const o = c.out;
  if (c.code === 124) return 'timeout';
  // killed by a signal (out of memory, a segfault in the runtime): the check never finished
  if (c.code === 134 || c.code === 135 || c.code === 137 || c.code === 139) return 'crash';
  if (/\b(ENOTFOUND|EAI_AGAIN|getaddrinfo|ENETUNREACH)\b|Could not resolve host|Temporary failure in name resolution|Network is unreachable|Failed to establish a new connection|request to \S+ failed, reason/i.test(o)) return 'network';
  if (
    /\bE40[13]\b|\b40[13] (Unauthorized|Forbidden)\b|authentication (required|failed)|Permission denied \(publickey\)|invalid api key|no credentials|missing (required )?(env|environment)( variable)?|environment variable[^\n]{0,60}(not set|missing|required|undefined)|\b[A-Z][A-Z0-9_]*(API_KEY|TOKEN|SECRET|PASSWORD|DATABASE_URL)\b[^\n]{0,40}(is )?(not set|missing|required|undefined)/i.test(o)
  )
    return 'credential';
  if (/ECONNREFUSED[^\n]*:(5432|3306|27017|6379|5672|9200|1433)\b|could not connect to server|Connection refused[^\n]*(postgres|mysql|redis|mongo)/i.test(o)) return 'service';
  if (c.code === 127 || /(^|: )(node|npm|npx|python3|pytest|go|cargo|make|ruff): (command )?not found/m.test(o)) return 'missing_tool';
  return 'code';
}

export const BLOCKER: Record<FailureCause, string | null> = {
  code: null,
  timeout: null,
  crash: null,
  network: 'needs internet access this computer does not have (a download or a site could not be reached)',
  credential: 'needs a login, key or setting only you can give (a missing key, token or environment variable)',
  service: 'needs a database or service running that is not there',
  missing_tool: 'needs a program that is not installed on this computer',
};

// ------------------------------------------------------------------ test integrity

export interface Integrity {
  deleted: string[];
  weakened: string[];
  skipsAdded: string[];
  commandsChanged: string[];
  fewerTests: string | null;
  modified: string[];
  added: string[];
  /** non-test files changed during the audit */
  changed: string[];
  violations: number;
}

export function compareIntegrity(base: Scan, now: Scan, baseTests: number | null, nowTests: number | null): Integrity {
  const deleted: string[] = [];
  const weakened: string[] = [];
  const skipsAdded: string[] = [];
  const modified: string[] = [];
  for (const [p, b] of Object.entries(base.tests)) {
    const n = now.tests[p];
    if (!n) {
      deleted.push(p);
      continue;
    }
    if (n.cases < b.cases || n.asserts < b.asserts) weakened.push(`${p} (tests ${b.cases}→${n.cases}, assertions ${b.asserts}→${n.asserts})`);
    if (n.skips > b.skips) skipsAdded.push(`${p} (skip/only/todo markers ${b.skips}→${n.skips})`);
    if (base.files[p] && now.files[p] && base.files[p] !== now.files[p]) modified.push(p);
  }
  const added = Object.keys(now.tests).filter((p) => !base.tests[p]);
  const commandsChanged: string[] = [];
  for (const k of ['test', 'typecheck', 'lint', 'build']) {
    const b = base.scripts[k];
    const n = now.scripts[k];
    if (b && b.trim() && !/no test specified/.test(b) && b !== n) commandsChanged.push(`package.json "${k}" was "${b}", now ${n === undefined ? 'removed' : `"${n}"`}`);
  }
  const fewerTests = baseTests !== null && nowTests !== null && nowTests < baseTests ? `${baseTests} tests ran at the start, ${nowTests} now` : null;
  const isTest = (p: string) => p in base.tests || p in now.tests;
  const changed = [...new Set([...Object.keys(base.files), ...Object.keys(now.files)])]
    .filter((p) => !isTest(p) && base.files[p] !== now.files[p])
    .map((p) => (!(p in base.files) ? `${p} (new)` : !(p in now.files) ? `${p} (deleted)` : p));
  return { deleted, weakened, skipsAdded, commandsChanged, fewerTests, modified, added, changed, violations: deleted.length + weakened.length + skipsAdded.length + commandsChanged.length + (fewerTests ? 1 : 0) };
}

// ------------------------------------------------------------------ verdict

export type Verdict = 'READY' | 'NOT_READY' | 'BLOCKED' | 'UNTESTED' | 'NEEDS_REVIEW';

export interface RunSummary {
  checks: CheckResult[];
  plan: PlannedCheck[];
  tests: number | null;
  counts: Record<string, TestCounts | null>;
}

export function decide(final: RunSummary, integrity: Integrity | null, testChangeReason?: string): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  const kind = (name: string) => final.plan.find((p) => p.name === name)?.kind ?? 'extra';
  if (!final.checks.length) return { verdict: 'UNTESTED', why: ['No tests, type check, lint or build were found to run in this project.'] };
  const failed = final.checks.filter((c) => c.code !== 0);
  if (failed.length) {
    const bugs: string[] = [];
    for (const c of failed) {
      const b = BLOCKER[classifyFailure(c)];
      if (b) why.push(`${c.name} ${b}.`);
      else bugs.push(c.name);
    }
    for (const n of bugs) {
      const cause = classifyFailure(final.checks.find((c) => c.name === n)!);
      why.push(`${n} still fails${cause === 'timeout' ? ' (ran past the time limit)' : cause === 'crash' ? ' (the process crashed before it finished, e.g. out of memory; rerun to see if it was the computer)' : ''}.`);
    }
    return { verdict: bugs.length ? 'NOT_READY' : 'BLOCKED', why };
  }
  if (integrity && integrity.violations) {
    for (const d of integrity.deleted) why.push(`Test file deleted: ${d}.`);
    for (const w of integrity.weakened) why.push(`Tests or assertions removed: ${w}.`);
    for (const s of integrity.skipsAdded) why.push(`Tests skipped or narrowed: ${s}.`);
    for (const c of integrity.commandsChanged) why.push(`Check command changed: ${c}.`);
    if (integrity.fewerTests) why.push(`Fewer tests ran: ${integrity.fewerTests}.`);
    if (testChangeReason && testChangeReason.trim()) {
      why.push(`Reason given: ${testChangeReason.trim()}`);
      return { verdict: 'NEEDS_REVIEW', why };
    }
    why.push('A pass after weakening tests does not count. Put the tests back and fix the code.');
    return { verdict: 'NOT_READY', why };
  }
  const testChecks = final.checks.filter((c) => kind(c.name) === 'test');
  if (!testChecks.length) return { verdict: 'UNTESTED', why: ['Every check passed, but the project has no automated tests, so nothing shows it behaves correctly.'] };
  const ran = testChecks.filter((c) => !final.counts[c.name] || final.counts[c.name]!.passed > 0);
  if (!ran.length) return { verdict: 'UNTESTED', why: [`The test command ran but no test passed (${testChecks.map((c) => c.name).join(', ')} found 0 tests).`] };
  return { verdict: 'READY', why: ['Every check passed on a fresh full run, with no tests removed or weakened.'] };
}
