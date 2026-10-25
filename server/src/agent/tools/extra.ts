import { z } from 'zod';
import { isValidTimezone } from '../cron.js';
import { toPublic } from '../vault.js';
import { deleteWsFile, listFiles, readWsFile, workspaceDir, writeWsFile } from '../workspace.js';
import { describeDiff, diffPlan, dropPreview, fingerprint, listSites, openSite, planSite, previewPlan, publishPlan, siteBaseUrl, siteSlug, unpublishSite, type SiteDiff } from '../sites.js';
import { deployToHuggingFace, findHfToken, HF_TOKEN_HELP, hfSpaceName, HostError, verifyPublicUrl } from '../hosting.js';
import { computeNextRun } from './tasks.js';
import { defineTool, type ToolContext } from './types.js';

/** Asks the user a question mid-task through an in-app prompt and waits for the answer. */
export const askUserTool = defineTool({
  name: 'ask_user',
  description:
    'Ask the user a question and wait for the answer (shown as a card in the app; in background tasks they get a notification). Use only when you cannot continue without information only they have. Give choices when there is a fixed set of options.',
  schema: z.object({ question: z.string().min(3).max(1000), choices: z.array(z.string().min(1).max(80)).max(6).optional() }),
  label: () => 'Asking you…',
  timeoutMs: 31 * 60_000,
  handler: async (a, ctx) => {
    if (!ctx.ask) return { ok: false, content: 'Nobody can answer right now. Make a reasonable assumption, say which, and continue.', summary: 'No one to ask' };
    const r = await ctx.ask({ kind: 'question', title: a.question, body: '', choices: a.choices });
    if (r.decision !== 'answer' || r.answer == null) return { ok: false, content: `The user did not answer (${r.decision}). Make a reasonable assumption, say which, and continue.`, summary: 'No answer' };
    return { content: `The user answered: ${r.answer}`, summary: `You answered: ${r.answer}`.slice(0, 80) };
  },
});

