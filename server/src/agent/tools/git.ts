import { z } from 'zod';
import { sandboxPath, shq, SANDBOX_WORKDIR } from '../sandbox/index.js';
import { holdSecret } from '../sandbox/secrets.js';
import { defineTool, type ToolContext } from './types.js';
import { hide, log, sandboxNeeds, short, withSandbox } from './sandbox.js';

/**
 * Git on Orin's computer. Cloning, branching and committing stay on her computer and run straight
 * away. Pushing and opening a pull request reach GitHub, so they wait for the user's approval card.
 * A private repo uses the GitHub token from the Apps page; it goes to git through an environment
 * variable and a credential helper, never on the command line, and is hidden in any output.
 */

const clip = (t: string, n: number) => (t.length <= n ? t : `${t.slice(0, n)}\n…[${t.length - n} more characters]`);

function ghToken(ctx: ToolContext): string | null {
  const t = ctx.services.store.getConnection(ctx.owner, 'github')?.accessToken ?? null;
  if (t) holdSecret(ctx.owner, 'github token', t);
  return t;
}

/** git with the token offered only to github.com, through a helper that reads $GH_TOKEN */
const AUTH = `-c credential.https://github.com.helper= -c 'credential.https://github.com.helper=!f() { echo username=x-access-token; echo "password=$GH_TOKEN"; }; f'`;
const envs = (tok: string | null): Record<string, string> => ({ GIT_TERMINAL_PROMPT: '0', ...(tok ? { GH_TOKEN: tok } : {}) });
const IDENT = `git config user.email >/dev/null || git config user.email "orin@users.noreply.github.com"; git config user.name >/dev/null || git config user.name "Orin"`;

