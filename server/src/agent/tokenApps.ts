import { z } from 'zod';
import { defineTool, type AgentServices, type ToolContext, type ToolDef } from './tools/types.js';

/**
 * Apps the user connects with their own access token (no OAuth app needed on this server):
 * GitHub (personal access token), Notion (internal integration secret) and Slack (bot or user token).
 * The token is checked with the provider before it is saved, stored encrypted (store.saveConnection),
 * never returned by the API and never shown to the model. Their tools are offered only once the app is
 * connected for that character; anything that writes (issues, comments, pages, messages) is held for
 * the user's approval first.
 */

export type TokenAppId = 'github' | 'notion' | 'slack';

export interface TokenAppSpec {
  id: TokenAppId;
  name: string;
  description: string;
  /** label of the token field in the app */
  tokenLabel: string;
  /** one line on where to get it */
  tokenHelp: string;
  /** page where the user creates the token */
  tokenUrl: string;
  /** checks the token with the provider; returns the account it belongs to */
  verify: (svc: AgentServices, token: string, signal: AbortSignal) => Promise<string>;
}

const UA = 'Orin-Agent';

function tokenOf(ctx: { owner: string; services: AgentServices }, id: TokenAppId, name: string): string {
  const c = ctx.services.store.getConnection(ctx.owner, id);
  if (!c?.accessToken) throw new Error(`${name} is not connected. Connect it on the Apps page.`);
  return c.accessToken;
}

const needsApp = (id: TokenAppId, name: string) => ({ owner, services }: { owner: string; services: AgentServices }) =>
  services.store.getConnection(owner, id) ? null : `the user to connect ${name} on the Apps page (tap ${name}, paste a token)`;

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { message: text.slice(0, 200) };
  }
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

// ---------------------------------------------------------------- GitHub

async function gh<T>(svc: AgentServices, token: string, path: string, signal: AbortSignal, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await svc.fetchImpl(`https://api.github.com${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': UA, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal,
  });
  const json = await readJson(res as unknown as Response);
  if (!res.ok) {
    const msg = (json as { message?: string }).message ?? '';
    if (res.status === 401) throw new Error('GitHub refused the token (401). It may have expired; connect GitHub again on the Apps page.');
    throw new Error(`GitHub API error HTTP ${res.status}${msg ? `: ${clip(msg, 200)}` : ''}`);
  }
  return json as T;
}

const repoArg = z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'owner/name');
const ghTok = (ctx: ToolContext) => tokenOf(ctx, 'github', 'GitHub');
const ghNeeds = needsApp('github', 'GitHub');

export const githubListReposTool = defineTool({
  name: 'github_list_repos',
  description: "List the user's GitHub repositories (most recently updated first), or one owner's/org's public repositories.",
  schema: z.object({ owner: z.string().max(100).optional(), max: z.number().int().min(1).max(50).optional() }),
  label: () => 'Checking GitHub…',
  needs: ghNeeds,
  handler: async (a, ctx) => {
    const n = a.max ?? 20;
    const path = a.owner ? `/users/${encodeURIComponent(a.owner)}/repos?sort=updated&per_page=${n}` : `/user/repos?sort=updated&per_page=${n}`;
    const repos = await gh<{ full_name: string; private: boolean; description: string | null; html_url: string; updated_at: string; open_issues_count: number; default_branch: string }[]>(ctx.services, ghTok(ctx), path, ctx.signal);
    const rows = repos.map((r) => `- ${r.full_name}${r.private ? ' (private)' : ''} · branch ${r.default_branch} · ${r.open_issues_count} open issues/PRs · updated ${r.updated_at.slice(0, 10)}\n  ${r.description ?? ''} ${r.html_url}`);
    return { content: rows.join('\n') || 'No repositories.', summary: `${rows.length} repositories` };
  },
});

export const githubSearchTool = defineTool({
  name: 'github_search',
  description: 'Search GitHub with GitHub search syntax. kind: issues (issues and pull requests, e.g. "repo:o/r is:open bug"), repositories, or code (e.g. "useState repo:o/r").',
  schema: z.object({ query: z.string().min(1).max(300), kind: z.enum(['issues', 'repositories', 'code']).optional(), max: z.number().int().min(1).max(30).optional() }),
  label: () => 'Searching GitHub…',
  needs: ghNeeds,
  handler: async (a, ctx) => {
    const kind = a.kind ?? 'issues';
    const r = await gh<{ total_count: number; items: Record<string, unknown>[] }>(ctx.services, ghTok(ctx), `/search/${kind}?q=${encodeURIComponent(a.query)}&per_page=${a.max ?? 10}`, ctx.signal);
    const rows = r.items.map((it) => {
      if (kind === 'repositories') return `- ${it.full_name} ★${it.stargazers_count} ${it.html_url}\n  ${it.description ?? ''}`;
      if (kind === 'code') return `- ${(it.repository as { full_name?: string })?.full_name}: ${it.path} ${it.html_url}`;
      return `- #${it.number} ${it.pull_request ? '[PR] ' : ''}${it.title} (${it.state}) ${it.html_url}`;
    });
    return { content: `${r.total_count} results\n${rows.join('\n')}`, summary: `${rows.length} results` };
  },
});