/** Asks for a password, login or API key in a secure field; the value goes to the Secure Vault, never to the model. */
export const askSecretTool = defineTool({
  name: 'ask_secret',
  description:
    "Ask the user for a password, a login (username + password) or an API key/token through a secure field in the app. What they type goes straight into their Secure Vault under the name you give; you never see it. Then use it by name: browser_submit login for a website, or for an API key in a command or code on your computer pass secrets [{name, env}] to sandbox_run or run_code and read the environment variable. Never ask for passwords or keys in chat text; use this instead.",
  schema: z.object({
    name: z.string().trim().min(1).max(80).describe('Vault login name to save it under, e.g. "GitHub" or "OpenWeather key"'),
    site: z.string().trim().min(3).max(200).describe('Domain it belongs to, e.g. github.com'),
    what: z.enum(['login', 'password', 'api_key']).describe('login = username and password; password = password only; api_key = a key or token'),
    reason: z.string().max(300).optional().describe('One sentence on why it is needed'),
  }),
  label: () => 'Asking you for a login…',
  timeoutMs: 31 * 60_000,
  handler: async (a, ctx) => {
    if (!ctx.ask) return { ok: false, content: 'Nobody can answer right now. Tell the user to add it in the app (Settings > Secure Vault) and stop.', summary: 'No one to ask' };
    const domain = a.site.replace(/^https?:\/\//i, '').split('/')[0]!.toLowerCase();
    const label = a.what === 'api_key' ? 'API key' : a.what === 'login' ? 'login' : 'password';
    const r = await ctx.ask({
      kind: 'secret',
      title: `Your ${label} for ${domain}`,
      headline: a.name,
      body: a.reason?.trim() || `Orin needs your ${label} for ${domain}.`,
      secret: { name: a.name, domain, what: a.what },
      tool: 'ask_secret',
    });
    if (r.decision !== 'answer') return { ok: false, content: `The user did not give it (${r.decision}). Do not ask again unless they bring it up.`, summary: 'Not given' };
    return {
      content: `Saved in the user's Secure Vault as "${a.name}" for ${domain}. You cannot see the value. ${a.what === 'api_key' ? `To use it, pass secrets [{"name":"${a.name}","env":"SOME_API_KEY"}] to sandbox_run or run_code and read $SOME_API_KEY; never print it.` : `To sign in, use browser_submit with login "${a.name}".`}`,
      summary: `Saved to your vault as ${a.name}`.slice(0, 80),
    };
  },
});

/** Hands a step to the user (a code, a captcha, a payment, a sign-in on a page) and waits until they say it is done. */
export const askUserStepTool = defineTool({
  name: 'ask_user_step',
  description:
    'Ask the user to do one step themselves that you cannot do (enter a code, pass a captcha, enter a payment card, sign in with 2-step verification, approve something on their phone), optionally on a page they open from the card. Waits until they tap Done or say they cannot.',
  schema: z.object({
    step: z.string().min(3).max(300).describe('What the user does, as one short instruction'),
    url: z.string().url().max(2000).optional().describe('The page they open to do it'),
    details: z.string().max(1500).optional().describe('Anything that helps them do it'),
  }),
  label: () => 'Waiting for you…',
  timeoutMs: 31 * 60_000,
  handler: async (a, ctx) => {
    if (!ctx.ask) return { ok: false, content: 'Nobody can do the step right now. Tell the user what is needed and stop.', summary: 'No one to ask' };
    const r = await ctx.ask({ kind: 'step', title: a.step, body: a.details ?? '', url: a.url, headline: a.url ? new URL(a.url).hostname : undefined, tool: 'ask_user_step' });
    if (r.decision === 'done') return { content: `The user says the step is done${r.answer ? `: "${r.answer}"` : ''}. Check the result before you go on.`, summary: 'You did the step' };
    return { ok: false, content: `The user could not do the step (${r.decision}${r.answer ? `: "${r.answer}"` : ''}). Do not retry; say what is still needed.`, summary: 'Step not done' };
  },
});

export const vaultListTool = defineTool({
  name: 'vault_list',
  description: "List the logins saved in the user's Secure Vault (name, site and username only; passwords are never shown). Use a login with browser_submit's login argument.",
  schema: z.object({}),
  label: () => 'Checking your saved logins…',
  handler: async (_a, ctx) => {
    const rows = ctx.services.store.listVault(ctx.owner.split('#')[0]!).map(toPublic);
    if (!rows.length) return { content: 'The Secure Vault is empty. The user can add logins in the app: Settings > Secure Vault.', summary: 'No saved logins' };
    return { content: rows.map((r) => `- ${r.name}: site ${r.domain}, username ${r.username || '(none)'}${r.hasPassword ? ', password saved' : ''}`).join('\n'), summary: `${rows.length} saved login${rows.length === 1 ? '' : 's'}` };
  },
});

export const deleteNoteTool = defineTool({
  name: 'delete_note',
  description: 'Delete one of the user\'s notes by id (asks the user to approve first).',
  schema: z.object({ id: z.string().min(1) }),
  label: () => 'Deleting a note…',
  approval: (a, ctx) => {
    const n = ctx.services.store.getNote(ctx.owner, a.id);
    return n ? { title: 'Delete note', body: `Orin wants to delete the note "${n.title}". This cannot be undone.`, fields: [{ label: 'Note', value: n.title }] } : null;
  },
  handler: async (a, ctx) => (ctx.services.store.deleteNote(ctx.owner, a.id) ? { content: 'Note deleted.', summary: 'Note deleted' } : { ok: false, content: 'No note with that id.', summary: 'Not found' }),
});

export const listSchedulesTool = defineTool({
  name: 'list_schedules',
  description: "List the user's schedules (routines that run automatically) with ids, timing and next run.",
  schema: z.object({}),
  label: () => 'Checking schedules…',
  handler: async (_a, ctx) => {
    const list = ctx.services.store.listSchedules(ctx.owner);
    if (!list.length) return { content: 'No schedules.', summary: 'No schedules' };
    return {
      content: list.map((s) => `- ${s.title} (id ${s.id}): ${s.cron ? `cron "${s.cron}"` : `every ${Math.round((s.intervalSec ?? 0) / 60)} min`} ${s.timezone}, ${s.enabled ? `next ${new Date(s.nextRunAt).toISOString()}` : 'paused'}\n  ${s.prompt.slice(0, 200)}`).join('\n'),
      summary: `${list.length} schedule${list.length === 1 ? '' : 's'}`,
    };
  },
});

export const updateScheduleTool = defineTool({
  name: 'update_schedule',
  description: 'Change a schedule: title, instructions, timing (cron or every_minutes), timezone, or pause/resume with enabled.',
  schema: z.object({
    id: z.string().min(1),
    title: z.string().min(2).max(120).optional(),
    instructions: z.string().min(5).max(8000).optional(),
    cron: z.string().max(100).optional(),
    every_minutes: z.number().int().min(1).max(10080).optional(),
    timezone: z.string().max(60).optional(),
    enabled: z.boolean().optional(),
  }),
  label: () => 'Updating schedule…',
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    const cur = st.getSchedule(ctx.owner, a.id);
    if (!cur) return { ok: false, content: 'No schedule with that id.', summary: 'Not found' };
    const tz = a.timezone ?? cur.timezone;
    if (!isValidTimezone(tz)) return { ok: false, content: `Unknown timezone "${tz}".`, summary: 'Bad timezone' };
    const cron = a.cron !== undefined ? a.cron : a.every_minutes ? null : cur.cron;
    const intervalSec = a.every_minutes ? Math.max(a.every_minutes * 60, ctx.services.config.agent.scheduleMinIntervalSec) : a.cron ? null : cur.intervalSec;
    let nextRunAt = cur.nextRunAt;
    try {
      if (a.cron !== undefined || a.every_minutes || a.timezone || (a.enabled && !cur.enabled)) nextRunAt = computeNextRun({ cron, intervalSec, timezone: tz }, Date.now());
    } catch (e) {
      return { ok: false, content: `Invalid schedule: ${(e as Error).message}`, summary: 'Invalid schedule' };
    }
    const s = st.updateSchedule(ctx.owner, a.id, { title: a.title, prompt: a.instructions, cron, intervalSec, timezone: tz, enabled: a.enabled, nextRunAt });
    return { content: `Schedule updated. ${s?.enabled ? `Next run ${new Date(nextRunAt).toISOString()}.` : 'It is paused.'}`, summary: 'Schedule updated', display: s ? { kind: 'schedule', id: s.id, title: s.title, nextRunAt } : undefined };
  },
});

