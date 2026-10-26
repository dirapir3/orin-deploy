import { z } from 'zod';
import { defineTool, type AgentServices, type ToolDef } from './tools/types.js';
import type { AgentStore } from './store.js';
import { TOKEN_APPS, allTokenAppTools, tokenAppTools } from './tokenApps.js';

/**
 * Connectors framework. Each connector declares what it needs, an OAuth flow and the tools it adds.
 * Tools are offered to the model only when the connector is configured on the server AND the user
 * has connected their account.
 *
 * Google (Gmail + Calendar) needs:
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET from a Google Cloud OAuth client (type "Web application"),
 *   with the authorised redirect URI  <PUBLIC_URL>/v1/connectors/google/callback
 *   (or GOOGLE_REDIRECT_URL), Gmail API + Google Calendar API enabled, and your account added as a
 *   test user on the OAuth consent screen while the app is in testing.
 */

export interface ConnectorInfo {
  id: string;
  name: string;
  description: string;
  configured: boolean;
  connected: boolean;
  account: string | null;
  needs: string[];
  tools: string[];
  /** how the user connects it: Google sign-in, or pasting a token */
  connect: 'oauth' | 'token';
  /** connected but the saved grant is missing something (e.g. Google signed in before Drive was added) */
  note?: string;
  token?: { label: string; help: string; url: string };
}

export const GOOGLE_SCOPES = [
  'openid',
  'email',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.compose',
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/drive.readonly',
];
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';

export function googleRedirectUrl(svc: AgentServices, requestBase: string): string {
  return svc.config.integrations.google.redirectUrl || `${svc.config.agent.publicUrl || requestBase}/v1/connectors/google/callback`;
}

export function googleConfigured(svc: AgentServices): boolean {
  const g = svc.config.integrations.google;
  return Boolean(g.clientId && g.clientSecret);
}

