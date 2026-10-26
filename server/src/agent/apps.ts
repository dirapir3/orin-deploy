import type { ToolDef } from './tools/types.js';

/**
 * Built-in apps on a character's Apps page (Sesame-style): each one is a group of tools that the
 * user can turn off for that character. Turned-off apps' tools are not offered to the model, in chat,
 * on calls or in background tasks. Google is a connected app (connect/disconnect), not listed here.
 */
export interface BuiltInApp {
  id: string;
  name: string;
  what: string;
  /** exact tool names, or prefixes ending in `*` */
  tools: string[];
}

export const BUILT_IN_APPS: BuiltInApp[] = [
  { id: 'search', name: 'Web search', what: 'Searches the web, reads pages and runs deep research', tools: ['web_search', 'fetch_page', 'deep_research'] },
  { id: 'browser', name: 'Browser', what: 'Opens sites, fills forms and signs in with your vault', tools: ['browse', 'browser_*', 'sandbox_browser', 'sandbox_live_view'] },
  { id: 'computer', name: 'Computer & code', what: 'Runs code, builds apps and edits files on its own computer', tools: ['run_code', 'sandbox_run', 'sandbox_write_file', 'sandbox_read_file', 'sandbox_list_files', 'sandbox_edit_file', 'sandbox_save', 'sandbox_preview', 'sandbox_close', 'sandbox_job', 'write_file', 'read_file', 'list_files', 'delete_file'] },
  { id: 'sites', name: 'Websites & hosting', what: 'Builds, previews and publishes sites and web apps', tools: ['publish_site', 'check_site', 'unpublish_site', 'list_sites', 'open_site', 'preview_site', 'design_kit', 'study_reference', 'compare_to_reference'] },
  { id: 'images', name: 'Images', what: 'Makes pictures', tools: ['generate_image'] },
  { id: 'notes', name: 'Notes', what: 'Writes and keeps notes for you', tools: ['create_note', 'update_note', 'list_notes', 'read_note', 'delete_note'] },
  { id: 'schedules', name: 'Schedules & reminders', what: 'Reminders and tasks on a timetable', tools: ['create_reminder', 'list_reminders', 'cancel_reminder', 'create_schedule', 'delete_schedule', 'list_schedules', 'update_schedule'] },
  { id: 'vault', name: 'Secure Vault', what: 'Encrypted logins it uses for you', tools: ['vault_list'] },
];

const IDS = new Set(BUILT_IN_APPS.map((a) => a.id));
export const isBuiltInApp = (id: string) => IDS.has(id);

function matches(pattern: string, name: string): boolean {
  return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : pattern === name;
}

/** The app a tool belongs to, or null for core tools (memory, tasks, skills, ask_user, ...). */
export function appOfTool(name: string): string | null {
  for (const a of BUILT_IN_APPS) if (a.tools.some((p) => matches(p, name))) return a.id;
  return null;
}

/** Drop the tools of apps the user turned off for this character. */
export function withoutOffApps<T extends Pick<ToolDef, 'name'>>(tools: T[], off: string[]): T[] {
  if (!off.length) return tools;
  const set = new Set(off);
  return tools.filter((t) => {
    const app = appOfTool(t.name);
    return !app || !set.has(app);
  });
}

/** Lines for the system prompt so the agent can say why something is unavailable. */
export function offAppsNotice(off: string[]): { name: string; needs: string }[] {
  return BUILT_IN_APPS.filter((a) => off.includes(a.id)).map((a) => ({ name: a.name, needs: 'the user to turn it back on for you on the Apps page (they turned it off)' }));
}

/**
 * Whether a built-in app really works on this server: ready when at least one of its tools is usable,
 * otherwise what it needs (from the tools' own `needs`). The Apps page shows this next to the app.
 */
export function builtInStatus(status: { name: string; live: boolean; needs: string | null }[]): Record<string, { ready: boolean; tools: number; needs: string | null }> {
  const out: Record<string, { ready: boolean; tools: number; needs: string | null }> = {};
  for (const a of BUILT_IN_APPS) {
    const mine = status.filter((s) => appOfTool(s.name) === a.id);
    const live = mine.filter((s) => s.live);
    out[a.id] = { ready: live.length > 0, tools: live.length, needs: live.length ? null : (mine.find((s) => s.needs)?.needs ?? 'not available on this server') };
  }
  return out;
}
