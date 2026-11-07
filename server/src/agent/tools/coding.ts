import { z } from 'zod';
import { sandboxPath, shq, SANDBOX_WORKDIR } from '../sandbox/index.js';
import { redactSecrets } from '../sandbox/secrets.js';
import { defineTool } from './types.js';
import { hide, log, sandboxNeeds, short, withSandbox } from './sandbox.js';
import { TEMPLATES, type TemplateId } from './codeTemplates.js';

/**
 * Tools that make Orin fast and careful at code on her computer (any sandbox: E2B, Daytona or the
 * user's own phone sandbox):
 *  - sandbox_write_files: a whole set of files in one step (a new project is one call, not twenty)
 *  - code_map: the shape of a project and where things are (files, stack, scripts, a code search)
 *  - run_checks: every test, type check, lint and build the project has, with a pass/fail table
 *  - scaffold_project: a known-good starting project with tests already passing
 */

const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, Math.floor(n * 0.25))}\n…[${t.length - n} characters cut]…\n${t.slice(-Math.ceil(n * 0.75))}`);

// ------------------------------------------------------------------ write many files

export const sandboxWriteFilesTool = defineTool({
  name: 'sandbox_write_files',
  description: `Create or overwrite several text files on your sandbox computer in one step (folders are created). Use it to write a new project or a change that touches many files at once instead of one sandbox_write_file call per file. Relative paths are inside ${SANDBOX_WORKDIR}, or inside "dir" when given. Up to 40 files and about 400 KB per call; for one small change to an existing file use sandbox_edit_file.`,
  schema: z.object({
    dir: z.string().max(300).optional().describe('project folder the paths are relative to, e.g. "todo-app"'),
    files: z
      .array(z.object({ path: z.string().min(1).max(300), content: z.string().max(400_000) }))
      .min(1)
      .max(40),
  }),
  label: (a) => `Writing ${a.files.length} file${a.files.length === 1 ? '' : 's'}…`,
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  handler: async (a, ctx) => {
    const total = a.files.reduce((n, f) => n + Buffer.byteLength(f.content), 0);
    if (total > 1_200_000) return { ok: false, content: `That is ${Math.round(total / 1000)} KB in one call; split it into calls of about 400 KB.`, summary: 'Too much at once' };
    const base = a.dir ? sandboxPath(a.dir) : SANDBOX_WORKDIR;
    const paths = a.files.map((f) => (f.path.startsWith('/') || f.path.startsWith('~') ? sandboxPath(f.path) : `${base}/${f.path.replace(/^\.\//, '')}`));
    const done: string[] = [];
    const failed: string[] = [];
    await withSandbox(ctx, async (s) => {
      // a few at a time: fast on cloud sandboxes, gentle on a phone
      for (let i = 0; i < paths.length; i += 6) {
        const batch = paths.slice(i, i + 6);
        const results = await Promise.allSettled(batch.map((p, j) => s.writeFile(p, a.files[i + j]!.content)));
        results.forEach((r, j) => (r.status === 'fulfilled' ? done.push(batch[j]!) : failed.push(`${batch[j]}: ${(r.reason as Error)?.message ?? r.reason}`)));
      }
    });
    log(ctx, 'file', `Wrote ${done.length} file${done.length === 1 ? '' : 's'}${a.dir ? ` in ${a.dir}` : ''}`);
    const rel = (p: string) => p.replace(`${base}/`, '');
    return {
      ok: failed.length === 0,
      content: `Wrote ${done.length} file${done.length === 1 ? '' : 's'} in ${base} (${total} bytes): ${done.map(rel).join(', ')}${failed.length ? `\nFailed:\n- ${failed.join('\n- ')}` : ''}`,
      summary: failed.length ? `${failed.length} of ${paths.length} failed` : `Wrote ${done.length} files`,
    };
  },
});

// ------------------------------------------------------------------ project map + search

