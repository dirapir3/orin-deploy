import type { AgentServices } from '../tools/types.js';
import { listFiles, readWsFile, workspaceDir, writeWsFile } from '../workspace.js';
import { SANDBOX_WORKDIR, type SandboxEventKind, type SandboxSession } from './types.js';

/**
 * Sandboxes are wiped when they close, so Orin's work folder is mirrored into the user's private
 * workspace on the server under `sandbox/`: changed files are saved before a sandbox closes and
 * copied back into the next sandbox when it starts. Heavy, rebuildable folders (node_modules,
 * .git, virtualenvs, caches) are skipped; there are size and count limits.
 */

export const SAVE_PREFIX = 'sandbox';
export const SAVE_MAX_FILE = 500_000;
export const SAVE_MAX_TOTAL = 5_000_000;
export const SAVE_MAX_FILES = 200;
const SKIP_DIRS = ['node_modules', '.git', '__pycache__', '.venv', 'venv', '.cache', '.next', '.npm', '.ipynb_checkpoints', '.orin'];

type Log = (kind: SandboxEventKind, text: string, ok?: boolean) => void;

export interface RemoteFile {
  path: string;
  size: number;
  mtime: number;
}

/** Lists files under a folder of the sandbox (relative paths), skipping heavy folders. */
export async function listRemote(s: SandboxSession, dir = SANDBOX_WORKDIR, limit = 2000): Promise<RemoteFile[]> {
  const prune = SKIP_DIRS.map((d) => `-name '${d}'`).join(' -o ');
  const r = await s.exec(`find . \\( ${prune} \\) -prune -o -type f -printf '%T@\\t%s\\t%P\\n' 2>/dev/null | head -n ${limit}`, { cwd: dir, timeoutMs: 30_000 });
  if (r.exitCode !== 0 && !r.stdout) throw new Error(r.stderr.trim() || `could not list ${dir}`);
  const out: RemoteFile[] = [];
  for (const line of r.stdout.split('\n')) {
    const [t, size, path] = line.split('\t');
    if (!path) continue;
    out.push({ path, size: Number(size) || 0, mtime: Number(t) || 0 });
  }
  return out;
}

/** path -> mtime the last time files were saved or restored, per sandbox */
const baselines = new Map<string, Map<string, number>>();

export async function restoreToSandbox(svc: AgentServices, owner: string, s: SandboxSession, log: Log): Promise<number> {
  const root = workspaceDir(svc, owner);
  const saved = listFiles(root).filter((f) => f.path.startsWith(`${SAVE_PREFIX}/`));
  let total = 0;
  let n = 0;
  for (const f of saved.sort((a, b) => a.path.localeCompare(b.path))) {
    if (n >= SAVE_MAX_FILES || total + f.size > SAVE_MAX_TOTAL) break;
    const rel = f.path.slice(SAVE_PREFIX.length + 1);
    await s.writeFile(`${SANDBOX_WORKDIR}/${rel}`, new Uint8Array(readWsFile(root, f.path)));
    total += f.size;
    n++;
  }
  const base = new Map<string, number>();
  if (n) for (const f of await listRemote(s)) base.set(f.path, f.mtime);
  baselines.set(s.id, base);
  if (n) log('restore', `Copied ${n} saved file${n === 1 ? '' : 's'} back into the sandbox`);
  return n;
}

export interface SaveReport {
  saved: string[];
  skipped: string[];
  bytes: number;
}

/**
 * Copies files from a sandbox folder into the user's workspace.
 * `onlyChanged` uses the baseline of this sandbox (for the automatic save before closing).
 */
export async function copyToWorkspace(
  svc: AgentServices,
  owner: string,
  s: SandboxSession,
  o: { from?: string; to?: string; onlyChanged?: boolean; maxFiles?: number; maxBytes?: number } = {},
): Promise<SaveReport> {
  const root = workspaceDir(svc, owner);
  const from = o.from ?? SANDBOX_WORKDIR;
  const to = (o.to ?? SAVE_PREFIX).replace(/^\/+|\/+$/g, '');
  const maxFiles = o.maxFiles ?? SAVE_MAX_FILES;
  const maxBytes = o.maxBytes ?? SAVE_MAX_TOTAL;
  const base = baselines.get(s.id) ?? new Map<string, number>();
  const files = await listRemote(s, from);
  const rep: SaveReport = { saved: [], skipped: [], bytes: 0 };
  for (const f of files.sort((a, b) => a.path.localeCompare(b.path))) {
    if (o.onlyChanged && base.get(f.path) === f.mtime) continue;
    if (f.size > SAVE_MAX_FILE) {
      rep.skipped.push(`${f.path} (over ${SAVE_MAX_FILE / 1000} KB)`);
      continue;
    }
    if (rep.saved.length >= maxFiles || rep.bytes + f.size > maxBytes) {
      rep.skipped.push(`${f.path} (save limit reached)`);
      continue;
    }
    try {
      const data = await s.readFile(`${from}/${f.path}`);
      writeWsFile(root, to ? `${to}/${f.path}` : f.path, Buffer.from(data));
      rep.saved.push(f.path);
      rep.bytes += data.byteLength;
      if (o.onlyChanged) base.set(f.path, f.mtime);
    } catch (e) {
      rep.skipped.push(`${f.path} (${String((e as Error)?.message ?? e)})`);
      if (/workspace is full/i.test(String(e))) break;
    }
  }
  baselines.set(s.id, base);
  return rep;
}

export async function saveBeforeClose(svc: AgentServices, owner: string, s: SandboxSession, log: Log): Promise<SaveReport> {
  const rep = await copyToWorkspace(svc, owner, s, { onlyChanged: true });
  baselines.delete(s.id);
  if (rep.saved.length) log('save', `Saved ${rep.saved.length} changed file${rep.saved.length === 1 ? '' : 's'} to your files (sandbox/)`);
  if (rep.skipped.length) log('save', `Not saved: ${rep.skipped.slice(0, 5).join(', ')}${rep.skipped.length > 5 ? ` and ${rep.skipped.length - 5} more` : ''}`, false);
  return rep;
}
