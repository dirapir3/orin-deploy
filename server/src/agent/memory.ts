import type { ChatProvider } from '../ai/types.js';
import { logger } from '../logger.js';
import type { AgentStore, Memory, MemoryEpisode } from './store.js';
import { redactSecrets, secretProblem } from './memorySafety.js';

/**
 * Long-term memory, built on the memories table and the remembered past conversations
 * (memory_episodes), both per character owner (`u:<id>#<agent>`), so two accounts or two characters
 * never see each other's memories.
 *
 * - Facts: what the user said about themselves, their preferences, people and projects. The user adds
 *   them ("remember that...", the Memory page) or Orin learns them from a chat after the reply
 *   (learnFromTurn). Each has a kind and, for project details, the project it belongs to.
 * - Past conversations: a short title and summary per chat, so a new chat or call can pick up from
 *   what was discussed before.
 * - Recall (memoryContext): the facts that fit this message (keyword match weighted by rarity, the
 *   current project, the user's profile and preferences, recent ones) and the past conversations that
 *   fit, within a size budget so long memories do not slow every reply down.
 *
 * Settings per character: memory on/off and learning from chats on/off. Temporary (ghost) chats
 * neither read nor write memory. Secrets never get in (agent/memorySafety.ts).
 */

export const MEMORY_KINDS = ['profile', 'preference', 'project', 'person', 'fact'] as const;
export type MemoryKind = (typeof MEMORY_KINDS)[number];
export const normalizeKind = (k: unknown): MemoryKind => (MEMORY_KINDS.includes(k as MemoryKind) ? (k as MemoryKind) : 'fact');

const isLesson = (tags: string) => tags.split(',').map((t) => t.trim()).includes('lesson');

// ---------------- settings ----------------
export interface MemorySettings {
  /** use and save memory at all */
  enabled: boolean;
  /** learn facts and conversation summaries from chats on its own (explicit "remember" works either way) */
  learn: boolean;
}
const DEFAULT_SETTINGS: MemorySettings = { enabled: true, learn: true };

