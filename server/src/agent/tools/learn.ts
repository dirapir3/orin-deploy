import { z } from 'zod';
import { defineTool } from './types.js';

/**
 * learn_lesson: how Orin improves herself between conversations. When she solves something only
 * after a failure, finds a better way, or the user corrects her work, she saves one short reusable
 * rule. Lessons are stored per agent (memories tagged "lesson") and every later chat, call and
 * task starts with them in the system prompt (agent/persona.ts), so the same mistake is not made twice.
 */
export const LESSON_TAG = 'lesson';
const SECRETISH = /(api[_-]?key|password|secret|token|bearer)\s*[:=]|\b(sk|pk|AIza|ghp|hf)_?[A-Za-z0-9_-]{16,}/i;

export const learnLessonTool = defineTool({
  name: 'learn_lesson',
  writes: true,
  description:
    'Improve yourself: save one short, general rule you learned from your own work so every future chat, call and task uses it. Use it when you solved something only after a failure (what fixed it) or found a better way to do a kind of job. When the USER corrects you or tells you their taste, use remember_know_how (kind correction / preference) instead, so it keeps where it came from. ' +
    'Write it as an instruction to yourself, reusable beyond this one case, e.g. "Capacitor builds: run npx cap sync before gradle, or the web files are stale". Never include secrets, keys or private data.',
  schema: z.object({
    lesson: z.string().min(10).max(300).describe('The rule, as an instruction to yourself'),
    topic: z.string().max(40).optional().describe('Short topic, e.g. android, design, websites, email'),
  }),
  label: () => 'Learning from this…',
  handler: async (a, ctx) => {
    const text = a.lesson.replace(/\s+/g, ' ').trim();
    if (SECRETISH.test(text)) return { ok: false, content: 'That lesson looks like it contains a secret. Rewrite it without keys, passwords or tokens.', summary: 'Not saved' };
    const tags = [LESSON_TAG, a.topic?.trim().toLowerCase().replace(/[^a-z0-9 -]/g, '')].filter(Boolean).join(',');
    const m = ctx.services.store.addMemory(ctx.owner, text, tags);
    return { content: `Lesson saved (id ${m.id}). You will start every future conversation with it.`, summary: 'Learned something', display: { kind: 'memory', action: 'saved', items: [text] } };
  },
});

/** Is this memory a lesson Orin taught herself (rather than a fact about the user)? */
export const isLesson = (tags: string): boolean => tags.split(',').map((t) => t.trim()).includes(LESSON_TAG);