export const githubListIssuesTool = defineTool({
  name: 'github_list_issues',
  description: 'List issues or pull requests in a GitHub repository (owner/name).',
  schema: z.object({ repo: repoArg, pulls: z.boolean().optional(), state: z.enum(['open', 'closed', 'all']).optional(), max: z.number().int().min(1).max(50).optional() }),
  label: (a) => `Checking ${a.repo}…`,
  needs: ghNeeds,
  handler: async (a, ctx) => {
    const kind = a.pulls ? 'pulls' : 'issues';
    const items = await gh<{ number: number; title: string; state: string; user?: { login: string }; html_url: string; pull_request?: unknown; updated_at: string }[]>(ctx.services, ghTok(ctx), `/repos/${a.repo}/${kind}?state=${a.state ?? 'open'}&per_page=${a.max ?? 20}`, ctx.signal);
    const rows = items.filter((i) => a.pulls || !i.pull_request).map((i) => `- #${i.number} ${i.title} (${i.state}, by ${i.user?.login ?? '?'}, updated ${i.updated_at.slice(0, 10)}) ${i.html_url}`);
    return { content: rows.join('\n') || `No ${a.state ?? 'open'} ${a.pulls ? 'pull requests' : 'issues'}.`, summary: `${rows.length} ${a.pulls ? 'pull requests' : 'issues'}` };
  },
});

export const githubReadTool = defineTool({
  name: 'github_read',
  description: 'Read from a GitHub repository: a file\'s text, a folder listing (path "" for the root), or an issue/PR with its comments (number).',
  schema: z.object({ repo: repoArg, path: z.string().max(400).optional(), ref: z.string().max(200).optional(), number: z.number().int().min(1).optional() }),
  label: (a) => (a.number ? `Reading ${a.repo}#${a.number}…` : `Reading ${a.repo}…`),
  needs: ghNeeds,
  handler: async (a, ctx) => {
    const tok = ghTok(ctx);
    if (a.number) {
      const i = await gh<{ title: string; state: string; body: string | null; user?: { login: string }; html_url: string }>(ctx.services, tok, `/repos/${a.repo}/issues/${a.number}`, ctx.signal);
      const cs = await gh<{ user?: { login: string }; body: string; created_at: string }[]>(ctx.services, tok, `/repos/${a.repo}/issues/${a.number}/comments?per_page=30`, ctx.signal);
      const comments = cs.map((c) => `--- ${c.user?.login ?? '?'} (${c.created_at.slice(0, 10)}):\n${clip(c.body, 2000)}`).join('\n');
      return { content: `#${a.number} ${i.title} (${i.state}, by ${i.user?.login ?? '?'}) ${i.html_url}\n\n${clip(i.body ?? '', 6000)}\n\n${comments}`, summary: `Read #${a.number}` };
    }
    const path = (a.path ?? '').replace(/^\/+/, '');
    const q = a.ref ? `?ref=${encodeURIComponent(a.ref)}` : '';
    const r = await gh<unknown>(ctx.services, tok, `/repos/${a.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}${q}`, ctx.signal);
    if (Array.isArray(r)) {
      const rows = (r as { type: string; path: string; size: number }[]).map((f) => `- ${f.type === 'dir' ? `${f.path}/` : `${f.path} (${f.size} B)`}`);
      return { content: rows.join('\n') || '(empty folder)', summary: `${rows.length} entries` };
    }
    const f = r as { content?: string; encoding?: string; size: number; path: string };
    if (!f.content) return { content: `${f.path} is ${f.size} bytes; too large to read through the API.`, summary: 'File too large' };
    const text = Buffer.from(f.content, (f.encoding as BufferEncoding) || 'base64').toString('utf8');
    return { content: `${f.path}:\n${clip(text, 30_000)}`, summary: `Read ${f.path}` };
  },
});