const MAP_SH = (q: string, glob: string) => `
set +e
lsf() { find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/dist/*' -not -path '*/build/*' -not -path '*/.next/*' -not -path '*/.expo/*' -not -path '*/__pycache__/*' -not -path '*/.venv/*' -not -path '*/venv/*' -not -path '*/coverage/*' -not -path '*/.gradle/*' 2>/dev/null | sed 's#^./##' | sort; }
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  echo "## git: branch $(git branch --show-current 2>/dev/null), $(git status --porcelain 2>/dev/null | wc -l) changed file(s), last commit: $(git log -1 --format='%h %s' 2>/dev/null)"
  FILES=$(git ls-files --cached --others --exclude-standard 2>/dev/null | grep -vE '(^|/)(node_modules|dist|build)/')
else
  FILES=$(lsf)
fi
N=$(printf '%s\n' "$FILES" | grep -c .)
echo "## $N files"
echo "## stack"
[ -f package.json ] && node -e 'const p=require("./package.json");const d={...p.dependencies,...p.devDependencies};const k=Object.keys(d);const pick=["react","react-native","expo","next","vue","svelte","vite","express","fastify","hono","typescript","vitest","jest","mocha","playwright","tailwindcss","prisma","@capacitor/core","eslint"].filter(x=>k.includes(x)).map(x=>x+"@"+d[x]);console.log("node:",p.name||"",p.type==="module"?"(ESM)":"",pick.join(" "));console.log("scripts:",JSON.stringify(p.scripts||{}))' 2>/dev/null
[ -f package-lock.json ] && echo "lock: npm"; [ -f pnpm-lock.yaml ] && echo "lock: pnpm"; [ -f yarn.lock ] && echo "lock: yarn"; [ -f bun.lockb ] && echo "lock: bun"
[ -d node_modules ] && echo "node_modules: installed" || { [ -f package.json ] && echo "node_modules: NOT installed (run npm install)"; }
for f in pyproject.toml requirements.txt go.mod Cargo.toml pom.xml build.gradle app.json capacitor.config.ts capacitor.config.json tsconfig.json vite.config.ts vite.config.js Dockerfile render.yaml vercel.json netlify.toml .env.example README.md AGENTS.md HANDOFF.md CLAUDE.md; do [ -f "$f" ] && printf '%s ' "$f"; done; echo
echo "## files (lines)"
printf '%s\n' "$FILES" | grep -vE '\\.(png|jpe?g|gif|webp|ico|svg|woff2?|ttf|otf|mp[34]|zip|jar|lock|map)$|package-lock.json' | head -${'$'}{MAXF:-250} | while read -r f; do [ -f "$f" ] && printf '%6s  %s\n' "$(wc -l < "$f" 2>/dev/null)" "$f"; done
[ "$N" -gt 250 ] && echo "… $((N-250)) more (pass a smaller path, or a query)"
${q ? `echo "## search: ${q.replace(/["`$\\]/g, '')}"
if command -v rg >/dev/null; then rg -n -S --max-columns 220 --max-count 8 ${glob ? `-g ${shq(glob)}` : ''} -g '!node_modules' -g '!dist' -g '!*.lock' -g '!package-lock.json' -e ${shq(q)} . 2>/dev/null | head -120
else grep -rnI ${glob ? `--include=${shq(glob)}` : ''} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=dist -e ${shq(q)} . 2>/dev/null | cut -c1-220 | head -120; fi` : ''}
`;

export const codeMapTool = defineTool({
  name: 'code_map',
  description:
    'See the shape of a project on your computer before you change it: git state, stack and versions, package scripts, whether dependencies are installed, key files (README, HANDOFF, configs), and every source file with its line count. ' +
    'With query, also searches the code (ripgrep regex, case-smart) and returns matching lines with file:line, so you can jump straight to where something is defined or used. Use it first on any existing project, after cloning a repo or unpacking a ZIP, and whenever you need to find code.',
  schema: z.object({
    path: z.string().max(300).optional().describe(`project folder (default ${SANDBOX_WORKDIR})`),
    query: z.string().max(200).optional().describe('regex to search for, e.g. "function addTodo|addTodo\\("'),
    glob: z.string().max(80).optional().describe('limit the search to files like "*.ts" or "src/**"'),
  }),
  label: (a) => (a.query ? `Searching the code for ${short(a.query, 30)}…` : 'Mapping the project…'),
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  handler: async (a, ctx) => {
    const dir = sandboxPath(a.path);
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(MAP_SH(a.query ?? '', a.glob ?? ''), { cwd: dir, timeoutMs: 60_000 })));
    const out = r.stdout.trim();
    if (!out && r.stderr) return { ok: false, content: `Could not map ${dir}: ${clip(r.stderr, 1500)}`, summary: 'No such folder?' };
    const hits = a.query ? (out.split('## search:')[1] ?? '').trim().split('\n').filter(Boolean).length - 0 : 0;
    return {
      content: `${dir}\n${clip(out, 14_000)}`,
      summary: a.query ? `${hits ? hits - 1 : 0} match${hits === 2 ? '' : 'es'}` : `Mapped ${dir.split('/').pop()}`,
    };
  },
});

// ------------------------------------------------------------------ run every check

const CHECKS_SH = (only: string) => `
set +e
run() { name="$1"; shift; start=$(date +%s); out=$( (timeout ${'$'}{T:-300} bash -lc "$*") 2>&1 ); code=$?; secs=$(( $(date +%s) - start ));
  echo "<<<CHECK $name|$code|$secs|$*"; printf '%s\n' "$out" | tail -c 6000; echo ">>>"; }