export function googleAuthUrl(svc: AgentServices, owner: string, requestBase: string): string {
  const state = svc.store.createOAuthState(owner, 'google');
  const p = new URLSearchParams({
    client_id: svc.config.integrations.google.clientId,
    redirect_uri: googleRedirectUrl(svc, requestBase),
    response_type: 'code',
    scope: GOOGLE_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${p.toString()}`;
}

export async function googleHandleCallback(svc: AgentServices, code: string, state: string, requestBase: string): Promise<{ owner: string; email: string }> {
  const st = svc.store.consumeOAuthState(state);
  if (!st || st.provider !== 'google') throw new Error('This sign-in link expired. Start again from the app.');
  const g = svc.config.integrations.google;
  const res = await svc.fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: g.clientId, client_secret: g.clientSecret, redirect_uri: googleRedirectUrl(svc, requestBase), grant_type: 'authorization_code' }).toString(),
  });
  const json = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; scope?: string; error_description?: string };
  if (!res.ok || !json.access_token) throw new Error(json.error_description ?? `Google token exchange failed (HTTP ${res.status}).`);
  let email = '';
  try {
    const u = await svc.fetchImpl('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: `Bearer ${json.access_token}` } });
    email = ((await u.json()) as { email?: string }).email ?? '';
  } catch {
    /* optional */
  }
  svc.store.saveConnection({ owner: st.owner, provider: 'google', accessToken: json.access_token, refreshToken: json.refresh_token ?? '', expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000, scope: json.scope ?? '', email });
  return { owner: st.owner, email };
}

async function googleToken(svc: AgentServices, owner: string): Promise<string> {
  const c = svc.store.getConnection(owner, 'google');
  if (!c) throw new Error('Google is not connected. Connect it in Profile → Connected apps.');
  if (c.expiresAt > Date.now() + 60_000) return c.accessToken;
  if (!c.refreshToken) throw new Error('Google access expired; reconnect it in the app.');
  const g = svc.config.integrations.google;
  const res = await svc.fetchImpl('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: g.clientId, client_secret: g.clientSecret, refresh_token: c.refreshToken, grant_type: 'refresh_token' }).toString(),
  });
  const json = (await res.json()) as { access_token?: string; expires_in?: number };
  if (!res.ok || !json.access_token) throw new Error('Could not refresh Google access; reconnect it in the app.');
  svc.store.saveConnection({ ...c, accessToken: json.access_token, refreshToken: '', expiresAt: Date.now() + (json.expires_in ?? 3600) * 1000 });
  return json.access_token;
}

async function gapi<T>(svc: AgentServices, owner: string, url: string, signal: AbortSignal, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const token = await googleToken(svc, owner);
  const res = await svc.fetchImpl(url, {
    method: init.method ?? 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal,
  });
  if (!res.ok) throw new Error(`Google API error HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

const googleNeeds = ({ owner, services }: { owner: string; services: AgentServices }) => {
  if (!googleConfigured(services)) return 'GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET';
  if (!services.store.getConnection(owner, 'google')) return 'Connect Google in Profile → Connected apps';
  return null;
};

const header = (h: { name: string; value: string }[] | undefined, name: string) => h?.find((x) => x.name.toLowerCase() === name)?.value ?? '';

export const gmailSearchTool = defineTool({
  name: 'gmail_search',
  description: 'Search the user\'s Gmail (Gmail search syntax, e.g. "from:anna newer_than:7d"). Returns sender, subject, date and snippet.',
  schema: z.object({ query: z.string().max(300), max: z.number().int().min(1).max(20).optional() }),
  label: () => 'Searching Gmail…',
  needs: googleNeeds,
  handler: async (a, ctx) => {
    const base = 'https://gmail.googleapis.com/gmail/v1/users/me/messages';
    const list = await gapi<{ messages?: { id: string }[] }>(ctx.services, ctx.owner, `${base}?q=${encodeURIComponent(a.query)}&maxResults=${a.max ?? 8}`, ctx.signal);
    const rows: string[] = [];
    for (const m of list.messages ?? []) {
      const msg = await gapi<{ id: string; snippet: string; payload?: { headers?: { name: string; value: string }[] } }>(ctx.services, ctx.owner, `${base}/${m.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, ctx.signal);
      rows.push(`- id ${msg.id} | ${header(msg.payload?.headers, 'from')} | ${header(msg.payload?.headers, 'subject')} | ${header(msg.payload?.headers, 'date')}\n  ${msg.snippet}`);
    }
    return { content: rows.join('\n') || 'No matching emails.', summary: `${rows.length} emails` };
  },
});

export const gmailReadTool = defineTool({
  name: 'gmail_read',
  description: 'Read one Gmail message by id (plain text body).',
  schema: z.object({ id: z.string().min(1) }),
  label: () => 'Reading email…',
  needs: googleNeeds,
  handler: async (a, ctx) => {
    type Part = { mimeType?: string; body?: { data?: string }; parts?: Part[]; headers?: { name: string; value: string }[] };
    const msg = await gapi<{ payload?: Part }>(ctx.services, ctx.owner, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(a.id)}?format=full`, ctx.signal);
    const find = (p?: Part): string => {
      if (!p) return '';
      if (p.mimeType === 'text/plain' && p.body?.data) return Buffer.from(p.body.data, 'base64url').toString('utf8');
      for (const c of p.parts ?? []) {
        const t = find(c);
        if (t) return t;
      }
      return '';
    };
    const h = msg.payload?.headers;
    return { content: `From: ${header(h, 'from')}\nTo: ${header(h, 'to')}\nSubject: ${header(h, 'subject')}\nDate: ${header(h, 'date')}\n\n${find(msg.payload).slice(0, 12_000)}`, summary: 'Read email' };
  },
});

export const gmailDraftTool = defineTool({
  name: 'gmail_create_draft',
  description: 'Create a Gmail draft (it is NOT sent; the user reviews and sends it from Gmail).',
  schema: z.object({ to: z.string().min(3).max(300), subject: z.string().max(300), body: z.string().max(20_000) }),
  label: () => 'Drafting email…',
  needs: googleNeeds,
  handler: async (a, ctx) => {
    const raw = Buffer.from(`To: ${a.to}\r\nSubject: ${a.subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.body}`).toString('base64url');
    const d = await gapi<{ id: string }>(ctx.services, ctx.owner, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', ctx.signal, { method: 'POST', body: { message: { raw } } });
    return { content: `Draft created (id ${d.id}). It has not been sent.`, summary: 'Draft created' };
  },
});

export const gmailSendTool = defineTool({
  name: 'gmail_send',
  description: 'Send an email from the user\'s Gmail. The user is shown the email and must approve it before it is sent.',
  schema: z.object({ to: z.string().min(3).max(300), subject: z.string().max(300), body: z.string().max(20_000), cc: z.string().max(300).optional() }),
  label: () => 'Sending email…',
  needs: googleNeeds,
  approval: (a) => ({
    title: 'Send email',
    headline: a.subject || '(no subject)',
    body: 'Orin wants to send this email from your Gmail.',
    content: a.body,
    fields: [{ label: 'To', value: a.to }, ...(a.cc ? [{ label: 'Cc', value: a.cc }] : []), { label: 'Subject', value: a.subject || '(no subject)' }],
  }),
  handler: async (a, ctx) => {
    const raw = Buffer.from(`To: ${a.to}\r\n${a.cc ? `Cc: ${a.cc}\r\n` : ''}Subject: ${a.subject}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.body}`).toString('base64url');
    const d = await gapi<{ id: string }>(ctx.services, ctx.owner, 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', ctx.signal, { method: 'POST', body: { raw } });
    return { content: `Email sent (id ${d.id}).`, summary: 'Email sent' };
  },
});

export const calendarListTool = defineTool({
  name: 'calendar_list_events',
  description: 'List events in the user\'s primary Google Calendar between two ISO times (default: next 7 days).',
  schema: z.object({ from: z.string().max(40).optional(), to: z.string().max(40).optional(), query: z.string().max(200).optional() }),
  label: () => 'Checking your calendar…',
  needs: googleNeeds,
  handler: async (a, ctx) => {
    const from = a.from ? new Date(a.from) : new Date();
    const to = a.to ? new Date(a.to) : new Date(Date.now() + 7 * 86_400_000);
    const p = new URLSearchParams({ timeMin: from.toISOString(), timeMax: to.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: '50' });
    if (a.query) p.set('q', a.query);
    const r = await gapi<{ items?: { id: string; summary?: string; location?: string; start?: { dateTime?: string; date?: string }; end?: { dateTime?: string; date?: string } }[] }>(ctx.services, ctx.owner, `https://www.googleapis.com/calendar/v3/calendars/primary/events?${p.toString()}`, ctx.signal);
    const rows = (r.items ?? []).map((e) => `- ${e.start?.dateTime ?? e.start?.date} → ${e.end?.dateTime ?? e.end?.date}: ${e.summary ?? '(no title)'}${e.location ? ` @ ${e.location}` : ''} (id ${e.id})`);
    return { content: rows.join('\n') || 'No events in that range.', summary: `${rows.length} events` };
  },
});

export const calendarCreateTool = defineTool({
  name: 'calendar_create_event',
  description: 'Create an event in the user\'s primary Google Calendar. Confirm the details with the user first.',
  schema: z.object({ summary: z.string().min(1).max(300), start: z.string().min(10).max(40), end: z.string().min(10).max(40), description: z.string().max(5000).optional(), location: z.string().max(300).optional() }),
  label: () => 'Adding to your calendar…',
  needs: googleNeeds,
  approval: (a) => ({ title: 'Add calendar event', headline: a.summary, body: 'Orin wants to add this event to your Google Calendar.', content: a.description || undefined, fields: [{ label: 'Event', value: a.summary }, { label: 'Starts', value: a.start }, { label: 'Ends', value: a.end }, ...(a.location ? [{ label: 'Where', value: a.location }] : [])] }),
  handler: async (a, ctx) => {
    const e = await gapi<{ id: string; htmlLink: string }>(ctx.services, ctx.owner, 'https://www.googleapis.com/calendar/v3/calendars/primary/events', ctx.signal, {
      method: 'POST',
      body: { summary: a.summary, description: a.description, location: a.location, start: { dateTime: a.start }, end: { dateTime: a.end } },
    });
    return { content: `Event created (id ${e.id}): ${e.htmlLink}`, summary: 'Event added' };
  },
});

const driveNeeds = ({ owner, services }: { owner: string; services: AgentServices }) => {
  const g = googleNeeds({ owner, services });
  if (g) return g;
  if (!services.store.getConnection(owner, 'google')!.scope.includes(DRIVE_SCOPE)) return 'Reconnect Google on the Apps page to allow Drive';
  return null;
};

export const driveSearchTool = defineTool({
  name: 'drive_search',
  description: "Find files in the user's Google Drive by name or text (Drive query is built for you). Returns name, type, id, link and last change.",
  schema: z.object({ query: z.string().min(1).max(200), max: z.number().int().min(1).max(30).optional() }),
  label: () => 'Searching Drive…',
  needs: driveNeeds,
  handler: async (a, ctx) => {
    const term = a.query.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const p = new URLSearchParams({ q: `(name contains '${term}' or fullText contains '${term}') and trashed = false`, pageSize: String(a.max ?? 10), fields: 'files(id,name,mimeType,modifiedTime,webViewLink,size)', orderBy: 'modifiedTime desc' });
    const r = await gapi<{ files?: { id: string; name: string; mimeType: string; modifiedTime: string; webViewLink?: string }[] }>(ctx.services, ctx.owner, `https://www.googleapis.com/drive/v3/files?${p.toString()}`, ctx.signal);
    const rows = (r.files ?? []).map((f) => `- ${f.name} (${f.mimeType.replace('application/vnd.google-apps.', 'google ')}, id ${f.id}, changed ${f.modifiedTime.slice(0, 10)}) ${f.webViewLink ?? ''}`);
    return { content: rows.join('\n') || 'No matching files.', summary: `${rows.length} files` };
  },
});

export const driveReadTool = defineTool({
  name: 'drive_read',
  description: 'Read the text of a Google Drive file by id: Google Docs/Slides as text, Sheets as CSV (first sheet), and plain text, CSV, JSON or Markdown files.',
  schema: z.object({ id: z.string().min(5).max(200) }),
  label: () => 'Reading from Drive…',
  needs: driveNeeds,
  handler: async (a, ctx) => {
    const id = encodeURIComponent(a.id);
    const meta = await gapi<{ name: string; mimeType: string; size?: string }>(ctx.services, ctx.owner, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size`, ctx.signal);
    const exportAs: Record<string, string> = { 'application/vnd.google-apps.document': 'text/plain', 'application/vnd.google-apps.presentation': 'text/plain', 'application/vnd.google-apps.spreadsheet': 'text/csv' };
    let url: string;
    if (exportAs[meta.mimeType]) url = `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportAs[meta.mimeType]!)}`;
    else if (/^text\/|json|csv|markdown|xml/.test(meta.mimeType)) url = `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
    else return { content: `${meta.name} is a ${meta.mimeType} file; only Docs, Sheets, Slides and text files can be read as text.`, summary: 'Not a text file' };
    const token = await googleToken(ctx.services, ctx.owner);
    const res = await ctx.services.fetchImpl(url, { headers: { Authorization: `Bearer ${token}` }, signal: ctx.signal });
    if (!res.ok) throw new Error(`Google Drive error HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const text = await res.text();
    return { content: `${meta.name}:\n${text.length > 30_000 ? `${text.slice(0, 30_000)}…` : text}`, summary: `Read ${meta.name}` };
  },
});

export const googleTools: ToolDef[] = [gmailSearchTool, gmailReadTool, gmailDraftTool, gmailSendTool, calendarListTool, calendarCreateTool];
export const driveTools: ToolDef[] = [driveSearchTool, driveReadTool];
export const connectorTools: ToolDef[] = [...googleTools, ...driveTools, ...allTokenAppTools];

export function listConnectors(svc: AgentServices, store: AgentStore, owner: string): ConnectorInfo[] {
  const conn = store.getConnection(owner, 'google');
  const configured = googleConfigured(svc);
  const googleNeedsList = configured ? [] : ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'PUBLIC_URL (or GOOGLE_REDIRECT_URL)'];
  const driveOk = Boolean(conn?.scope.includes(DRIVE_SCOPE));
  return [
    {
      id: 'google',
      name: 'Google (Gmail + Calendar)',
      description: 'Search, read and send email (sending asks you first), create drafts, list and add calendar events.',
      configured,
      connected: Boolean(conn),
      account: conn?.email || null,
      needs: googleNeedsList,
      tools: googleTools.map((t) => t.name),
      connect: 'oauth',
    },
    {
      id: 'drive',
      name: 'Google Drive',
      description: 'Find your Drive files and read Docs, Sheets, Slides and text files.',
      configured,
      connected: driveOk,
      account: driveOk ? conn?.email || null : null,
      needs: googleNeedsList,
      tools: driveTools.map((t) => t.name),
      connect: 'oauth',
      ...(conn && !driveOk ? { note: 'Google is connected without Drive access. Connect again to allow Drive.' } : {}),
    },
    ...TOKEN_APPS.map((a): ConnectorInfo => {
      const c = store.getConnection(owner, a.id);
      return {
        id: a.id,
        name: a.name,
        description: a.description,
        configured: true,
        connected: Boolean(c),
        account: c?.email || null,
        needs: [],
        tools: tokenAppTools[a.id].map((t) => t.name),
        connect: 'token',
        token: { label: a.tokenLabel, help: a.tokenHelp, url: a.tokenUrl },
      };
    }),
  ];
}