export const githubCreateIssueTool = defineTool({
  name: 'github_create_issue',
  description: 'Open a new issue in a GitHub repository. The user sees it and must approve before it is created.',
  schema: z.object({ repo: repoArg, title: z.string().min(1).max(256), body: z.string().max(20_000).optional(), labels: z.array(z.string().max(50)).max(10).optional() }),
  label: () => 'Opening a GitHub issue…',
  needs: ghNeeds,
  approval: (a) => ({ title: 'Open GitHub issue', headline: a.title, body: `Orin wants to open this issue in ${a.repo}.`, content: a.body || undefined, fields: [{ label: 'Repository', value: a.repo }, { label: 'Title', value: a.title }, ...(a.labels?.length ? [{ label: 'Labels', value: a.labels.join(', ') }] : [])] }),
  handler: async (a, ctx) => {
    const i = await gh<{ number: number; html_url: string }>(ctx.services, ghTok(ctx), `/repos/${a.repo}/issues`, ctx.signal, { method: 'POST', body: { title: a.title, body: a.body, labels: a.labels } });
    return { content: `Issue #${i.number} opened: ${i.html_url}`, summary: `Opened #${i.number}`, display: { kind: 'page', url: i.html_url, title: `${a.repo}#${i.number}` } };
  },
});

export const githubCommentTool = defineTool({
  name: 'github_comment',
  description: 'Comment on a GitHub issue or pull request. The user sees the comment and must approve before it is posted.',
  schema: z.object({ repo: repoArg, number: z.number().int().min(1), body: z.string().min(1).max(20_000) }),
  label: (a) => `Commenting on #${a.number}…`,
  needs: ghNeeds,
  approval: (a) => ({ title: 'Post GitHub comment', headline: `${a.repo}#${a.number}`, body: `Orin wants to post this comment on ${a.repo}#${a.number}.`, content: a.body, fields: [{ label: 'On', value: `${a.repo}#${a.number}` }] }),
  handler: async (a, ctx) => {
    const c = await gh<{ html_url: string }>(ctx.services, ghTok(ctx), `/repos/${a.repo}/issues/${a.number}/comments`, ctx.signal, { method: 'POST', body: { body: a.body } });
    return { content: `Comment posted: ${c.html_url}`, summary: 'Comment posted' };
  },
});

// ---------------------------------------------------------------- Notion

async function notion<T>(svc: AgentServices, token: string, path: string, signal: AbortSignal, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await svc.fetchImpl(`https://api.notion.com/v1${path}`, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, 'Notion-Version': '2022-06-28', 'User-Agent': UA, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal,
  });
  const json = await readJson(res as unknown as Response);
  if (!res.ok) {
    const msg = (json as { message?: string }).message ?? '';
    if (res.status === 401) throw new Error('Notion refused the token (401). Connect Notion again on the Apps page.');
    if (res.status === 404) throw new Error(`Notion can't see that page (404). In Notion, open the page, tap ••• → Connections and add your integration. ${clip(msg, 160)}`);
    throw new Error(`Notion API error HTTP ${res.status}${msg ? `: ${clip(msg, 200)}` : ''}`);
  }
  return json as T;
}

type RichText = { plain_text?: string }[];
const rt = (r: RichText | undefined) => (r ?? []).map((x) => x.plain_text ?? '').join('');
const noTok = (ctx: ToolContext) => tokenOf(ctx, 'notion', 'Notion');
const noNeeds = needsApp('notion', 'Notion');
const notionId = z.string().min(32).max(300).describe('page id or Notion link');
/** a Notion link or id -> the page id */
export const pageIdOf = (v: string) => {
  const m = v.match(/[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}(?![0-9a-f])/gi);
  return (m ? m[m.length - 1]! : v).replace(/-/g, '');
};

function titleOf(obj: { properties?: Record<string, { type?: string; title?: RichText }>; title?: RichText }): string {
  if (obj.title) return rt(obj.title) || '(untitled)';
  for (const p of Object.values(obj.properties ?? {})) if (p.type === 'title') return rt(p.title) || '(untitled)';
  return '(untitled)';
}