// ---- workspace files (artifacts)
export const writeFileTool = defineTool({
  name: 'write_file',
  description: "Create or overwrite a file in the user's workspace (an artifact they can open from the chat), e.g. report.md, data.csv, page.html, script.js. Text only, up to 1 MB.",
  schema: z.object({ path: z.string().min(1).max(200), content: z.string().max(1_000_000) }),
  label: (a) => `Writing ${a.path}…`,
  writes: true,
  handler: async (a, ctx) => {
    const f = writeWsFile(workspaceDir(ctx.services, ctx.owner), a.path, a.content);
    return { content: `Saved ${f.path} (${f.size} bytes). The user can open it from the chat.`, summary: `Saved ${f.path}`, display: { kind: 'file', path: f.path, size: f.size } };
  },
});

export const readFileTool = defineTool({
  name: 'read_file',
  description: "Read a text file from the user's workspace.",
  schema: z.object({ path: z.string().min(1).max(200) }),
  label: (a) => `Reading ${a.path}…`,
  handler: async (a, ctx) => {
    const buf = readWsFile(workspaceDir(ctx.services, ctx.owner), a.path);
    return { content: buf.subarray(0, 30_000).toString('utf8') + (buf.length > 30_000 ? '\n…(truncated)' : ''), summary: `Read ${a.path}` };
  },
});

export const listFilesTool = defineTool({
  name: 'list_files',
  description: "List the files in the user's workspace.",
  schema: z.object({}),
  label: () => 'Listing files…',
  handler: async (_a, ctx) => {
    const files = listFiles(workspaceDir(ctx.services, ctx.owner));
    return { content: files.length ? files.map((f) => `- ${f.path} (${f.size} bytes)`).join('\n') : 'The workspace is empty.', summary: `${files.length} file${files.length === 1 ? '' : 's'}` };
  },
});

