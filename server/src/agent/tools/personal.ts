import { z } from 'zod';
import { applyEdits, notePreview } from '../pages.js';
import { defineTool } from './types.js';
import { searchEpisodes, searchMemory, whenText } from '../memory.js';
import { MemorySecretError } from '../memorySafety.js';

// ---------------- memory ----------------
// Long-term memory per character (agent/memory.ts). Secrets are refused (agent/memorySafety.ts).
const KINDS = ['profile', 'preference', 'project', 'person', 'fact'] as const;

/** A memory by id, or the one whose words match best (for corrections). */
function findMemory(owner: string, store: import('../store.js').AgentStore, idOrText: string) {
  const byId = store.getMemory(owner, idOrText.trim());
  if (byId) return byId;
  const q = idOrText.trim().toLowerCase();
  const all = store.listMemories(owner, 500);
  return all.find((m) => m.text.toLowerCase() === q) ?? all.find((m) => m.text.toLowerCase().includes(q)) ?? searchMemory(store, owner, idOrText, 1)[0] ?? null;
}

export const rememberTool = defineTool({
  name: 'remember',
  writes: true,
  description:
    'Save a durable fact about the user to long-term memory (who they are, preferences, people, project details) so you can use it in future chats and calls. ' +
    'To correct something you remember, pass replaces with the old memory\'s id or words: the old version is replaced, not kept beside the new one. Never save passwords, keys or codes (the Secure Vault is for those).',
  schema: z.object({
    fact: z.string().min(2).max(500).describe('The fact, written in third person, e.g. "User\'s sister is called Mira"'),
    kind: z.enum(KINDS).optional().describe('profile (name, job, location), preference, project (details of something they are building), person, or fact'),
    about_project: z.boolean().optional().describe('true when it is a detail of the project this chat belongs to'),
    replaces: z.string().max(300).optional().describe('id or words of the memory this corrects or updates'),
    tags: z.string().max(100).optional().describe('Optional comma-separated tags'),
  }),
  label: () => 'Saving to memory…',
  handler: async (a, ctx) => {
    const store = ctx.services.store;
    const fact = a.fact.trim();
    const project = a.about_project && ctx.project ? ctx.project : undefined;
    try {
      const old = a.replaces ? findMemory(ctx.owner, store, a.replaces) : null;
      if (old) {
        const m = store.updateMemory(ctx.owner, old.id, { text: fact, source: 'user', ...(a.kind ? { kind: a.kind } : {}), ...(project ? { project } : {}) })!;
        return { content: `Updated memory (id ${m.id}): was "${old.text}", now "${m.text}"`, summary: 'Updated memory', display: { kind: 'memory', action: 'saved', items: [m.text] } };
      }
      const m = store.addMemory(ctx.owner, fact, a.tags ?? '', { kind: a.kind, source: 'user', project, conversationId: ctx.conversationId });
      return { content: `Saved to memory (id ${m.id}): ${m.text}`, summary: 'Saved to memory', display: { kind: 'memory', action: 'saved', items: [m.text] } };
    } catch (err) {
      if (err instanceof MemorySecretError) return { ok: false, content: `${err.message} Nothing was saved. If it is a login, ask the user to save it in Settings > Secure Vault.`, summary: 'Not saved: looks like a secret' };
      throw err;
    }
  },
});

export const recallTool = defineTool({
  name: 'recall',
  writes: true,
  description: 'Search long-term memory: facts about the user and summaries of earlier conversations. Use when the user refers to something they told you before or something you talked about in another chat or call.',
  schema: z.object({ query: z.string().max(200).describe('What to look for; empty returns the most recent memories') }),
  label: () => 'Checking memory…',
  handler: async (a, ctx) => {
    const found = searchMemory(ctx.services.store, ctx.owner, a.query, 10, ctx.project);
    const talks = searchEpisodes(ctx.services.store, ctx.owner, a.query, 3, { project: ctx.project, exclude: ctx.conversationId });
    if (!found.length && !talks.length) return { content: 'No matching memories.', summary: 'Nothing in memory' };
    const lines = [
      ...found.map((m) => `- (${m.id}) ${m.text}${m.project ? ` [project: ${m.project}]` : ''}`),
      ...(talks.length ? ['Earlier conversations:', ...talks.map((e) => `- ${whenText(e.updatedAt)}: ${e.title}. ${e.summary}`)] : []),
    ];
    return {
      content: lines.join('\n'),
      summary: `Recalled ${found.length + talks.length} ${found.length + talks.length === 1 ? 'memory' : 'memories'}`,
      display: { kind: 'memory', action: 'recalled', items: [...found.map((m) => m.text), ...talks.map((e) => e.title)] },
    };
  },
});

