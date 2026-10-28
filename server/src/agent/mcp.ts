import { randomUUID } from 'node:crypto';
import type { AgentStore } from './store.js';
import { ensureKnowledgeTables } from './knowledge.js';
import { assertPublicUrl, type LookupFn } from './net.js';

/**
 * A small client for remote MCP servers (Model Context Protocol over Streamable HTTP): the kind a
 * service gives you as a URL such as https://mcp.example.com/mcp. Orin connects only after the user
 * approves it, keeps the server's tool list, and calls a tool on the user's behalf (tools that are not
 * marked read-only need approval each time). Local servers that you start with npx or uvx are not
 * run here: those are outside code, and go through a vetting report and an approved sandbox trial.
 */

export interface McpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  readOnly: boolean;
  destructive: boolean;
}
export interface McpServer {
  id: string;
  owner: string;
  name: string;
  url: string;
  vaultName: string | null;
  tools: McpTool[];
  createdAt: number;
  updatedAt: number;
}

const PROTOCOL = '2025-06-18';

type Row = Record<string, unknown>;
const toServer = (r: Row): McpServer => ({
  id: String(r.id),
  owner: String(r.owner),
  name: String(r.name),
  url: String(r.url),
  vaultName: r.vault_name ? String(r.vault_name) : null,
  tools: (() => {
    try {
      return JSON.parse(String(r.tools ?? '[]')) as McpTool[];
    } catch {
      return [];
    }
  })(),
  createdAt: Number(r.created_at ?? 0),
  updatedAt: Number(r.updated_at ?? 0),
});

