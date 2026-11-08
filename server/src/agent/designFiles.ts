import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { AgentServices } from './tools/types.js';
import { safePath, workspaceDir } from './workspace.js';
import { decodeImage, sniff } from './designImage.js';

/**
 * Pictures the user sends in chat are kept as files, so a design can be built and checked from it
 * later in the run, in a background task, or after the chat has moved on. Each picture is saved
 * once (named by its content hash) under designs/ in the owner's workspace. Incognito chats keep
 * them in a temporary folder instead, which nothing lists or keeps.
 */

export const DESIGN_DIR = 'designs';
const EXT: Record<string, string> = { png: 'png', jpeg: 'jpg', webp: 'webp', gif: 'gif' };

function dirFor(svc: AgentServices, owner: string, incognito: boolean): string {
  const root = incognito ? join(tmpdir(), 'orin-incognito', createHash('sha256').update(owner).digest('hex').slice(0, 24)) : workspaceDir(svc, owner);
  const dir = join(root, DESIGN_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
}

export interface SavedPicture {
  /** path the tools take (relative to the workspace, or absolute for incognito) */
  path: string;
  width: number | null;
  height: number | null;
}

export function savePicture(svc: AgentServices, owner: string, bytes: Uint8Array, incognito = false): SavedPicture | null {
  const kind = sniff(bytes);
  if (!kind) return null;
  const name = `${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.${EXT[kind]}`;
  const dir = dirFor(svc, owner, incognito);
  const file = join(dir, name);
  if (!existsSync(file)) writeFileSync(file, bytes);
  let width: number | null = null, height: number | null = null;
  try {
    const r = decodeImage(bytes);
    width = r.w;
    height = r.h;
  } catch {
    /* webp/gif: kept, just not measured */
  }
  return { path: incognito ? file : `${DESIGN_DIR}/${name}`, width, height };
}

type Msg = { role: string; content?: unknown; images?: { mimeType: string; data: string }[] | undefined };
const MARK = '[Picture';

/**
 * Saves the pictures on the user's messages and tells the model where each one is, so match_design
 * (and a background task) can open it. Safe to run on every request: notes are added once.
 */
export function resolveDesignImages(svc: AgentServices, owner: string, messages: Msg[], incognito = false): void {
  for (const m of messages) {
    if (m.role !== 'user' || !m.images?.length || typeof m.content !== 'string') continue;
    if (m.content.includes(`${MARK} 1 saved as`)) continue;
    const notes: string[] = [];
    m.images.forEach((img, i) => {
      try {
        const saved = savePicture(svc, owner, Buffer.from(img.data, 'base64'), incognito);
        if (!saved) return;
        const size = saved.width ? `, ${saved.width}x${saved.height} px` : '';
        notes.push(`${MARK} ${i + 1} saved as ${saved.path}${size}]`);
      } catch {
        /* a picture that cannot be saved is still sent to the model */
      }
    });
    if (notes.length) {
      m.content = `${m.content}\n${notes.join('\n')}\nIf a picture is a design to build (mockup, screenshot, export), build from it with design_spec and match_design on that path.`;
    }
  }
}

/** Opens a design picture by the path a note gave, a workspace path, or a sandbox-free upload id. */
export function readPicture(svc: AgentServices, owner: string, path: string): { bytes: Uint8Array; path: string } {
  const p = path.trim();
  if (p.startsWith('/')) {
    // only our own incognito folder is allowed as an absolute path
    const allowed = join(tmpdir(), 'orin-incognito', createHash('sha256').update(owner).digest('hex').slice(0, 24));
    if (!p.startsWith(allowed + '/') || relative(allowed, p).startsWith('..')) throw new Error('That path is outside your files.');
    return { bytes: readFileSync(p), path: p };
  }
  const root = workspaceDir(svc, owner);
  const file = safePath(root, p);
  if (!existsSync(file)) {
    // a bare file name: look in designs/
    const alt = safePath(root, join(DESIGN_DIR, p));
    if (existsSync(alt)) return { bytes: readFileSync(alt), path: join(DESIGN_DIR, p) };
    throw new Error(`No picture at ${p}. Pictures from chat are saved under ${DESIGN_DIR}/ (see the [Picture … saved as …] note on the message).`);
  }
  return { bytes: readFileSync(file), path: p };
}

export function listPictures(svc: AgentServices, owner: string): string[] {
  const dir = join(workspaceDir(svc, owner), DESIGN_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => /\.(png|jpe?g|webp|gif)$/i.test(f) && !f.includes('-shot') && !f.includes('-diff'))
    .map((f) => ({ f, t: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
    .map((x) => `${DESIGN_DIR}/${x.f}`);
}