export const forgetTool = defineTool({
  name: 'forget',
  writes: true,
  description: 'Delete memories when the user asks you to forget something. Pass a memory id or words from the memory. Also forgets matching earlier conversations.',
  schema: z.object({ what: z.string().min(1).max(300) }),
  label: () => 'Forgetting…',
  handler: async (a, ctx) => {
    const store = ctx.services.store;
    const gone = store.forgetMemories(ctx.owner, a.what);
    const q = a.what.trim().toLowerCase();
    const talks = q.length >= 4 ? store.listEpisodes(ctx.owner, 200).filter((e) => e.title.toLowerCase().includes(q)).slice(0, 3) : [];
    for (const e of talks) store.deleteEpisode(ctx.owner, e.id);
    if (!gone.length && !talks.length) return { ok: false, content: 'No matching memory was found, nothing deleted.', summary: 'Nothing to forget' };
    const items = [...gone.map((m) => m.text), ...talks.map((e) => `Conversation: ${e.title}`)];
    return { content: `Deleted ${items.length}: ${items.join('; ')}`, summary: 'Forgot it', display: { kind: 'memory', action: 'forgot', items } };
  },
});

// ---------------- notes & pages ----------------
const findNote = (ctx: { owner: string; services: { store: import('../store.js').AgentStore } }, idOrTitle: string) =>
  ctx.services.store.getNote(ctx.owner, idOrTitle) ?? ctx.services.store.findNoteByTitle(ctx.owner, idOrTitle);
const noteCard = (n: import('../store.js').Note) => ({ kind: 'note' as const, id: n.id, title: n.title, format: n.kind, preview: notePreview(n) });

export const createNoteTool = defineTool({
  name: 'create_note',
  writes: true,
  description:
    'Write a Markdown note the user keeps in Notes & pages: a plan, list, draft, summary, research write-up or document. It shows as a card under your reply that opens the full note, so in chat say only the one thing that matters and let the note hold the rest. For a designed, visual result (a page, report with layout, comparison, guide) use create_page instead.',
  schema: z.object({ title: z.string().min(1).max(200).describe('A clear title, as the user would name it'), body: z.string().max(100_000).describe('Markdown content: short headings, lists, tables, links') }),
  label: (a) => `Writing note “${a.title.slice(0, 40)}”…`,
  handler: async (a, ctx) => {
    const n = ctx.services.store.createNote(ctx.owner, a.title, a.body, ctx.mode === 'task' ? 'task' : 'chat', 'note');
    return { content: `Note created (id ${n.id}): "${n.title}". The user sees it as a card under your reply.`, summary: 'Note saved', display: noteCard(n) };
  },
});

export const updateNoteTool = defineTool({
  name: 'update_note',
  writes: true,
  description:
    'Change an existing note or page by id or exact title. Prefer `edits` (exact text replacements, each old text appearing once) for small changes; `body` replaces everything; `append` adds to the end; `title` renames. The version before the change is kept, so the user can restore it.',
  schema: z.object({
    id_or_title: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    edits: z.array(z.object({ old: z.string().min(1).max(20_000), new: z.string().max(50_000) })).max(30).optional().describe('Exact replacements, applied in order'),
    body: z.string().max(100_000).optional().describe('Replaces the whole body'),
    append: z.string().max(50_000).optional().describe('Appended to the end'),
  }),
  label: () => 'Updating note…',
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    const target = findNote(ctx, a.id_or_title);
    if (!target) return { ok: false, content: `No note or page found with id or title "${a.id_or_title}". Use list_notes.`, summary: 'Note not found' };
    let body = a.body;
    if (a.edits?.length) {
      const r = applyEdits(a.body ?? target.body, a.edits);
      if (!r.ok) return { ok: false, content: `${r.error} Nothing was changed.`, summary: 'Edit did not match' };
      body = r.body;
    }
    const n = st.updateNote(ctx.owner, target.id, { title: a.title, body, append: body === undefined ? a.append : undefined })!;
    return { content: `${n.kind === 'page' ? 'Page' : 'Note'} updated: "${n.title}" (id ${n.id}). The earlier version is kept for restore.`, summary: `${n.kind === 'page' ? 'Page' : 'Note'} updated`, display: noteCard(n) };
  },
});