/** owner/repo from a GitHub link or "owner/repo" */
export function repoOf(v: string): string | null {
  const m = v.trim().match(/^(?:https?:\/\/github\.com\/|git@github\.com:)?([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export const gitCloneTool = defineTool({
  name: 'git_clone',
  description:
    'Clone a git repository onto your computer (GitHub "owner/repo", or any https git URL). Private GitHub repos use the GitHub token from the Apps page. Then run code_map on the folder to see the project before you change it.',
  schema: z.object({
    repo: z.string().min(3).max(300).describe('"owner/repo" or a git https URL'),
    dir: z.string().max(200).optional().describe('folder name (default: the repo name)'),
    branch: z.string().max(120).optional(),
    depth: z.number().int().min(0).max(1000).optional().describe('history to fetch; 0 = full (default 50)'),
  }),
  label: (a) => `Getting ${short(a.repo, 40)}…`,
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  timeoutMs: 8 * 60_000,
  handler: async (a, ctx) => {
    const slug = repoOf(a.repo);
    const url = slug ? `https://github.com/${slug}.git` : a.repo.trim();
    if (!/^https:\/\//.test(url)) return { ok: false, content: 'Give an https git URL or a GitHub "owner/repo".', summary: 'Bad repo' };
    const name = a.dir || (slug ?? url).split('/').pop()!.replace(/\.git$/, '');
    const dir = sandboxPath(name);
    const tok = slug ? ghToken(ctx) : null;
    const depth = a.depth === 0 ? '' : `--depth ${a.depth ?? 50}`;
    const cmd = `[ -e ${shq(dir)} ] && { echo "EXISTS"; exit 3; }; git ${AUTH} clone ${depth} ${a.branch ? `--branch ${shq(a.branch)}` : ''} ${shq(url)} ${shq(dir)} 2>&1 | tail -15 && cd ${shq(dir)} && echo "---" && git log -3 --format='%h %ad %s' --date=short && echo "files: $(git ls-files | wc -l)"`;
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(cmd, { cwd: SANDBOX_WORKDIR, timeoutMs: 7 * 60_000, envs: envs(tok) })));
    if (r.exitCode === 3) return { ok: false, content: `${dir} already exists. Use it (code_map, git_status), or clone with another dir.`, summary: 'Already there' };
    if (r.exitCode !== 0 || !/files: \d+/.test(r.stdout)) {
      const why = /Authentication failed|could not read Username|Repository not found|403|404/i.test(r.stdout + r.stderr)
        ? tok
          ? 'GitHub refused: the repo does not exist, or the GitHub token on the Apps page cannot see it.'
          : 'The repo was not found or is private. For a private repo, the user connects GitHub on the Apps page (a token with repo access).'
        : '';
      return { ok: false, content: `Clone failed (exit ${r.exitCode}). ${why}\n${clip(r.stdout + r.stderr, 2500)}`, summary: 'Clone failed' };
    }
    log(ctx, 'command', `Cloned ${slug ?? url}`);
    return { content: `Cloned into ${dir}\n${clip(r.stdout, 3000)}`, summary: `Cloned ${name}` };
  },
});

export const gitStatusTool = defineTool({
  name: 'git_status',
  description: 'See a repo on your computer: branch, remote, changed files with a diff summary, and recent commits. With diff true, also the full diff of uncommitted changes (to review your own work before committing).',
  schema: z.object({ path: z.string().max(300).describe('the repo folder'), diff: z.boolean().optional() }),
  label: () => 'Checking the changes…',
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  handler: async (a, ctx) => {
    const cmd = `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "NOT A REPO"; exit 3; }
echo "branch: $(git branch --show-current)  remote: $(git remote get-url origin 2>/dev/null | sed -E 's#https://[^@]*@#https://#')"
git status --short | head -80
echo "--- diff summary"; git diff --stat HEAD 2>/dev/null | tail -30
echo "--- recent commits"; git log -8 --format='%h %ad %an: %s' --date=short 2>/dev/null
${a.diff ? 'echo "--- diff"; git diff HEAD 2>/dev/null | head -c 40000' : ''}`;
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(cmd, { cwd: sandboxPath(a.path), timeoutMs: 60_000 })));
    if (r.exitCode === 3) return { ok: false, content: `${a.path} is not a git repo. Start one with git_commit (init true).`, summary: 'Not a repo' };
    return { content: clip(r.stdout + (r.stderr ? `\n${r.stderr}` : ''), 42_000), summary: 'Checked the changes' };
  },
});

export const gitCommitTool = defineTool({
  name: 'git_commit',
  description:
    'Commit changes in a repo on your computer (stays on your computer; nothing is sent). Optionally start the repo (init) and switch to or create a branch first. Commit after each working step so you can roll back. Use git_push to send commits to GitHub.',
  schema: z.object({
    path: z.string().max(300),
    message: z.string().min(3).max(2000),
    branch: z.string().max(120).optional().describe('switch to this branch first, creating it if needed'),
    init: z.boolean().optional().describe('git init the folder if it is not a repo yet'),
    files: z.array(z.string().max(300)).max(200).optional().describe('only these files (default: everything changed, respecting .gitignore)'),
  }),
  label: (a) => `Saving a commit: ${short(a.message, 40)}…`,
  needs: ({ services, owner }) => sandboxNeeds(services, owner),
  handler: async (a, ctx) => {
    const cmd = `set -e
${a.init ? `git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { git init -q -b main; [ -f .gitignore ] || printf 'node_modules\\ndist\\nbuild\\n.env\\n.env.*\\ncoverage\\n__pycache__\\n.venv\\n' > .gitignore; }` : ''}
${IDENT}
${a.branch ? `git switch ${shq(a.branch)} 2>/dev/null || git switch -c ${shq(a.branch)}` : ''}
git add ${a.files?.length ? a.files.map(shq).join(' ') : '-A'}
if git diff --cached --quiet; then echo "NOTHING TO COMMIT"; exit 0; fi
git commit -q -m ${shq(a.message)}
git log -1 --format='%h %s' --stat | tail -25`;
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(cmd, { cwd: sandboxPath(a.path), timeoutMs: 120_000 })));
    if (r.exitCode !== 0) return { ok: false, content: `Commit failed (exit ${r.exitCode}):\n${clip(r.stdout + r.stderr, 2500)}`, summary: 'Commit failed' };
    if (/NOTHING TO COMMIT/.test(r.stdout)) return { content: 'Nothing changed since the last commit.', summary: 'Nothing to commit' };
    log(ctx, 'command', `Committed: ${short(a.message, 60)}`);
    return { content: clip(r.stdout, 4000), summary: `Committed ${r.stdout.split(' ')[0]}` };
  },
});

