import { z } from 'zod';
import { defineTool, type ToolDef } from './tools/types.js';
import type { ChatRequestBody } from '../schemas.js';

/**
 * Quick lane (task "make app responses smooth"): a plain conversational turn ("hey, how's your day",
 * "fun fact about the ocean") goes to the model with a short persona and a handful of tools instead of
 * the full ~44k-token work prompt and 55+ tool definitions. Measured on the live server, that prompt was
 * most of the wait before her first words and ate the free Gemini per-minute token quota fast.
 *
 * Nothing is lost: the quick lane carries more_tools. Calling it swaps in the full prompt and every
 * tool in the same reply (agent/loop.ts), so a turn that turns out to be work still gets done.
 */
export const MORE_TOOLS = 'more_tools';

/** Tools a conversational reply may need right away. Everything else is one more_tools call away. */
export const QUICK_TOOL_NAMES = ['web_search', 'fetch_page', 'recall', 'remember', 'calculator', 'get_datetime'];

export const moreToolsTool: ToolDef = defineTool({
  name: MORE_TOOLS,
  description:
    'Opens your full toolkit: building and publishing websites and apps, your computer (sandbox), files, uploads, code, notes, ' +
    'reminders, schedules, tasks, skills, research, images, browser and sign-ins, Secure Vault, email, and the user\'s running work. ' +
    'Call it first whenever the user wants anything done beyond a quick answer, or asks about their work or tasks. No arguments.',
  schema: z.object({}),
  label: () => 'Getting ready…',
  handler: async () => ({ ok: true, content: 'Your full toolkit and work instructions are open now. Carry on with what the user asked.', summary: 'Toolkit open' }),
});

// Words that mean work, a follow-up to work, or something only the full toolkit can see.
const WORK =
  /\b(build|built|code|coding|deploy|publish|host|hosting|site|website|web ?app|app|apk|android|ios|file|files|folder|zip|upload|project|repo|github|git|fix|debug|bug|error|run|install|script|sandbox|server|render|schedule|remind|reminder|alarm|note|notes|task|tasks|todo|email|e-mail|mail|gmail|inbox|send|book|buy|order|pay|sign ?in|log ?in|login|password|vault|api|key|token|browse|browser|open|download|image|picture|photo|draw|generate|research|report|skill|skills|calendar|deliver|edit|update|delete|remove|change|rename|continue|carry on|resume|retry|again|keep going|status|progress|done yet|finished|approve|approval|card|preview|test|html|css|javascript|python|typescript|pdf|doc|document|spreadsheet|write me|draft|plan|blueprint|handoff|slack|notion|discord|telegram|whatsapp|message|post|tweet|connect|link|mcp|install|learn|from now on)\b/i;
const FOLLOW_UP = /^(yes|yeah|yep|yup|ok|okay|k|sure|go|go ahead|do it|please|pls|continue|proceed|approved?|sounds good|perfect|great|cool|alright|right|that one|the first|the second|both|all of them|no|nope|stop|cancel|wait)\b/i;

function lastUser(body: ChatRequestBody) {
  return [...body.messages].reverse().find((m) => m.role === 'user');
}

/** True when this turn is plain conversation that the quick lane can answer. */
export function wantsQuickLane(body: ChatRequestBody, enabled = true): boolean {
  if (!enabled) return false;
  const last = lastUser(body) as (ChatRequestBody['messages'][number] & { images?: unknown[]; documents?: unknown[]; upload?: unknown; uploads?: unknown[] }) | undefined;
  if (!last || typeof last.content !== 'string') return false;
  if (last.images?.length || last.documents?.length || last.upload || last.uploads?.length) return false;
  const text = last.content.trim();
  if (!text || text.length > (body.mode === 'voice' ? 400 : 300)) return false;
  if (/https?:\/\/|www\.|```|\.[a-z]{2,4}\b\//i.test(text)) return false;
  if (WORK.test(text)) return false;
  // a short "yes"/"do it" answers whatever came before: if that was work, it needs the full toolkit
  if (text.length < 40 && FOLLOW_UP.test(text) && body.messages.some((m) => m.role === 'assistant')) return false;
  return true;
}

/** The quick lane's tools: the few conversational ones that are available here, plus more_tools. */
export function quickTools(all: ToolDef[]): ToolDef[] {
  return [...all.filter((t) => QUICK_TOOL_NAMES.includes(t.name)), moreToolsTool];
}