export const deleteFileTool = defineTool({
  name: 'delete_file',
  description: "Delete a file from the user's workspace (asks the user to approve first).",
  schema: z.object({ path: z.string().min(1).max(200) }),
  label: (a) => `Deleting ${a.path}…`,
  approval: (a) => ({ title: 'Delete file', body: `Orin wants to delete ${a.path} from your files. This cannot be undone.`, fields: [{ label: 'File', value: a.path }] }),
  handler: async (a, ctx) => (deleteWsFile(workspaceDir(ctx.services, ctx.owner), a.path) ? { content: `Deleted ${a.path}.`, summary: 'File deleted' } : { ok: false, content: 'No such file.', summary: 'Not found' }),
});

// ---- hosting: check a site the agent built, then put it live on Orin's server or Hugging Face
type Plan = ReturnType<typeof planSite>;
/** the checked plan made while preparing the approval card, reused by the handler (same args object) */
const plans = new WeakMap<object, { plan: Plan; block: string | null; token: string | null; diff: SiteDiff | null }>();

function prepare(a: { name: string; folder?: string; host?: 'orin' | 'huggingface' }, ctx: ToolContext) {
  const cached = plans.get(a);
  if (cached) return cached;
  const plan = planSite(ctx.services, ctx.owner, workspaceDir(ctx.services, ctx.owner), a.name, a.folder ?? '');
  let token: string | null = null;
  let block: string | null = plan.errors.length ? `The site has problems, so nothing was published and the user was not asked:\n- ${plan.errors.join('\n- ')}\nFix them with write_file and call publish_site again.` : null;
  if (!block && a.host === 'huggingface') {
    token = findHfToken(ctx.services, ctx.owner.split('#')[0]!);
    if (!token) block = `Not published to Hugging Face: there is no Hugging Face access token in the Secure Vault. ${HF_TOKEN_HELP} Tell the user exactly this in one or two sentences. Meanwhile you can publish the same site on Orin (host "orin") so they have a working link now.`;
  }
  let diff: SiteDiff | null = null;
  if (!block && a.host !== 'huggingface') {
    diff = diffPlan(ctx.services, plan);
    if (diff.live && !diff.added.length && !diff.changed.length && !diff.removed.length) {
      block = `Nothing to publish: the live site ${siteBaseUrl(ctx.services)}/v1/sites/${plan.slug}/ already matches ${plan.folder ? `${plan.folder}/` : 'the workspace'} exactly, so the user was not asked. If you meant to change it, edit the files with write_file first (preview_site lets you test the change).`;
    }
  }
  const out = { plan, block, token, diff };
  plans.set(a, out);
  return out;
}

function planReport(plan: Plan): string {
  return [plan.fixes.length ? `Automatic fixes: ${plan.fixes.join(' ')}` : '', plan.warnings.length ? `Warnings (worth fixing, not blocking): ${plan.warnings.join(' ')}` : ''].filter(Boolean).join('\n');
}

