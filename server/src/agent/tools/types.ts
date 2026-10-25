import { z } from 'zod';
import type { AppConfig } from '../../config.js';
import type { FetchLike } from '../../ai/http.js';
import type { ChatProvider, ToolSpec } from '../../ai/types.js';
import type { AgentStore } from '../store.js';
import type { LookupFn } from '../net.js';
import type { SandboxManager } from '../sandbox/manager.js';

/** Something the app can render for a tool result (chips, source links, images, cards). */
export type ToolDisplay =
  | { kind: 'sources'; sources: { title: string; url: string }[] }
  | { kind: 'image'; url: string; prompt: string; provider: string }
  | { kind: 'note'; id: string; title: string }
  | { kind: 'memory'; action: 'saved' | 'recalled' | 'forgot'; items: string[] }
  | { kind: 'reminder'; id: string; text: string; dueAt: number }
  | { kind: 'task'; id: string; title: string; status: string }
  | { kind: 'skill'; id: string; name: string }
  | { kind: 'schedule'; id: string; title: string; nextRunAt: number }
  | { kind: 'code'; stdout: string; stderr: string }
  | { kind: 'page'; url: string; title: string }
  | { kind: 'text'; text: string }
  | { kind: 'file'; path: string; size: number }
  | { kind: 'prompt'; id: string; title: string; status: string; decision: string | null };

/** A request for the user's approval or answer, shown in the app as a card. */
export interface AskInput {
  kind: 'approval' | 'question';
  title: string;
  body: string;
  fields?: { label: string; value: string }[];
  choices?: string[];
  tool?: string;
}
export interface AskResult {
  /** 'approve' | 'deny' | 'change' | 'answer' | 'expired' | 'cancelled' */
  decision: string;
  answer: string | null;
}

export interface ToolResult {
  /** What the model sees. */
  content: string;
  /** Short human summary for the activity chip, e.g. "Saved to memory". */
  summary?: string;
  display?: ToolDisplay;
  ok?: boolean;
}

/** Services the agent tools can use. Built once per server. */
export interface AgentServices {
  config: AppConfig;
  store: AgentStore;
  fetchImpl: FetchLike;
  lookup?: LookupFn;
  /** model access for tools that need it (deep research synthesis, summaries) */
  llm: () => { provider: ChatProvider; model: string; fastModel: string } | null;
  /** enqueue a background task (set by the worker) */
  enqueue?: (taskId: string) => void;
  /** media files written by image providers, served under /v1/media */
  mediaDir: string;
  /** Orin's own computer (cloud sandboxes, one per agent); absent in some tests */
  sandboxes?: SandboxManager;
}

export interface ToolContext {
  owner: string;
  services: AgentServices;
  signal: AbortSignal;
  /** absolute base URL of this server as the phone sees it (for media links) */
  baseUrl: string;
  /** user's IANA timezone, if the app sent it */
  timezone?: string;
  /** 'chat' | 'voice' | 'task' */
  mode: 'chat' | 'voice' | 'task';
  /** current background task id when running inside the worker */
  taskId?: string;
  /** asks the user (approval card or question) and waits; absent when nobody can answer */
  ask?: (input: AskInput) => Promise<AskResult>;
  /** the app conversation this chat turn belongs to (task results are posted back there) */
  conversationId?: string;
  /** incognito chat: nothing may be saved */
  incognito?: boolean;
  /** secrets used in this run, redacted from any tool output */
  secrets?: Set<string>;
}

export interface ToolDef<S extends z.ZodType = z.ZodType> {
  name: string;
  description: string;
  schema: S;
  /** Chip text while running, e.g. "Searching the web…" */
  label: (args: z.infer<S>) => string;
  /** Returns null when usable, otherwise what is missing (e.g. "E2B_API_KEY"). Unavailable tools are hidden from the model. */
  needs?: (ctx: { owner: string; services: AgentServices }) => string | null;
  /** Not offered inside background tasks (e.g. creating another task). */
  interactiveOnly?: boolean;
  /** Saves user data (memory, notes...): hidden in incognito chats. */
  writes?: boolean;
  /** Risky action: return a card to show the user for approval before the tool runs, or null when no approval is needed. */
  approval?: (args: z.infer<S>, ctx: ToolContext) => { title: string; body: string; fields?: { label: string; value: string }[] } | null;
  /** Overrides the default tool timeout (e.g. tools that wait for the user). */
  timeoutMs?: number;
  handler: (args: z.infer<S>, ctx: ToolContext) => Promise<ToolResult>;
}

export function defineTool<S extends z.ZodType>(def: ToolDef<S>): ToolDef {
  return def as unknown as ToolDef;
}

export function toToolSpec(t: ToolDef): ToolSpec {
  const json = z.toJSONSchema(t.schema, { target: 'draft-7', unrepresentable: 'any' }) as Record<string, unknown>;
  delete json.$schema;
  if (json.type !== 'object') return { name: t.name, description: t.description, parameters: { type: 'object', properties: {} } };
  return { name: t.name, description: t.description, parameters: json };
}

export class ToolRegistry {
  private readonly tools = new Map<string, ToolDef>();

  constructor(tools: ToolDef[] = []) {
    for (const t of tools) this.add(t);
  }

  add(t: ToolDef) {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new Error(`Invalid tool name ${t.name}`);
    this.tools.set(t.name, t);
  }

  get(name: string): ToolDef | undefined {
    return this.tools.get(name);
  }

  all(): ToolDef[] {
    return [...this.tools.values()];
  }

  /** Tools the model may use right now for this owner. */
  available(owner: string, services: AgentServices, opts: { inTask?: boolean; exclude?: string[]; incognito?: boolean } = {}): ToolDef[] {
    return this.all().filter((t) => {
      if (opts.exclude?.includes(t.name)) return false;
      if (opts.incognito && t.writes) return false;
      if (opts.inTask && t.interactiveOnly) return false;
      return !t.needs || t.needs({ owner, services }) === null;
    });
  }

  /** Every tool with whether it is usable and what it needs otherwise (for /capabilities). */
  status(owner: string, services: AgentServices): { name: string; description: string; live: boolean; needs: string | null }[] {
    return this.all().map((t) => {
      const needs = t.needs ? t.needs({ owner, services }) : null;
      return { name: t.name, description: t.description, live: needs === null, needs };
    });
  }
}