export const gitPushTool = defineTool({
  name: 'git_push',
  description:
    'Push a branch from a repo on your computer to GitHub, with the GitHub token from the Apps page. Can create the GitHub repo first (create_repo, private by default) and set it as origin. The user approves before anything is sent.',
  schema: z.object({
    path: z.string().max(300),
    branch: z.string().max(120).optional().describe('default: the current branch'),
    create_repo: z.string().max(140).optional().describe('create this GitHub repo ("name" or "owner/name") and push to it'),
    public: z.boolean().optional().describe('with create_repo: make it public (default private)'),
  }),
  label: () => 'Pushing to GitHub…',
  needs: ({ services, owner }) => sandboxNeeds(services, owner) ?? (services.store.getConnection(owner, 'github') ? null : 'the user to connect GitHub on the Apps page (tap GitHub, paste a token with repo access)'),
  approval: (a) => ({
    title: a.create_repo ? 'Create a GitHub repo and push' : 'Push to GitHub',
    headline: a.create_repo ?? a.path,
    body: a.create_repo ? `Orin wants to create ${a.public ? 'a public' : 'a private'} GitHub repo "${a.create_repo}" and push ${a.path} to it.` : `Orin wants to push ${a.branch ? `branch ${a.branch}` : 'the current branch'} of ${a.path} to GitHub.`,
    fields: [{ label: 'Folder', value: a.path }, ...(a.branch ? [{ label: 'Branch', value: a.branch }] : []), ...(a.create_repo ? [{ label: 'New repo', value: `${a.create_repo} (${a.public ? 'public' : 'private'})` }] : [])],
  }),
  timeoutMs: 6 * 60_000,
  handler: async (a, ctx) => {
    const tok = ghToken(ctx);
    if (!tok) return { ok: false, content: 'GitHub is not connected. Ask the user to connect it on the Apps page.', summary: 'GitHub not connected' };
    let remote = '';
    if (a.create_repo) {
      const [o, n] = a.create_repo.includes('/') ? a.create_repo.split('/') : [null, a.create_repo];
      const me = (await (await ctx.services.fetchImpl('https://api.github.com/user', { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'Orin' }, signal: ctx.signal })).json()) as { login?: string };
      const path = o && o !== me.login ? `/orgs/${o}/repos` : '/user/repos';
      const res = await ctx.services.fetchImpl(`https://api.github.com${path}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${tok}`, 'User-Agent': 'Orin', 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' },
        body: JSON.stringify({ name: n, private: !a.public }),
        signal: ctx.signal,
      });
      const j = (await res.json().catch(() => ({}))) as { clone_url?: string; message?: string; errors?: { message?: string }[] };
      if (!res.ok && !(res.status === 422 && /already exists/i.test(JSON.stringify(j)))) return { ok: false, content: `GitHub would not create the repo (HTTP ${res.status}): ${j.message ?? ''} ${j.errors?.map((e) => e.message).join('; ') ?? ''}`, summary: 'Repo not created' };
      remote = j.clone_url ?? `https://github.com/${o ?? me.login}/${n}.git`;
    }
    const cmd = `set -e
${remote ? `git remote get-url origin >/dev/null 2>&1 && git remote set-url origin ${shq(remote)} || git remote add origin ${shq(remote)}` : ''}
B=${a.branch ? shq(a.branch) : '$(git branch --show-current)'}
git ${AUTH} push -u origin "$B" 2>&1 | tail -12
echo "remote: $(git remote get-url origin)  branch: $B  head: $(git log -1 --format='%h %s')"`;
    const r = hide(ctx.owner, await withSandbox(ctx, (s) => s.exec(cmd, { cwd: sandboxPath(a.path), timeoutMs: 5 * 60_000, envs: envs(tok) })));
    if (r.exitCode !== 0 || /rejected|error:|fatal:/i.test(r.stdout)) return { ok: false, content: `Push failed (exit ${r.exitCode}):\n${clip(r.stdout + r.stderr, 2500)}\nIf it was rejected, pull/rebase first or push to a new branch.`, summary: 'Push failed' };
    log(ctx, 'command', 'Pushed to GitHub');
    const url = (r.stdout.match(/remote: (https:\/\/github\.com\/[^\s]+?)(\.git)?\s/) ?? [])[1];
    return { content: clip(r.stdout, 3000), summary: 'Pushed', ...(url ? { display: { kind: 'page' as const, url, title: url.replace('https://github.com/', '') } } : {}) };
  },
});