export const publishSiteTool = defineTool({
  name: 'publish_site',
  description:
    "Publish a website from the user's workspace at a public https link, and check that the link really works. Write the files first with write_file, each site in its own folder (sites/<name>/index.html plus .css/.js/images), then call this with the site name and folder. " +
    'host "orin" (default) puts it on Orin\'s own server right away; host "huggingface" creates or updates a public static Space on the user\'s Hugging Face account (needs a Hugging Face token in the Secure Vault). ' +
    'The files are checked first (missing files, broken links, JavaScript syntax errors): if there are problems nothing is published and you get the list to fix. Publishing again with the same name updates the site. Static sites only: HTML, CSS, client-side JavaScript, images, fonts, JSON. Only give the user a link this tool reported as live.',
  schema: z.object({
    name: z.string().min(1).max(60).describe('Short site name, used in the address, e.g. "portfolio". Use the same name to update a site.'),
    folder: z.string().max(200).optional().describe('Workspace folder holding index.html, e.g. "sites/portfolio"; omit only when index.html is at the top level'),
    host: z.enum(['orin', 'huggingface']).optional().describe('Where to publish: "orin" (default) or "huggingface"'),
  }),
  label: (a) => (a.host === 'huggingface' ? `Publishing ${a.name} to Hugging Face…` : `Publishing ${a.name}…`),
  writes: true,
  timeoutMs: 180_000,
  approval: (a, ctx) => {
    const p = prepare(a, ctx);
    if (p.block) return null; // nothing will be published: the handler reports the problems
    const hf = a.host === 'huggingface';
    const update = !hf && Boolean(p.diff?.live);
    return {
      title: hf ? 'Publish to Hugging Face' : update ? 'Update live site' : 'Publish website',
      body: hf
        ? `Orin wants to publish the site "${p.plan.name}" as a public Space on your Hugging Face account. Anyone can open it.`
        : update
          ? `Orin wants to replace the live version of "${p.plan.name}" with the edited one. Everyone with the link sees the change right away.`
          : `Orin wants to put the site "${p.plan.name}" live at a public link. Anyone with the link can open it.`,
      fields: [
        { label: 'Site', value: p.plan.name },
        { label: 'Where', value: hf ? `huggingface.co/spaces/<your account>/${hfSpaceName(p.plan.name)}` : `${siteBaseUrl(ctx.services)}/v1/sites/${p.plan.slug}/` },
        update && p.diff ? { label: 'Changes', value: describeDiff(p.diff) } : { label: 'Files', value: `${p.plan.files.length} from ${p.plan.folder ? `${p.plan.folder}/` : 'the workspace top level'}` },
      ],
    };
  },
  handler: async (a, ctx) => {
    const p = prepare(a, ctx);
    if (p.block) return { ok: false, content: p.block, summary: a.host === 'huggingface' && !p.token && !p.plan.errors.length ? 'Needs a Hugging Face token' : 'Site has problems' };
    const report = planReport(p.plan);
    const index = p.plan.files.find((f) => f.path === 'index.html')!;
    const assets = p.plan.files.filter((f) => !/\.html?$/i.test(f.path)).map((f) => f.path.split('/').map(encodeURIComponent).join('/'));
    if (a.host === 'huggingface') {
      ctx.secrets ??= new Set();
      ctx.secrets.add(p.token!);
      let r;
      try {
        r = await deployToHuggingFace(ctx.services, p.token!, p.plan.name, p.plan.files, ctx.signal);
      } catch (e) {
        const msg = (e as Error).message;
        return { ok: false, content: `Not published to Hugging Face: ${msg}${e instanceof HostError && e.needsUser ? '' : ' You can retry once, or publish on Orin (host "orin") instead.'}`, summary: 'Hugging Face publish failed' };
      }
      const v = await verifyPublicUrl(ctx.services, r.url, fingerprint(index.data), { assets, signal: ctx.signal, tries: 8, delayMs: 2500 });
      if (!v.ok) {
        return {
          ok: false,
          content: `The files are uploaded to the Hugging Face Space ${r.pageUrl} (${r.files} files), but the site link ${r.url} is not working yet: ${v.detail}. Do not tell the user it is live. Tell them it is uploaded and Hugging Face is still starting it, and check again with check_site (url ${r.url}) in a minute.${report ? `\n${report}` : ''}`,
          summary: 'Uploaded, not live yet',
          display: { kind: 'page', url: r.pageUrl, title: a.name },
        };
      }
      return {
        content: `Live and checked on Hugging Face: ${r.url} (Space page: ${r.pageUrl}, ${r.files} files${r.created ? ', new Space' : ', updated'}). Give the user the link.${report ? `\n${report}` : ''}`,
        summary: `Live: ${r.url}`,
        display: { kind: 'page', url: r.url, title: a.name },
      };
    }
    let r;
    try {
      r = publishPlan(ctx.services, ctx.owner, p.plan);
    } catch (e) {
      return { ok: false, content: `Could not publish: ${(e as Error).message}`, summary: 'Publish failed' };
    }
    const v = await verifyPublicUrl(ctx.services, r.url, fingerprint(index.data), { assets, signal: ctx.signal });
    if (!v.ok) {
      return {
        ok: false,
        content: `The site files were copied, but the public link ${r.url} failed its check: ${v.detail}. Do not tell the user it is live. Say the publish step ran but the link check failed, and offer to try again.${report ? `\n${report}` : ''}`,
        summary: 'Published, link check failed',
      };
    }
    dropPreview(ctx.services, p.plan.slug);
    return {
      content: `${r.updated ? 'Updated' : 'Published'} and checked: ${r.url} loads (${r.files} files, ${Math.ceil(r.bytes / 1024)} KB). Give the user this link.${report ? `\n${report}` : ''}`,
      summary: `Live: ${r.url}`,
      display: { kind: 'page', url: r.url, title: a.name },
    };
  },
});