want() { [ -z "${only}" ] || echo "${only}" | grep -qw "$1"; }
if [ -f package.json ]; then
  [ -d node_modules ] || { want install && run install "npm install --no-audit --no-fund --loglevel=error"; }
  S=$(node -e 'const s=require("./package.json").scripts||{};for(const k of ["typecheck","lint","test","build"]) if(s[k] && !/no test specified/.test(s[k])) console.log(k)' 2>/dev/null)
  for k in $S; do want $k && run $k "CI=1 npm run $k --silent"; done
  echo "$S" | grep -qw typecheck || { [ -f tsconfig.json ] && want typecheck && run typecheck "npx --no-install tsc --noEmit -p ."; }
  echo "$S" | grep -qw test || { ls test tests __tests__ 2>/dev/null | grep -qE '\\.(m?js)$' && want test && run test "node --test"; }
fi
if [ -f pyproject.toml ] || [ -f requirements.txt ] || ls *.py >/dev/null 2>&1; then
  if ls tests test_*.py */test_*.py >/dev/null 2>&1; then want test && run pytest "python3 -m pytest -q -x 2>&1 || (python3 -m pip install -q pytest >/dev/null 2>&1 && python3 -m pytest -q -x)"; fi
  want lint && command -v ruff >/dev/null && run ruff "ruff check ."
