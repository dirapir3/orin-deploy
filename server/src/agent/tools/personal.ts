import { z } from 'zod';
import { defineTool } from './types.js';

// ---------------- memory ----------------
export const rememberTool = defineTool({
  name: 'remember',
  writes: true,
  description:
    'Save a durable fact about the user to long-term memory (preferences, names, important details) so you can use it in future conversations. Only save what the user would want remembered.',
  schema: z.object({
    fact: z.string().min(2).max(500).describe('The fact, written in third person, e.g. "User\'s sister is called Mira"'),
    tags: z.string().max(100).optional().describe('Optional comma-separated tags'),
  }),
  label: () => 'Saving to memory…',
  handler: async (a, ctx) => {
    const m = ctx.services.store.addMemory(ctx.owner, a.fact.trim(), a.tags ?? '');
    return { content: `Saved to memory (id ${m.id}): ${m.text}`, summary: 'Saved to memory', display: { kind: 'memory', action: 'saved', items: [m.text] } };
  },
});

export const recallTool = defineTool({
  name: 'recall',
  writes: true,
  description: 'Search long-term memory for facts about the user. Use when the user refers to something they told you before.',
  schema: z.object({ query: z.string().max(200).describe('What to look for; empty returns the most recent memories') }),
  label: () => 'Checking memory…',
  handler: async (a, ctx) => {
    const found = ctx.services.store.searchMemories(ctx.owner, a.query, 10);
    if (!found.length) return { content: 'No matching memories.', summary: 'Nothing in memory' };
    return {
      content: found.map((m) => `- (${m.id}) ${m.text}`).join('\n'),
      summary: `Recalled ${found.length} ${found.length === 1 ? 'memory' : 'memories'}`,
      display: { kind: 'memory', action: 'recalled', items: found.map((m) => m.text) },
    };
  },
});

export const forgetTool = defineTool({
  name: 'forget',
  writes: true,
  description: 'Delete memories when the user asks you to forget something. Pass a memory id or words from the memory.',
  schema: z.object({ what: z.string().min(1).max(300) }),
  label: () => 'Forgetting…',
  handler: async (a, ctx) => {
    const gone = ctx.services.store.forgetMemories(ctx.owner, a.what);
    if (!gone.length) return { ok: false, content: 'No matching memory was found, nothing deleted.', summary: 'Nothing to forget' };
    return { content: `Deleted ${gone.length}: ${gone.map((m) => m.text).join('; ')}`, summary: 'Forgot it', display: { kind: 'memory', action: 'forgot', items: gone.map((m) => m.text) } };
  },
});

// ---------------- notes ----------------
export const createNoteTool = defineTool({
  name: 'create_note',
  writes: true,
  description: 'Create a Markdown note the user can open in the Notes screen (lists, plans, drafts, summaries).',
  schema: z.object({ title: z.string().min(1).max(200), body: z.string().max(100_000).describe('Markdown content') }),
  label: (a) => `Writing note “${a.title.slice(0, 40)}”…`,
  handler: async (a, ctx) => {
    const n = ctx.services.store.createNote(ctx.owner, a.title, a.body, ctx.mode === 'task' ? 'task' : 'chat');
    return { content: `Note created (id ${n.id}): "${n.title}"`, summary: 'Note saved', display: { kind: 'note', id: n.id, title: n.title } };
  },
});

export const updateNoteTool = defineTool({
  name: 'update_note',
  writes: true,
  description: 'Update an existing note by id or exact title: replace the body, append text, or rename it.',
  schema: z.object({
    id_or_title: z.string().min(1).max(200),
    title: z.string().max(200).optional(),
    body: z.string().max(100_000).optional().describe('Replaces the whole body'),
    append: z.string().max(50_000).optional().describe('Appended to the end'),
  }),
  label: () => 'Updating note…',
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    const target = st.getNote(ctx.owner, a.id_or_title) ?? st.findNoteByTitle(ctx.owner, a.id_or_title);
    if (!target) return { ok: false, content: `No note found with id or title "${a.id_or_title}". Use list_notes.`, summary: 'Note not found' };
    const n = st.updateNote(ctx.owner, target.id, { title: a.title, body: a.body, append: a.append })!;
    return { content: `Note updated: "${n.title}" (id ${n.id})`, summary: 'Note updated', display: { kind: 'note', id: n.id, title: n.title } };
  },
});

export const listNotesTool = defineTool({
  name: 'list_notes',
  description: 'List or search the user\'s notes. Returns ids, titles and the start of each note.',
  schema: z.object({ query: z.string().max(200).optional() }),
  label: () => 'Looking through notes…',
  handler: async (a, ctx) => {
    const notes = ctx.services.store.listNotes(ctx.owner, a.query ?? '', 20);
    if (!notes.length) return { content: 'No notes found.', summary: 'No notes' };
    return { content: notes.map((n) => `- ${n.title} (id ${n.id}, updated ${new Date(n.updatedAt).toISOString()}): ${n.body.slice(0, 160).replace(/\n/g, ' ')}`).join('\n'), summary: `${notes.length} notes` };
  },
});

export const readNoteTool = defineTool({
  name: 'read_note',
  description: 'Read the full text of a note by id or exact title.',
  schema: z.object({ id_or_title: z.string().min(1).max(200) }),
  label: () => 'Reading note…',
  handler: async (a, ctx) => {
    const st = ctx.services.store;
    const n = st.getNote(ctx.owner, a.id_or_title) ?? st.findNoteByTitle(ctx.owner, a.id_or_title);
    if (!n) return { ok: false, content: 'Note not found.', summary: 'Note not found' };
    return { content: `# ${n.title}\n\n${n.body.slice(0, 20_000)}`, summary: `Read “${n.title.slice(0, 40)}”` };
  },
});

// ---------------- reminders ----------------
export const createReminderTool = defineTool({
  name: 'create_reminder',
  description:
    'Schedule a reminder notification on the user\'s phone. Only call this when you know the exact time; if the user did not say when, ask them first. Convert relative times ("in 20 minutes", "tomorrow 9am") using the current date/time and the user\'s timezone.',
  schema: z.object({
    text: z.string().min(1).max(300).describe('What to remind about, phrased for the notification'),
    due_at: z.string().min(10).max(40).describe('ISO 8601 date-time with timezone offset, e.g. 2026-10-15T09:00:00-07:00'),
  }),
  label: () => 'Setting a reminder…',
  handler: async (a, ctx) => {
    const due = Date.parse(a.due_at);
    if (!Number.isFinite(due)) return { ok: false, content: `"${a.due_at}" is not a valid ISO date-time. Ask the user for the time or fix the format.`, summary: 'Invalid time' };
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