export const mcpSlug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function listMcpServers(store: AgentStore, owner: string): McpServer[] {
  return (ensureKnowledgeTables(store.db).prepare('SELECT * FROM mcp_servers WHERE owner = ? ORDER BY name').all(owner) as Row[]).map(toServer);
}
export function getMcpServer(store: AgentStore, owner: string, nameOrId: string): McpServer | null {
  const key = nameOrId.trim();
  const r = ensureKnowledgeTables(store.db).prepare('SELECT * FROM mcp_servers WHERE owner = ? AND (id = ? OR name = ?)').get(owner, key, mcpSlug(key)) as Row | undefined;
  return r ? toServer(r) : null;
}
export function saveMcpServer(store: AgentStore, owner: string, v: { name: string; url: string; vaultName?: string | null; tools: McpTool[] }): McpServer {
  const db = ensureKnowledgeTables(store.db);
  const name = mcpSlug(v.name);
  const now = Date.now();
  const existing = getMcpServer(store, owner, name);
  if (existing) {
    db.prepare('UPDATE mcp_servers SET url = ?, vault_name = ?, tools = ?, updated_at = ? WHERE id = ?').run(v.url, v.vaultName ?? null, JSON.stringify(v.tools), now, existing.id);
    return getMcpServer(store, owner, existing.id)!;
  }
  const id = randomUUID();
  db.prepare('INSERT INTO mcp_servers (id, owner, name, url, vault_name, tools, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(id, owner, name, v.url, v.vaultName ?? null, JSON.stringify(v.tools), now, now);
  return getMcpServer(store, owner, id)!;
}
export function removeMcpServer(store: AgentStore, owner: string, nameOrId: string): boolean {
  const s = getMcpServer(store, owner, nameOrId);
  if (!s) return false;
  ensureKnowledgeTables(store.db).prepare('DELETE FROM mcp_servers WHERE id = ?').run(s.id);
  return true;
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/** Reads a JSON-RPC reply that came back as plain JSON or as an event stream. */
async function readRpc(res: Response, id: number): Promise<Record<string, unknown>> {
  const type = res.headers.get('content-type') ?? '';
  const text = (await res.text()).slice(0, 2_000_000);
  const messages: Record<string, unknown>[] = [];
  if (type.includes('text/event-stream')) {
    for (const block of text.split(/\r?\n\r?\n/)) {
      const data = block
        .split(/\r?\n/)
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        const m = JSON.parse(data);
        if (Array.isArray(m)) messages.push(...m);
        else messages.push(m);
      } catch {
        /* keep-alive or partial */
      }
    }
  } else if (text.trim()) {
    const m = JSON.parse(text);
    if (Array.isArray(m)) messages.push(...m);
    else messages.push(m);
  }
  const reply = messages.find((m) => m && m.id === id) ?? messages.find((m) => m && ('result' in m || 'error' in m));
  if (!reply) throw new Error('The tool server sent no answer.');
  if (reply.error) {
    const e = reply.error as { message?: string; code?: number };
    throw new Error(`The tool server said: ${String(e.message ?? 'error').slice(0, 300)}`);
  }
  return (reply.result ?? {}) as Record<string, unknown>;
}

export class McpSession {
  private sessionId: string | null = null;
  private nextId = 1;
  private fetchImpl: FetchLike;
  private lookup?: LookupFn;
  private timeoutMs: number;
  constructor(
    private url: string,
    private token: string | null,
    opts: { fetchImpl?: FetchLike; lookup?: LookupFn; timeoutMs?: number } = {},
  ) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.lookup = opts.lookup;
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', 'mcp-protocol-version': PROTOCOL };
    if (this.token) h.authorization = /^bearer /i.test(this.token) ? this.token : `Bearer ${this.token}`;
    if (this.sessionId) h['mcp-session-id'] = this.sessionId;
    return h;
  }

  private async post(body: Record<string, unknown>): Promise<Response> {
    const u = this.lookup ? await assertPublicUrl(this.url, this.lookup) : await assertPublicUrl(this.url);
    if (u.protocol !== 'https:') throw new Error('Tool servers must use an https:// address.');
    const res = await this.fetchImpl(this.url, { method: 'POST', headers: this.headers(), body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs) });
    if (res.status === 401 || res.status === 403) throw new Error(`The tool server refused access (${res.status}). It needs a key or a sign-in: save its key in the Secure Vault and connect again with that vault name.`);
    if (res.status === 404 && this.sessionId) throw new Error('The tool server ended the session. Try again.');
    if (!res.ok && res.status !== 202) throw new Error(`The tool server answered ${res.status}. Check that the link is the server's MCP address (often ending in /mcp).`);
    return res;
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const res = await this.post({ jsonrpc: '2.0', id, method, params });
    const sid = res.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;
    return readRpc(res, id);
  }

  async notify(method: string, params: Record<string, unknown> = {}): Promise<void> {
    const res = await this.post({ jsonrpc: '2.0', method, params });
    await res.text().catch(() => '');
  }

  async initialize(): Promise<{ serverName: string; version: string; instructions: string }> {
    const r = await this.request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'orin', version: '1.0' } });
    await this.notify('notifications/initialized');
    const info = (r.serverInfo ?? {}) as { name?: string; version?: string };
    return { serverName: String(info.name ?? ''), version: String(info.version ?? ''), instructions: String(r.instructions ?? '').slice(0, 2000) };
  }

  async listTools(): Promise<McpTool[]> {
    const out: McpTool[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {});
      for (const t of (r.tools ?? []) as Array<Record<string, unknown>>) {
        const ann = (t.annotations ?? {}) as { readOnlyHint?: boolean; destructiveHint?: boolean };
        out.push({ name: String(t.name ?? ''), description: String(t.description ?? '').slice(0, 600), inputSchema: t.inputSchema ?? {}, readOnly: ann.readOnlyHint === true, destructive: ann.destructiveHint !== false && ann.readOnlyHint !== true });
      }
      cursor = r.nextCursor ? String(r.nextCursor) : undefined;
      if (!cursor) break;
    }
    return out.filter((t) => t.name).slice(0, 200);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await this.request('tools/call', { name, arguments: args });
    const parts: string[] = [];
    for (const c of (r.content ?? []) as Array<Record<string, unknown>>) {
      if (c.type === 'text') parts.push(String(c.text ?? ''));
      else if (c.type === 'resource' && c.resource && typeof (c.resource as { text?: unknown }).text === 'string') parts.push(String((c.resource as { text: string }).text));
      else if (c.type === 'resource_link') parts.push(`[link] ${String(c.uri ?? '')}`);
      else if (c.type) parts.push(`[${String(c.type)} content not shown]`);
    }
    if (!parts.length && r.structuredContent) parts.push(JSON.stringify(r.structuredContent));
    return { text: parts.join('\n').slice(0, 30_000), isError: r.isError === true };
  }
}