export const checkSiteTool = defineTool({
  name: 'check_site',
  description:
    'Check a website before or after publishing, without publishing anything: with name/folder it checks the workspace files (missing files, broken links, JavaScript syntax errors); with url it checks that a public link loads.',
  schema: z.object({ name: z.string().max(60).optional(), folder: z.string().max(200).optional(), url: z.string().url().max(500).optional() }),
  label: (a) => (a.url ? 'Checking the link…' : 'Checking the site…'),
  timeoutMs: 60_000,
  handler: async (a, ctx) => {
    if (a.url) {
      const v = await verifyPublicUrl(ctx.services, a.url, '', { signal: ctx.signal, tries: 3 });
      return v.ok ? { content: `${a.url} loads (HTTP 200).`, summary: 'Link works' } : { ok: false, content: `${a.url}: ${v.detail}.`, summary: 'Link not working' };
    }
    const plan = planSite(ctx.services, ctx.owner, workspaceDir(ctx.services, ctx.owner), a.name || a.folder || 'site', a.folder ?? '');
    const report = planReport(plan);
    if (plan.errors.length) return { ok: false, content: `Problems to fix before publishing:\n- ${plan.errors.join('\n- ')}${report ? `\n${report}` : ''}`, summary: `${plan.errors.length} problem${plan.errors.length === 1 ? '' : 's'}` };
    return { content: `Ready to publish: ${plan.files.length} files from ${plan.folder ? `${plan.folder}/` : 'the top level'} (${plan.files.map((f) => f.path).slice(0, 15).join(', ')}).${report ? `\n${report}` : ''}`, summary: 'Site looks good' };
  },
});

export const unpublishSiteTool = defineTool({
  name: 'unpublish_site',
  description: 'Take down a site this user published with publish_site (asks the user to approve first).',
  schema: z.object({ name: z.string().min(1).max(80) }),
  label: (a) => `Taking down ${a.name}…`,
  approval: (a) => ({ title: 'Take site down', body: `Orin wants to remove the published site "${a.name}". The link will stop working.`, fields: [{ label: 'Site', value: a.name }] }),
  handler: async (a, ctx) => (unpublishSite(ctx.services, ctx.owner, a.name) && (dropPreview(ctx.services, siteSlug(a.name, ctx.owner)), true) ? { content: `Took down ${a.name}.`, summary: 'Site removed' } : { ok: false, content: 'No site of yours by that name.', summary: 'Not found' }),
});

export const listSitesTool = defineTool({
  name: 'list_sites',
  description: "List the websites this user has live on Orin (name, link, files, last update). Use it when they ask to change, fix or reopen a site they made before.",
  schema: z.object({}),
  label: () => 'Looking up your sites…',
  handler: async (_a, ctx) => {
    const sites = listSites(ctx.services, ctx.owner);
    if (!sites.length) return { content: 'This user has no sites live on Orin yet.', summary: 'No sites yet' };
    return {
      content: sites.map((s) => `- ${s.name}: ${s.url} (${s.files} files, ${Math.ceil(s.bytes / 1024)} KB, updated ${new Date(s.updatedAt).toISOString().slice(0, 16).replace('T', ' ')} UTC)`).join('\n') + '\nTo edit one, call open_site with its name.',
      summary: `${sites.length} site${sites.length === 1 ? '' : 's'}`,
    };
  },
});