export const githubCreatePrTool = defineTool({
  name: 'github_create_pr',
  description: 'Open a pull request on GitHub from a branch you pushed with git_push. The user approves before it is opened.',
  schema: z.object({
    repo: z.string().min(3).max(140).describe('"owner/repo"'),
    head: z.string().min(1).max(120).describe('the branch with the changes'),
    base: z.string().max(120).optional().describe('default: the repo default branch'),
    title: z.string().min(1).max(256),
    body: z.string().max(20_000).optional(),
    draft: z.boolean().optional(),
  }),
  label: () => 'Opening a pull request…',
  needs: ({ services, owner }) => (services.store.getConnection(owner, 'github') ? null : 'the user to connect GitHub on the Apps page (tap GitHub, paste a token with repo access)'),
  approval: (a) => ({
    title: 'Open pull request',
    headline: a.title,
    body: `Orin wants to open a pull request in ${a.repo} from ${a.head}${a.base ? ` into ${a.base}` : ''}.`,
    content: a.body || undefined,
    fields: [{ label: 'Repository', value: a.repo }, { label: 'From', value: a.head }, ...(a.base ? [{ label: 'Into', value: a.base }] : [])],
  }),
  handler: async (a, ctx) => {
    const tok = ghToken(ctx);
    if (!tok) return { ok: false, content: 'GitHub is not connected.', summary: 'GitHub not connected' };
    const h = { Authorization: `Bearer ${tok}`, 'User-Agent': 'Orin', 'Content-Type': 'application/json', Accept: 'application/vnd.github+json' };
    const repo = repoOf(a.repo) ?? a.repo;
    let base = a.base;
    if (!base) {
      const info = (await (await ctx.services.fetchImpl(`https://api.github.com/repos/${repo}`, { headers: h, signal: ctx.signal })).json()) as { default_branch?: string };
      base = info.default_branch ?? 'main';
    }
    const res = await ctx.services.fetchImpl(`https://api.github.com/repos/${repo}/pulls`, { method: 'POST', headers: h, body: JSON.stringify({ title: a.title, head: a.head, base, body: a.body, draft: a.draft ?? false }), signal: ctx.signal });
    const j = (await res.json().catch(() => ({}))) as { html_url?: string; number?: number; message?: string; errors?: { message?: string }[] };
    if (!res.ok) return { ok: false, content: `GitHub refused the pull request (HTTP ${res.status}): ${j.message ?? ''} ${j.errors?.map((e) => e.message).join('; ') ?? ''}`, summary: 'PR not opened' };
    return { content: `Pull request #${j.number} opened: ${j.html_url}`, summary: `Opened PR #${j.number}`, display: { kind: 'page', url: j.html_url!, title: `${repo}#${j.number}` } };
  },
});

export const gitTools = [gitCloneTool, gitStatusTool, gitCommitTool, gitPushTool, githubCreatePrTool];