/** Turns plain text (one paragraph per line, "# " headings, "- " bullets) into Notion blocks. */
export function textToBlocks(text: string): unknown[] {
  return text
    .split('\n')
    .filter((l) => l.trim())
    .slice(0, 100)
    .map((l) => {
      const line = l.trimEnd();
      const mk = (type: string, content: string) => ({ object: 'block', type, [type]: { rich_text: [{ type: 'text', text: { content: content.slice(0, 2000) } }] } });
      if (/^###?\s/.test(line)) return mk('heading_3', line.replace(/^###?\s/, ''));
      if (/^#\s/.test(line)) return mk('heading_2', line.slice(2));
      if (/^[-*]\s/.test(line)) return mk('bulleted_list_item', line.slice(2));
      if (/^\d+\.\s/.test(line)) return mk('numbered_list_item', line.replace(/^\d+\.\s/, ''));
      return mk('paragraph', line);
    });
}

export const notionSearchTool = defineTool({
  name: 'notion_search',
  description: 'Search the Notion pages and databases shared with the user\'s Orin integration. Returns titles, ids and links.',
  schema: z.object({ query: z.string().max(200), max: z.number().int().min(1).max(30).optional() }),
  label: () => 'Searching Notion…',
  needs: noNeeds,
  handler: async (a, ctx) => {
    const r = await notion<{ results: { object: string; id: string; url: string; last_edited_time: string; properties?: Record<string, { type?: string; title?: RichText }>; title?: RichText }[] }>(ctx.services, noTok(ctx), '/search', ctx.signal, { method: 'POST', body: { query: a.query, page_size: a.max ?? 10 } });
    const rows = r.results.map((p) => `- ${titleOf(p)} (${p.object}, id ${p.id}, edited ${p.last_edited_time.slice(0, 10)}) ${p.url}`);
    return { content: rows.join('\n') || 'Nothing found. Only pages shared with the integration (••• → Connections in Notion) can be found.', summary: `${rows.length} results` };
  },
});

export const notionReadTool = defineTool({
  name: 'notion_read_page',
  description: 'Read a Notion page\'s title and text by id or link.',
  schema: z.object({ page: notionId }),
  label: () => 'Reading Notion…',
  needs: noNeeds,
  handler: async (a, ctx) => {
    const tok = noTok(ctx);
    const page = await notion<{ url: string; properties?: Record<string, { type?: string; title?: RichText }> }>(ctx.services, tok, `/pages/${pageIdOf(a.page)}`, ctx.signal);
    const kids = await notion<{ results: Record<string, unknown>[] }>(ctx.services, tok, `/blocks/${pageIdOf(a.page)}/children?page_size=100`, ctx.signal);
    const lines = kids.results.map((b) => {
      const type = String(b.type);
      const body = b[type] as { rich_text?: RichText; title?: string } | undefined;
      const text = body?.rich_text ? rt(body.rich_text) : (body?.title ?? '');
      if (type.startsWith('heading')) return `# ${text}`;
      if (type.endsWith('list_item')) return `- ${text}`;
      if (type === 'to_do') return `[${(body as { checked?: boolean }).checked ? 'x' : ' '}] ${text}`;
      if (type === 'child_page') return `(sub-page: ${text}, id ${b.id})`;
      return text;
    });
    return { content: `${titleOf(page)} ${page.url}\n\n${clip(lines.filter(Boolean).join('\n'), 30_000)}`, summary: 'Read page' };
  },
});

export const notionCreatePageTool = defineTool({
  name: 'notion_create_page',
  description: 'Create a Notion page under a parent page the integration can see (use notion_search for the parent id). Content: one paragraph per line, "# " headings, "- " bullets. The user approves first.',
  schema: z.object({ parent: notionId, title: z.string().min(1).max(200), content: z.string().max(20_000).optional() }),
  label: () => 'Creating a Notion page…',
  needs: noNeeds,
  approval: (a) => ({ title: 'Create Notion page', headline: a.title, body: 'Orin wants to create this page in your Notion.', content: a.content || undefined, fields: [{ label: 'Title', value: a.title }, { label: 'Inside page', value: a.parent }] }),
  handler: async (a, ctx) => {
    const p = await notion<{ id: string; url: string }>(ctx.services, noTok(ctx), '/pages', ctx.signal, { method: 'POST', body: { parent: { page_id: pageIdOf(a.parent) }, properties: { title: { title: [{ text: { content: a.title } }] } }, children: textToBlocks(a.content ?? '') } });
    return { content: `Page created: ${p.url} (id ${p.id})`, summary: 'Page created', display: { kind: 'page', url: p.url, title: a.title } };
  },
});

export const notionAppendTool = defineTool({
  name: 'notion_append',
  description: 'Add text to the end of a Notion page (one paragraph per line, "# " headings, "- " bullets). The user approves first.',
  schema: z.object({ page: notionId, content: z.string().min(1).max(20_000) }),
  label: () => 'Updating Notion…',
  needs: noNeeds,
  approval: (a) => ({ title: 'Add to Notion page', headline: a.page, body: 'Orin wants to add this to the end of a Notion page.', content: a.content, fields: [{ label: 'Page', value: a.page }] }),
  handler: async (a, ctx) => {
    const blocks = textToBlocks(a.content);
    await notion<unknown>(ctx.services, noTok(ctx), `/blocks/${pageIdOf(a.page)}/children`, ctx.signal, { method: 'PATCH', body: { children: blocks } });
    return { content: `Added ${blocks.length} blocks to the page.`, summary: 'Page updated' };
  },
});

// ---------------------------------------------------------------- Slack

async function slack<T>(svc: AgentServices, token: string, method: string, signal: AbortSignal, params: Record<string, string | number | undefined> = {}, post = false): Promise<T> {
  const clean = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
  const qs = new URLSearchParams(clean).toString();
  const res = await svc.fetchImpl(`https://slack.com/api/${method}${post ? '' : qs ? `?${qs}` : ''}`, {
    method: post ? 'POST' : 'GET',
    headers: { Authorization: `Bearer ${token}`, 'User-Agent': UA, ...(post ? { 'Content-Type': 'application/json; charset=utf-8' } : {}) },
    body: post ? JSON.stringify(clean) : undefined,
    signal,
  });
  const json = (await readJson(res as unknown as Response)) as { ok?: boolean; error?: string };
  if (!res.ok || !json.ok) {
    const e = json.error ?? `HTTP ${res.status}`;
    if (e === 'invalid_auth' || e === 'token_revoked' || e === 'not_authed') throw new Error(`Slack refused the token (${e}). Connect Slack again on the Apps page.`);
    if (e === 'not_in_channel') throw new Error('The Slack app is not in that channel. In Slack, type /invite @your-app in the channel, then try again.');
    if (e === 'missing_scope') throw new Error('The Slack token is missing a permission (scope) for this. Add it to the Slack app, reinstall it and connect again.');
    throw new Error(`Slack API error: ${e}`);
  }
  return json as T;
}

const slTok = (ctx: ToolContext) => tokenOf(ctx, 'slack', 'Slack');
const slNeeds = needsApp('slack', 'Slack');

export const slackListChannelsTool = defineTool({
  name: 'slack_list_channels',
  description: 'List Slack channels the connected Slack app can see (name, id, member or not).',
  schema: z.object({ max: z.number().int().min(1).max(200).optional() }),
  label: () => 'Checking Slack…',
  needs: slNeeds,
  handler: async (a, ctx) => {
    const r = await slack<{ channels: { id: string; name: string; is_private: boolean; is_member: boolean; num_members?: number }[] }>(ctx.services, slTok(ctx), 'conversations.list', ctx.signal, { types: 'public_channel,private_channel', exclude_archived: 'true', limit: a.max ?? 100 });
    const rows = r.channels.map((c) => `- #${c.name} (id ${c.id}${c.is_private ? ', private' : ''}${c.is_member ? ', joined' : ', not joined'}${c.num_members ? `, ${c.num_members} members` : ''})`);
    return { content: rows.join('\n') || 'No channels visible.', summary: `${rows.length} channels` };
  },
});

export const slackReadChannelTool = defineTool({
  name: 'slack_read_channel',
  description: 'Read the latest messages in a Slack channel (channel id from slack_list_channels).',
  schema: z.object({ channel: z.string().min(2).max(40), max: z.number().int().min(1).max(100).optional() }),
  label: () => 'Reading Slack…',
  needs: slNeeds,
  handler: async (a, ctx) => {
    const r = await slack<{ messages: { user?: string; bot_id?: string; text: string; ts: string }[] }>(ctx.services, slTok(ctx), 'conversations.history', ctx.signal, { channel: a.channel, limit: a.max ?? 20 });
    const rows = r.messages.reverse().map((m) => `- ${new Date(Number(m.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')} ${m.user ?? m.bot_id ?? '?'}: ${clip(m.text, 1500)}`);
    return { content: rows.join('\n') || 'No messages.', summary: `${rows.length} messages` };
  },
});

export const slackSendTool = defineTool({
  name: 'slack_send_message',
  description: 'Post a message to a Slack channel (channel id or #name). The user sees it and must approve before it is sent.',
  schema: z.object({ channel: z.string().min(2).max(80), text: z.string().min(1).max(10_000) }),
  label: () => 'Sending to Slack…',
  needs: slNeeds,
  approval: (a) => ({ title: 'Send Slack message', headline: a.channel, body: `Orin wants to post this in ${a.channel}.`, content: a.text, fields: [{ label: 'Channel', value: a.channel }] }),
  handler: async (a, ctx) => {
    const r = await slack<{ channel: string; ts: string }>(ctx.services, slTok(ctx), 'chat.postMessage', ctx.signal, { channel: a.channel.replace(/^#/, ''), text: a.text }, true);
    return { content: `Message posted in ${r.channel} (ts ${r.ts}).`, summary: 'Message sent' };
  },
});

// ---------------------------------------------------------------- registry

export const TOKEN_APPS: TokenAppSpec[] = [
  {
    id: 'github',
    name: 'GitHub',
    description: 'Repos, files, issues and pull requests; opening issues and commenting ask you first.',
    tokenLabel: 'Personal access token',
    tokenHelp: 'GitHub → Settings → Developer settings → Personal access tokens. Fine-grained, with access to the repos you want (Contents and Issues: read, or read and write to let Orin open issues).',
    tokenUrl: 'https://github.com/settings/personal-access-tokens/new',
    verify: async (svc, token, signal) => (await gh<{ login: string }>(svc, token, '/user', signal)).login,
  },
  {
    id: 'notion',
    name: 'Notion',
    description: 'Search and read your pages; creating and adding to pages asks you first.',
    tokenLabel: 'Internal integration secret',
    tokenHelp: 'Create an internal integration at notion.so/my-integrations, copy its secret, then share pages with it (••• → Connections).',
    tokenUrl: 'https://www.notion.so/my-integrations',
    verify: async (svc, token, signal) => {
      const me = await notion<{ name?: string; bot?: { workspace_name?: string } }>(svc, token, '/users/me', signal);
      return me.bot?.workspace_name || me.name || 'Notion';
    },
  },
  {
    id: 'slack',
    name: 'Slack',
    description: 'Read channels and post messages; sending asks you first.',
    tokenLabel: 'Bot token (xoxb-…)',
    tokenHelp: 'Create a Slack app at api.slack.com/apps, add bot scopes channels:read, channels:history, chat:write (groups:* for private channels), install it, copy the Bot User OAuth Token.',
    tokenUrl: 'https://api.slack.com/apps',
    verify: async (svc, token, signal) => {
      const r = await slack<{ team?: string; user?: string }>(svc, token, 'auth.test', signal);
      return [r.user, r.team].filter(Boolean).join(' · ') || 'Slack';
    },
  },
];

export const tokenAppTools: Record<TokenAppId, ToolDef[]> = {
  github: [githubListReposTool, githubSearchTool, githubListIssuesTool, githubReadTool, githubCreateIssueTool, githubCommentTool],
  notion: [notionSearchTool, notionReadTool, notionCreatePageTool, notionAppendTool],
  slack: [slackListChannelsTool, slackReadChannelTool, slackSendTool],
};

export const allTokenAppTools: ToolDef[] = Object.values(tokenAppTools).flat();

export const tokenApp = (id: string) => TOKEN_APPS.find((a) => a.id === id);

/** Checks the token with the provider and saves it encrypted for this owner. Returns the account name. */
export async function connectTokenApp(svc: AgentServices, owner: string, id: TokenAppId, rawToken: string): Promise<string> {
  const app = tokenApp(id);
  if (!app) throw new Error('No such app.');
  const token = rawToken.trim();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15_000);
  let account: string;
  try {
    account = await app.verify(svc, token, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
  svc.store.saveConnection({ owner, provider: id, accessToken: token, refreshToken: '', expiresAt: 0, scope: '', email: account });
  return account;
}