export const openSiteTool = defineTool({
  name: 'open_site',
  description:
    "Reopen one of the user's live Orin sites for editing. Makes sure its files are in the workspace (sites/<name>/), copying them from the live site when they are missing, and lists them. Then read_file / write_file to edit, preview_site to test the change at a private link, and publish_site (same name) to update the live site; the live site does not change until the user approves that publish. overwrite=true throws away unpublished edits in the workspace and starts again from the live version.",
  schema: z.object({ name: z.string().min(1).max(80).describe('Site name (or its link) from list_sites'), overwrite: z.boolean().optional() }),
  label: (a) => `Opening ${a.name} for editing…`,
  writes: true,
  handler: async (a, ctx) => {
    let r;
    try {
      r = openSite(ctx.services, ctx.owner, workspaceDir(ctx.services, ctx.owner), a.name, Boolean(a.overwrite));
    } catch (e) {
      return { ok: false, content: (e as Error).message, summary: 'Site not found' };
    }
    const pending = r.pendingEdits ? ` The workspace copy already has unpublished edits compared with the live site: ${describeDiff(r.pendingEdits)}. Kept them (pass overwrite=true only if the user wants to start over from the live version).` : '';
    return {
      content: `${r.restored ? 'Copied the live site into' : 'The site is already in'} the workspace folder ${r.folder}/ (live at ${r.url}). Files: ${r.files.slice(0, 30).join(', ')}.${pending} Edit with read_file/write_file, then preview_site with name "${r.name}" and folder "${r.folder}", then publish_site with the same name and folder.`,
      summary: r.restored ? `Opened ${r.name} (${r.files.length} files)` : `${r.name} is ready to edit`,
    };
  },
});

export const previewSiteTool = defineTool({
  name: 'preview_site',
  description:
    'Test an edited (or new) site before it goes live: checks the workspace files, puts them at a private preview link (unlisted, replaced by the next preview), confirms the link loads, and says what would change on the live site. Nothing live changes and the user is not asked. Share the preview link so the user can look, then publish_site with the same name to make it live (that asks the user to approve).',
  schema: z.object({ name: z.string().min(1).max(60), folder: z.string().max(200).optional() }),
  label: (a) => `Previewing ${a.name}…`,
  writes: true,
  timeoutMs: 90_000,
  handler: async (a, ctx) => {
    const plan = planSite(ctx.services, ctx.owner, workspaceDir(ctx.services, ctx.owner), a.name, a.folder ?? '');
    const report = planReport(plan);
    if (plan.errors.length) return { ok: false, content: `No preview made; problems to fix first:\n- ${plan.errors.join('\n- ')}${report ? `\n${report}` : ''}`, summary: `${plan.errors.length} problem${plan.errors.length === 1 ? '' : 's'}` };
    let r;
    try {
      r = previewPlan(ctx.services, ctx.owner, plan);
    } catch (e) {
      return { ok: false, content: `Could not make a preview: ${(e as Error).message}`, summary: 'Preview failed' };
    }
    const index = plan.files.find((f) => f.path === 'index.html')!;
    const assets = plan.files.filter((f) => !/\.html?$/i.test(f.path)).map((f) => f.path.split('/').map(encodeURIComponent).join('/'));
    const v = await verifyPublicUrl(ctx.services, r.url, fingerprint(index.data), { assets, signal: ctx.signal });
    const live = `${siteBaseUrl(ctx.services)}/v1/sites/${plan.slug}/`;
    const change = r.diff.live ? `Compared with the live site ${live}: ${describeDiff(r.diff)}.` : 'This site is not live yet.';
    if (!v.ok) return { ok: false, content: `The preview link ${r.url} failed its check: ${v.detail}. ${change}${report ? `\n${report}` : ''}`, summary: 'Preview link not working' };
    return {
      content: `Preview checked and working: ${r.url} (private, not the live link). ${change} The live site is unchanged. Give the user the preview link; when they are happy, call publish_site with name "${plan.name}"${plan.folder ? ` and folder "${plan.folder}"` : ''}, which asks them to approve the update.${report ? `\n${report}` : ''}`,
      summary: `Preview: ${describeDiff(r.diff)}`,
      display: { kind: 'page', url: r.url, title: `${a.name} (preview)` },
    };
  },
});

export const extraTools = [askUserTool, askSecretTool, askUserStepTool, vaultListTool, deleteNoteTool, listSchedulesTool, updateScheduleTool, writeFileTool, readFileTool, listFilesTool, deleteFileTool, publishSiteTool, checkSiteTool, unpublishSiteTool, listSitesTool, openSiteTool, previewSiteTool];