export function getMemorySettings(store: AgentStore, owner: string): MemorySettings {
  try {
    const r = store.db.prepare("SELECT value FROM setup_settings WHERE owner = ? AND key = 'memory'").get(owner) as { value?: string } | undefined;
    if (!r?.value) return { ...DEFAULT_SETTINGS };
    const v = JSON.parse(r.value) as Partial<MemorySettings>;
    return { enabled: v.enabled !== false, learn: v.learn !== false };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function setMemorySettings(store: AgentStore, owner: string, patch: Partial<MemorySettings>): MemorySettings {
  const next = { ...getMemorySettings(store, owner), ...Object.fromEntries(Object.entries(patch).filter(([, v]) => typeof v === 'boolean')) } as MemorySettings;
  store.db
    .prepare("INSERT INTO setup_settings (owner, key, value, updated_at) VALUES (?, 'memory', ?, ?) ON CONFLICT(owner, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at")
    .run(owner, JSON.stringify(next), Date.now());
  return next;
}

/** The memory tools are not offered when memory is off. */
export const MEMORY_TOOLS = new Set(['remember', 'recall', 'forget']);

// ---------------- recall ----------------
const STOP = new Set(
  'the and for are but not you your yours with this that these those have has had was were will would could should can just from into onto about what when where which who whom why how all any some our ours out off over then than them they their there here also very really like get got its it\'s i\'m dont don\'t does did doing done make made want need please okay yeah yes hey hello thanks thank much more most less one two lot let\'s lets tell said say know think going gonna wanna user user\'s'.split(' '),
);

/** Lower-case content words, roughly stemmed ("projects" ~ "project", "hosting" ~ "host"). */
export function memoryTerms(text: string): string[] {
  const out: string[] = [];
  for (let w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (w.length < 3 || STOP.has(w)) continue;
    if (w.length > 6 && w.endsWith('ing')) w = w.slice(0, -3);
    else if (w.length > 5 && w.endsWith('ed')) w = w.slice(0, -2);
    else if (w.length > 4 && w.endsWith('es') && !w.endsWith('ses')) w = w.slice(0, -2);
    else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
    out.push(w);
  }
  return out;
}

const sameProject = (a?: string, b?: string) => Boolean(a && b && a.trim().toLowerCase() === b.trim().toLowerCase());

/** Memories ranked for a query: rare matching words count most, then the current project, then how recent. */
export function rankMemories(memories: Memory[], query: string, opts: { project?: string; now?: number } = {}): { m: Memory; match: number; score: number }[] {
  const now = opts.now ?? Date.now();
  const docs = memories.map((m) => new Set(memoryTerms(`${m.text} ${m.tags} ${m.project ?? ''}`)));
  const df = new Map<string, number>();
  for (const d of docs) for (const w of d) df.set(w, (df.get(w) ?? 0) + 1);
  const q = new Set(memoryTerms(query));
  const N = Math.max(1, memories.length);
  return memories.map((m, i) => {
    let match = 0;
    for (const w of q) if (docs[i]!.has(w)) match += Math.log(1 + N / (df.get(w) ?? 1));
    const ageDays = Math.max(0, now - m.updatedAt) / 86_400_000;
    const score = match + (sameProject(m.project, opts.project) ? 1.5 : 0) + (m.kind === 'preference' || m.kind === 'profile' ? 0.3 : 0) + 0.5 * Math.exp(-ageDays / 30);
    return { m, match, score };
  });
}

/** Searches facts for the recall tool and the Memory page: best matches first; empty query = newest. */
export function searchMemory(store: AgentStore, owner: string, query: string, limit = 10, project?: string): Memory[] {
  const all = store.listMemories(owner, 500).filter((m) => !isLesson(m.tags));
  if (!memoryTerms(query).length) return all.slice(0, limit);
  return rankMemories(all, query, { project })
    .filter((x) => x.match > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((x) => x.m);
}

export function searchEpisodes(store: AgentStore, owner: string, query: string, limit = 5, opts: { project?: string; exclude?: string } = {}): MemoryEpisode[] {
  const eps = store.listEpisodes(owner, 200).filter((e) => e.conversationId !== opts.exclude);
  const q = new Set(memoryTerms(query));
  if (!q.size) return eps.slice(0, limit);
  return eps
    .map((e) => {
      const words = new Set(memoryTerms(`${e.title} ${e.summary} ${e.project}`));
      let match = 0;
      for (const w of q) if (words.has(w)) match++;
      return { e, match, score: match + (sameProject(e.project, opts.project) ? 1 : 0) };
    })
    .filter((x) => x.match > 0)
    .sort((a, b) => b.score - a.score || b.e.updatedAt - a.e.updatedAt)
    .slice(0, limit)
    .map((x) => x.e);
}

export function whenText(at: number, now = Date.now()): string {
  const days = Math.floor((now - at) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  if (days < 14) return 'last week';
  if (days < 60) return `${Math.round(days / 7)} weeks ago`;
  return `${Math.round(days / 30)} months ago`;
}

export interface MemoryRecall {
  memories: Memory[];
  episodes: MemoryEpisode[];
  /** past conversations as a prompt section ('' when none) */
  episodesText: string;
}

/**
 * What to bring into this message: the user's profile and preferences, the current project's details,
 * the facts that match what they just said, the newest facts, and the past conversations that fit.
 * Facts about other projects only come along when they match. Kept within a size budget.
 */
export function memoryContext(
  store: AgentStore,
  owner: string,
  o: { query: string; project?: string; conversationId?: string | null; budget?: 'full' | 'lite' | 'voice'; now?: number },
): MemoryRecall {
  const budget = o.budget ?? 'full';
  const maxFacts = budget === 'lite' ? 15 : budget === 'voice' ? 20 : 30;
  const maxChars = budget === 'lite' ? 2000 : budget === 'voice' ? 2500 : 4000;
  const all = store.listMemories(owner, 400).filter((m) => !isLesson(m.tags));
  const ranked = rankMemories(all, o.query, { project: o.project, now: o.now });
  const otherProject = (m: Memory) => Boolean(m.project) && !sameProject(m.project, o.project);
  const relevant = ranked.filter((x) => x.match > 0).sort((a, b) => b.score - a.score).slice(0, 10).map((x) => x.m);
  const project = o.project ? all.filter((m) => sameProject(m.project, o.project)).slice(0, 10) : [];
  const core = all.filter((m) => (m.kind === 'profile' || m.kind === 'preference') && !otherProject(m)).slice(0, 12);
  const recent = all.filter((m) => !otherProject(m)).slice(0, 10);
  const picked: Memory[] = [];
  let chars = 0;
  for (const m of [...relevant, ...project, ...core, ...recent]) {
    if (picked.length >= maxFacts) break;
    if (picked.some((p) => p.id === m.id)) continue;
    if (chars + m.text.length > maxChars) continue;
    picked.push(m);
    chars += m.text.length;
  }

  // past conversations: the ones that match, then the latest (other chats only; this chat has its own history)
  const maxEps = budget === 'full' ? 4 : 3;
  const matching = searchEpisodes(store, owner, o.query, 2, { project: o.project, exclude: o.conversationId ?? undefined });
  const latest = store.listEpisodes(owner, 10).filter((e) => e.conversationId !== o.conversationId && e.summary);
  const episodes: MemoryEpisode[] = [];
  for (const e of [...matching, ...latest]) {
    if (episodes.length >= maxEps) break;
    if (!episodes.some((x) => x.id === e.id) && e.summary) episodes.push(e);
  }
  const cap = budget === 'full' ? 350 : 220;
  const episodesText = episodes.length
    ? [
        '## Earlier conversations with the user (your summaries; details may have changed since)',
        ...episodes.map((e) => `- ${whenText(e.updatedAt, o.now)}${e.mode === 'voice' ? ', on a call' : ''}: ${e.title || 'Conversation'}${e.project ? ` [project: ${e.project}]` : ''}. ${e.summary.slice(0, cap)}`),
        'Pick up from these naturally when they come up; do not recite them unprompted.',
      ].join('\n')
    : '';
  return { memories: picked, episodes, episodesText };
}

// ---------------- learning from chats ----------------
/** Things people say when they share something worth remembering or correct it. */
const CUE =
  /\b(remember|don'?t forget|forget|my name|call me|i(?:'m| am) (?:a|an|from|based|working|building|living|\d)|i (?:like|love|hate|prefer|want|need|use|work|live|study|moved|have|own|built|am building)|i don'?t (?:like|want|use)|actually|not anymore|no longer|from now on|always|never|instead|correction|that'?s wrong|my (?:app|project|site|company|startup|business|team|wife|husband|partner|girlfriend|boyfriend|son|daughter|kid|mom|mother|dad|father|sister|brother|friend|boss|dog|cat|birthday|job|stack|server|repo)|we(?:'re| are) (?:building|making|using)|deadline|launch|switch(?:ed)? to|stack|hosting|hosted on|deploy(?:ed)? (?:to|on))\b/i;
const FORGET_CUE = /\b(forget|delete|remove|no longer|not anymore|isn'?t|aren'?t|wasn'?t|don'?t|doesn'?t|stopped|changed|moved|wrong|instead|actually|switch(?:ed)?)\b/i;

export function hasMemoryCue(text: string): boolean {
  return CUE.test(text);
}

interface LearnState {
  since: number;
  running: boolean;
  again: LearnInput | null;
}
const learnState = new Map<string, LearnState>();
/** Learning passes per character per day, so memory never eats the user's model quota. */
export const LEARN_DAILY_CAP = 80;

export interface LearnInput {
  store: AgentStore;
  provider: ChatProvider;
  model: string;
  owner: string;
  character?: string;
  conversationId?: string | null;
  project?: string;
  mode: 'chat' | 'voice';
  /** the conversation as the app sent it (latest last) */
  messages: { role: string; content: unknown }[];
  /** the reply just given */
  reply: string;
  /** test hook */
  force?: boolean;
}

export interface LearnResult {
  added: Memory[];
  updated: Memory[];
  deleted: Memory[];
  episode: MemoryEpisode | null;
  skipped?: string;
}

const textOf = (c: unknown) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (p && typeof p === 'object' && 'text' in p ? String((p as { text: unknown }).text) : '')).join(' ') : '');

/**
 * After a reply: decide whether this turn is worth a learning pass, and run it in the background
 * (one at a time per chat; a turn that arrives meanwhile runs right after). Never throws.
 * A pass runs when the user said something that sounds memorable, or every few turns (more on calls,
 * so a call's next turn does not compete with it for the model).
 */
export function noteTurn(input: LearnInput): void {
  try {
    const key = `${input.owner}|${input.conversationId ?? '-'}`;
    const st = learnState.get(key) ?? { since: 0, running: false, again: null };
    learnState.set(key, st);
    st.since++;
    const lastUser = textOf([...input.messages].reverse().find((m) => m.role === 'user')?.content);
    const every = input.mode === 'voice' ? 6 : 4;
    if (!input.force && !hasMemoryCue(lastUser) && st.since < every) return;
    if (st.running) {
      st.again = input;
      return;
    }
    st.since = 0;
    st.running = true;
    const go = async (inp: LearnInput) => {
      try {
        if (inp.mode === 'voice') await new Promise((r) => setTimeout(r, 1500));
        await learnFromTurn(inp);
      } catch (err) {
        logger.warn('memory learning failed', { err: err instanceof Error ? err.name : 'error' });
      }
      const next = st.again;
      st.again = null;
      if (next) return go(next);
      st.running = false;
    };
    void go(input);
  } catch {
    /* memory must never break a reply */
  }
}

/** Waits for the learning passes in flight (tests). */
export async function memoryIdle(timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while ([...learnState.values()].some((s) => s.running) && Date.now() - start < timeoutMs) await new Promise((r) => setTimeout(r, 20));
}

function parseJson(text: string): unknown {
  const a = text.indexOf('{');
  const b = text.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
}

/** One learning pass over the latest exchange: new facts, corrections, forgets and the chat's summary. */
export async function learnFromTurn(input: LearnInput): Promise<LearnResult> {
  const { store, owner } = input;
  const none = (skipped: string): LearnResult => ({ added: [], updated: [], deleted: [], episode: null, skipped });
  const settings = getMemorySettings(store, owner);
  if (!settings.enabled || !settings.learn) return none('off');
  if (store.usageToday(owner, 'memory_learn') >= LEARN_DAILY_CAP) return none('daily cap');
  store.bumpUsage(owner, 'memory_learn');

  const convo = input.messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, text: textOf(m.content) }))
    .filter((m) => m.text.trim());
  const recent = convo.slice(-10);
  if (input.reply && recent[recent.length - 1]?.role !== 'assistant') recent.push({ role: 'assistant', text: input.reply });
  const transcript = redactSecrets(recent.map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.slice(0, 1200)}`).join('\n'));
  const lastUser = [...recent].reverse().find((m) => m.role === 'user')?.text ?? '';

  const known = memoryContext(store, owner, { query: recent.filter((m) => m.role === 'user').map((m) => m.text).join('\n'), project: input.project, conversationId: input.conversationId }).memories.slice(0, 30);
  const refs = new Map(known.map((m, i) => [`m${i + 1}`, m]));
  const episode = input.conversationId ? store.getEpisode(owner, input.conversationId) : null;

  const system = [
    `You keep the long-term memory of an AI assistant${input.character ? ` called ${input.character}` : ''} about one user. Read the latest exchange and decide what is worth remembering for future conversations.`,
    'Reply with JSON only: {"ops": [...], "episode": {"title": "...", "summary": "..."}}',
    'ops items:',
    '{"op":"add","text":"...","kind":"profile|preference|project|person|fact","about_project":true|false}',
    '{"op":"update","ref":"m3","text":"..."} when the user corrected or changed something already remembered',
    '{"op":"delete","ref":"m3"} when the user asked to forget it or said it is no longer true',
    'Rules:',
    '- Remember only durable things: who the user is, their preferences, people in their life, and their projects (names, goals, tech stack, hosting, decisions, deadlines). Not one-off requests, small talk, or what the assistant did.',
    '- One short third-person sentence each, e.g. "User prefers short answers", "The Orin app is hosted on Render".',
    '- Only what the user said or clearly confirmed. Never guess or infer feelings.',
    '- Never store passwords, API keys, tokens, codes, card numbers or any other secret, not even part of one.',
    '- When a new fact contradicts a remembered one, update that one instead of adding a new one. Skip anything already remembered.',
    '- kind: profile = name, age, location, job; preference = likes, dislikes, how they want things done; project = details of something they are building; person = someone in their life; fact = anything else.',
    '- about_project is true only for details of the current project.',
    '- At most 5 ops. An empty list is normal.',
    `- episode.title: 3 to 7 words naming what this conversation is about. episode.summary: at most 60 words on what was discussed, decided and left open${episode?.summary ? ', updated from the previous summary' : ''}.`,
  ].join('\n');
  const user = [
    input.project ? `Current project: ${input.project}` : 'No project selected.',
    known.length ? `Already remembered:\n${[...refs].map(([r, m]) => `[${r}] ${m.text}${m.project ? ` (project: ${m.project})` : ''}`).join('\n')}` : 'Nothing remembered yet.',
    episode?.summary ? `Previous summary of this conversation: ${episode.summary}` : '',
    `Latest exchange:\n${transcript}`,
  ]
    .filter(Boolean)
    .join('\n\n');

  let out = '';
  const signal = AbortSignal.timeout(30_000);
  for await (const c of input.provider.streamChat({ model: input.model, maxOutputTokens: 800, temperature: 0.1, signal, messages: [{ role: 'system', content: system }, { role: 'user', content: user }] })) {
    if (c.type === 'delta') out += c.text;
  }
  const parsed = parseJson(out) as { ops?: unknown; episode?: { title?: unknown; summary?: unknown } } | null;
  if (!parsed) return none('unreadable');
  const res: LearnResult = { added: [], updated: [], deleted: [], episode: null };
  const ops = Array.isArray(parsed.ops) ? parsed.ops.slice(0, 5) : [];
  for (const raw of ops) {
    if (!raw || typeof raw !== 'object') continue;
    const op = raw as { op?: unknown; text?: unknown; kind?: unknown; about_project?: unknown; ref?: unknown };
    const text = typeof op.text === 'string' ? op.text.trim().replace(/\s+/g, ' ') : '';
    const target = typeof op.ref === 'string' ? refs.get(op.ref.trim()) : undefined;
    try {
      if (op.op === 'add' && text.length >= 4 && text.length <= 300 && !secretProblem(text)) {
        const kind = normalizeKind(op.kind);
        const project = op.about_project === true && input.project ? input.project : '';
        res.added.push(store.addMemory(owner, text, 'auto', { kind, source: 'auto', project, conversationId: input.conversationId ?? '' }));
      } else if (op.op === 'update' && target && text.length >= 4 && text.length <= 300 && !secretProblem(text)) {
        const m = store.updateMemory(owner, target.id, { text, ...(op.kind ? { kind: normalizeKind(op.kind) } : {}) });
        if (m) res.updated.push(m);
      } else if (op.op === 'delete' && target && FORGET_CUE.test(lastUser)) {
        // only when the user's own words say it changed or should go
        if (store.deleteMemory(owner, target.id)) res.deleted.push(target);
      }
    } catch {
      /* a secret-looking or bad op is skipped */
    }
  }
  const title = typeof parsed.episode?.title === 'string' ? parsed.episode.title.trim() : '';
  const summary = typeof parsed.episode?.summary === 'string' ? parsed.episode.summary.trim() : '';
  if (input.conversationId && (title || summary)) {
    res.episode = store.upsertEpisode(owner, input.conversationId, { title, summary, project: input.project, mode: input.mode, turns: convo.filter((m) => m.role === 'user').length });
  }
  return res;
}