export const listNotesTool = defineTool({
  name: 'list_notes',
  description: 'List or search the user\'s notes and pages. Returns ids, kinds, titles and the start of each.',
  schema: z.object({ query: z.string().max(200).optional(), kind: z.enum(['note', 'page']).optional() }),
  label: () => 'Looking through notes…',
  handler: async (a, ctx) => {
    const notes = ctx.services.store.listNotes(ctx.owner, a.query ?? '', 20, a.kind);
    if (!notes.length) return { content: a.query ? `Nothing matches "${a.query}".` : 'No notes or pages yet.', summary: 'No notes' };
    return { content: notes.map((n) => `- [${n.kind}] ${n.title} (id ${n.id}, updated ${new Date(n.updatedAt).toISOString()}): ${notePreview(n, 160)}`).join('\n'), summary: `${notes.length} notes` };
  },
});

export const readNoteTool = defineTool({
  name: 'read_note',
  description: 'Read the full text of a note, or the HTML of a page, by id or exact title.',
  schema: z.object({ id_or_title: z.string().min(1).max(200) }),
  label: () => 'Reading note…',
  handler: async (a, ctx) => {
    const n = findNote(ctx, a.id_or_title);
    if (!n) return { ok: false, content: 'Note not found.', summary: 'Note not found' };
    const max = 40_000;
    const more = n.body.length > max ? `\n\n[… ${n.body.length - max} more characters not shown]` : '';
    return { content: `${n.kind === 'page' ? 'Page (HTML)' : 'Note'}: ${n.title} (id ${n.id})\n\n${n.body.slice(0, max)}${more}`, summary: `Read “${n.title.slice(0, 40)}”` };
  },
});

// ---------------- reminders ----------------
export const createReminderTool = defineTool({
  name: 'create_reminder',
  description:
    'Schedule a reminder notification on the user\'s phone. Only call this when you know the exact time; if the user did not say when, ask them first. Convert relative times ("in 20 minutes", "tomorrow 9am") using the current date/time and the user\'s timezone.',
  schema: z.object({
    text: z.string().min(1).max(300).describe('What to remind about, phrased for the notification'),
    due_at: z.string().min(10).max(40).optional().describe('ISO 8601 date-time with the user\'s timezone offset, e.g. 2026-10-15T09:00:00-07:00. Use for a clock time ("tomorrow 9am").'),
    in_minutes: z.number().positive().max(525600).optional().describe('For a relative time ("in 20 minutes", "in 2 hours"): minutes from now. The server does the maths; prefer this over due_at for relative times.'),
  }),
  label: () => 'Setting a reminder…',
  handler: async (a, ctx) => {
    const due = a.in_minutes ? Date.now() + a.in_minutes * 60_000 : Date.parse(a.due_at ?? '');
    if (!Number.isFinite(due)) return { ok: false, content: `"${a.due_at ?? ''}" is not a valid ISO date-time. Ask the user for the time or fix the format.`, summary: 'Invalid time' };
    if (due < Date.now() - 60_000) return { ok: false, content: `That time (${a.due_at}) is in the past. Check the date or ask the user.`, summary: 'Time is in the past' };
    const r = ctx.services.store.createReminder(ctx.owner, a.text, due);
    const when = new Date(due).toLocaleString('en-US', { timeZone: ctx.timezone || 'UTC', dateStyle: 'medium', timeStyle: 'short' });
    return {
      content: `Reminder saved (id ${r.id}) for ${when} (${ctx.timezone || 'UTC'}). The phone will show a notification then.`,
      summary: `Reminder set for ${when}`,
      display: { kind: 'reminder', id: r.id, text: r.text, dueAt: r.dueAt },
    };
  },
});

export const listRemindersTool = defineTool({
  name: 'list_reminders',
  description: 'List the user\'s upcoming reminders.',
  schema: z.object({}),
  label: () => 'Checking reminders…',
  handler: async (_a, ctx) => {
    const list = ctx.services.store.listReminders(ctx.owner, 'scheduled');
    if (!list.length) return { content: 'No upcoming reminders.', summary: 'No reminders' };
    return { content: list.map((r) => `- ${new Date(r.dueAt).toISOString()}: ${r.text} (id ${r.id})`).join('\n'), summary: `${list.length} reminders` };
  },
});

export const cancelReminderTool = defineTool({
  name: 'cancel_reminder',
  description: 'Cancel a reminder by id.',
  schema: z.object({ id: z.string().min(1) }),
  label: () => 'Cancelling reminder…',
  handler: async (a, ctx) => {
    const ok = ctx.services.store.setReminderStatus(ctx.owner, a.id, 'cancelled');
    return ok ? { content: 'Reminder cancelled.', summary: 'Reminder cancelled' } : { ok: false, content: 'No reminder with that id.', summary: 'Not found' };
  },
});