fi
[ -f go.mod ] && want test && run go-test "go test ./..."
[ -f Cargo.toml ] && want test && run cargo-test "cargo test -q"
true
`;

export interface CheckResult {
  name: string;
  code: number;
  secs: number;
  cmd: string;
  out: string;
}

export function parseChecks(stdout: string): CheckResult[] {
  const out: CheckResult[] = [];
  const re = /<<<CHECK ([^|\n]+)\|(-?\d+)\|(\d+)\|([^\n]*)\n([\s\S]*?)\n?>>>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout))) out.push({ name: m[1]!, code: Number(m[2]), secs: Number(m[3]), cmd: m[4]!, out: m[5]! });
  return out;
}

/** the lines of a failing check that say what failed (assertion, error, file:line) */
export function failureLines(out: string, n = 40): string {
  const lines = out.split('\n');
  const keep = lines.filter((l) => /(error|fail|✖|×|not ok|assert|expected|received|exception|traceback|cannot|undefined|TS\d{4}|:\d+:\d+)/i.test(l));
  return (keep.length ? keep : lines).slice(-n).join('\n');
}

export const runChecksTool = defineTool({
  name: 'run_checks',
  description:
    'Run every check a project has, the way CI would: installs dependencies if missing, then the type check, lint, tests and build (from package.json scripts, tsconfig, node --test, pytest, go test or cargo test). Returns a pass/fail line per check with the failing lines. ' +
    'Use it after every change and always before you say code works; fix what fails and run it again until everything passes.',
  schema: z.object({
    path: z.string().max(300).optional().describe(`project folder (default ${SANDBOX_WORKDIR})`),
    only: z.array(z.enum(['install', 'typecheck', 'lint', 'test', 'build'])).max(5).optional().describe('run just these checks'),
  }),
  label: () => 'Running the checks…',
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  timeoutMs: 15 * 60_000,
  handler: async (a, ctx) => {
    const dir = sandboxPath(a.path);
    const only = (a.only ?? []).join(' ');
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(CHECKS_SH(only), { cwd: dir, timeoutMs: 14 * 60_000 })));
    const checks = parseChecks(r.stdout);
    if (!checks.length) {
      return {
        ok: false,
        content: `No checks found in ${dir}: no test/lint/build scripts, no tsconfig, no test files.${r.stderr ? `\n${clip(r.stderr, 1000)}` : ''} Add tests (node --test, vitest or pytest) and a "test" script, then run this again.`,
        summary: 'No checks found',
      };
    }
    const failed = checks.filter((c) => c.code !== 0);
    const counted = checks.filter((c) => c.name !== 'install').length || checks.length;
    const table = checks.map((c) => `${c.code === 0 ? 'PASS' : c.code === 124 ? 'TIMEOUT' : 'FAIL'}  ${c.name}  (${c.secs}s)  $ ${c.cmd}`).join('\n');
    const passTail = checks
      .filter((c) => c.code === 0 && c.name !== 'install')
      .map((c) => {
        const t = c.out.trim().split('\n').filter((l) => /pass|fail|tests?|ok|✓|built|error/i.test(l)).slice(-4).join('\n');
        return t ? `--- ${c.name}\n${t}` : '';
      })
      .filter(Boolean)
      .join('\n');
    const detail = failed.map((c) => `--- ${c.name} failed (exit ${c.code})\n${clip(failureLines(c.out), 3500)}`).join('\n\n');
    log(ctx, 'command', failed.length ? `Checks: ${failed.map((c) => c.name).join(', ')} failed` : `All ${counted} checks passed`);
    return {
      ok: failed.length === 0,
      content: `${dir}\n${table}\n\n${failed.length ? detail : `All ${counted} checks passed.\n${passTail}`}`.trim(),
      summary: failed.length ? `${failed.length} of ${checks.length} checks failed` : `All ${counted} check${counted === 1 ? '' : 's'} passed`,
      display: { kind: 'code', stdout: redactSecrets(ctx.owner, table), stderr: failed.length ? clip(detail, 2000) : '' },
    };
  },
});

// ------------------------------------------------------------------ starting projects

export const scaffoldProjectTool = defineTool({
  name: 'scaffold_project',
  description:
    'Start a new project from a known-good template on your computer, with tests that already pass, so you build on something that works instead of writing boilerplate: ' +
    Object.entries(TEMPLATES)
      .map(([id, t]) => `"${id}" ${t.about}`)
      .join('; ') +
    '. Installs dependencies and runs the tests, then returns the files. Then write the real app on top of it with sandbox_write_files / sandbox_edit_file and keep run_checks passing.',
  schema: z.object({
    template: z.enum(Object.keys(TEMPLATES) as [TemplateId, ...TemplateId[]]),
    name: z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,40}$/, 'lowercase letters, digits and dashes')
      .describe('folder and package name, e.g. "todo-app"'),
    title: z.string().max(60).optional().describe('the app title shown on screen'),
    install: z.boolean().optional().describe('install dependencies and run the tests (default true)'),
  }),
  label: (a) => `Starting ${a.name} from the ${a.template} template…`,
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  timeoutMs: 10 * 60_000,
  handler: async (a, ctx) => {
    const t = TEMPLATES[a.template];
    const dir = sandboxPath(a.name);
    const title = a.title?.trim() || a.name.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
    const files = t.files(a.name, title);
    const res = await withSandbox(ctx, async (s) => {
      const exists = await s.exec(`[ -e ${shq(dir)} ] && ls -A ${shq(dir)} | head -3`, { cwd: '/', timeoutMs: 15_000 });
      if (exists.stdout.trim()) return { error: `${dir} already exists and is not empty. Pick another name, or work on it with code_map.` };
      if (t.create) {
        const c = await s.exec(t.create(a.name), { cwd: SANDBOX_WORKDIR, timeoutMs: 6 * 60_000 });
        if (c.exitCode !== 0) return { error: `The template command failed (exit ${c.exitCode}):\n${clip(c.stdout + c.stderr, 2500)}` };
      }
      for (const [p, content] of Object.entries(files)) await s.writeFile(`${dir}/${p}`, content);
      if (a.install === false || !t.setup) return { setup: null };
      return { setup: await s.exec(t.setup, { cwd: dir, timeoutMs: 8 * 60_000 }) };
    });
    if ('error' in res) return { ok: false, content: res.error!, summary: 'Not started' };
    const setup = res.setup ? hide(ctx.owner, res.setup) : null;
    const ok = !setup || setup.exitCode === 0;
    log(ctx, 'file', `Started ${a.name} (${a.template})`);
    const list = Object.keys(files).sort().join('\n  ');
    return {
      ok,
      content:
        `Made ${dir} from the ${a.template} template.\nFiles:\n  ${list}\n\n${t.next}\n` +
        (setup ? `\nSetup and tests (${t.setup}) ${ok ? 'passed' : `FAILED, exit ${setup.exitCode}`}:\n${clip((setup.stdout + '\n' + setup.stderr).trim(), ok ? 1500 : 4000)}` : '\nDependencies not installed yet.'),
      summary: ok ? `${a.name} ready, tests pass` : `${a.name} made, setup failed`,
    };
  },
});

export const codingTools = [sandboxWriteFilesTool, codeMapTool, runChecksTool, scaffoldProjectTool];
