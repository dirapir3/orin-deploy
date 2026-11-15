/**
 * Pages and voice notes: what Orin makes for the user beyond plain chat text, like Sesame's
 * artifacts. Notes are in personal.ts (create_note / update_note / read_note / list_notes).
 */
import { z } from 'zod';
import { defineTool } from './types.js';
import { notePreview, unfence } from '../pages.js';

export const createPageTool = defineTool({
  name: 'create_page',
  writes: true,
  description: [
    'Make a designed HTML page the user opens full screen from a card under your reply: a report, guide, comparison, itinerary, dashboard, one-pager or small interactive tool.',
    'Send the BODY only (no <html>/<head>) and it is wrapped in the app\'s look: DM Sans text, Anton headings, light and dark mode, phone width, and ready classes .card (rounded panel), .muted, .pill; tables scroll sideways.',
    'Scripts and https images/fonts/CDNs work; forms, cookies and sign-ins do not. Keep it phone-first: one column, no fixed widths over 360px.',
    'Cite sources as links. In chat, say the one finding that matters; the page holds the rest.',
  ].join(' '),
  schema: z.object({
    title: z.string().min(1).max(200),
    html: z.string().min(20).max(200_000).describe('The page body HTML (a full document is also accepted)'),
  }),
  label: (a) => `Making page “${a.title.slice(0, 40)}”…`,
  handler: async (a, ctx) => {
    const html = unfence(a.html).trim();
    if (!/<[a-z][\s\S]*>/i.test(html)) return { ok: false, content: 'That is not HTML. Send the page body as HTML, or use create_note for Markdown.', summary: 'Not HTML' };
    const n = ctx.services.store.createNote(ctx.owner, a.title, html, ctx.mode === 'task' ? 'task' : 'chat', 'page');
    return {
      content: `Page created (id ${n.id}): "${n.title}". The user sees it as a card under your reply and opens it full screen. Change it later with update_note.`,
      summary: 'Page made',
      display: { kind: 'note', id: n.id, title: n.title, format: 'page', preview: notePreview(n) },
    };
  },
});

/** About 2.6 spoken words a second. */
export const spokenSeconds = (text: string) => Math.max(1, Math.round(text.trim().split(/\s+/).filter(Boolean).length / 2.6));

export const sendVoiceNoteTool = defineTool({
  name: 'send_voice_note',
  writes: true,
  description:
    'Send the user a voice note in your own voice: a play bubble in the chat that speaks the text. Use it when the user asks for one ("send me a voice note", "say it to me"), or for a warm short message they would rather hear. Write it the way you talk: plain spoken sentences, no lists, links, markdown or stage directions, under about 90 seconds.',
  schema: z.object({ text: z.string().min(1).max(2_000).describe('Exactly what you say') }),
  label: () => 'Recording a voice note…',
  handler: async (a, ctx) => {
    const text = a.text
      .replace(/[*_`#>]/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/https?:\/\/\S+/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!text) return { ok: false, content: 'The voice note has no words to say.', summary: 'Empty voice note' };
    const character = ctx.owner.includes('#') ? ctx.owner.split('#')[1]! : 'orin';
    const seconds = spokenSeconds(text);
    return {
      content: `Voice note sent (${seconds}s). The user taps play to hear it in your voice. Do not repeat its words in your reply.`,
      summary: 'Voice note sent',
      display: { kind: 'voice_note', text, character, seconds },
    };
  },
});

export const artifactTools = [createPageTool, sendVoiceNoteTool];
