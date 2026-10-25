import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, relative, sep } from 'node:path';
import type { AgentServices } from './tools/types.js';

/**
 * A private workspace folder per user for files the agent makes (artifacts) and for running
 * JavaScript in a sandbox. The sandbox is a separate Node process with the permission model on:
 * it can read and write only its own workspace, cannot start other programs or load native
 * addons, gets a small memory cap, no server environment variables, and a time limit.
 */
export const MAX_FILE_BYTES = 1_000_000;
export const MAX_WORKSPACE_BYTES = 20_000_000;

export function workspaceRoot(svc: AgentServices): string {
  const d = svc.config.agent.dataDir;
  return d === ':memory:' ? join(tmpdir(), `orin-ws-test-${process.pid}`) : join(d, 'workspace');
}

export function workspaceDir(svc: AgentServices, owner: string): string {
  const dir = join(workspaceRoot(svc), createHash('sha256').update(owner).digest('hex').slice(0, 24));
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Resolves a user/agent supplied relative path inside the workspace, or throws. */
export function safePath(root: string, rel: string): string {
  const clean = normalize(rel.replace(/\\/g, '/').replace(/^\/+/, '')).replace(/^(\.\.(\/|\\|$))+/, '');
  if (!clean || clean === '.' || clean.split(/[\\/]/).some((p) => p === '..')) throw new Error('Invalid file path.');
  const abs = join(root, clean);
  if (!abs.startsWith(root + sep)) throw new Error('Invalid file path.');
  if (relative(root, abs).split(sep).some((p) => p.startsWith('.orin'))) throw new Error('That name is reserved.');
  return abs;
}

export interface WsFile {
  path: string;
  size: number;
  modifiedAt: number;
}

export function listFiles(root: string): WsFile[] {
  const out: WsFile[] = [];
  const walk = (dir: string) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.orin')) continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) walk(abs);
      else if (e.isFile() && out.length < 500) {
        const st = statSync(abs);
        out.push({ path: relative(root, abs).split(sep).join('/'), size: st.size, modifiedAt: st.mtimeMs });
      }
    }
  };
  walk(root);
  return out.sort((a, b) => b.modifiedAt - a.modifiedAt);
}

export function usedBytes(root: string): number {
  return listFiles(root).reduce((n, f) => n + f.size, 0);
}

export function writeWsFile(root: string, rel: string, content: string | Buffer): WsFile {
  const abs = safePath(root, rel);
  const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  if (buf.length > MAX_FILE_BYTES) throw new Error(`Files can be at most ${MAX_FILE_BYTES / 1_000_000} MB.`);
  const existing = existsSync(abs) ? statSync(abs).size : 0;
  if (usedBytes(root) - existing + buf.length > MAX_WORKSPACE_BYTES) throw new Error('Your workspace is full (20 MB). Delete some files first.');
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, buf);
  return { path: relative(root, abs).split(sep).join('/'), size: buf.length, modifiedAt: Date.now() };
}

export function readWsFile(root: string, rel: string): Buffer {
  const abs = safePath(root, rel);
  if (!existsSync(abs) || !statSync(abs).isFile()) throw new Error(`No file called ${rel}.`);
  return readFileSync(abs);
}

export function deleteWsFile(root: string, rel: string): boolean {
  const abs = safePath(root, rel);
  if (!existsSync(abs)) return false;
  rmSync(abs, { recursive: true, force: true });
  return true;
}

export function wipeWorkspace(svc: AgentServices, owner: string) {
  rmSync(workspaceDir(svc, owner), { recursive: true, force: true });
}

const MIME: Record<string, string> = {
  txt: 'text/plain; charset=utf-8', md: 'text/markdown; charset=utf-8', csv: 'text/csv; charset=utf-8', json: 'application/json', html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8', py: 'text/x-python; charset=utf-8', svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', pdf: 'application/pdf',
};
export function mimeFor(path: string): string {
  return MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

/** Runs JavaScript (ES module) in the user's workspace with the Node permission model. */
export function runJsSandboxed(root: string, code: string, signal: AbortSignal, timeoutMs = 20_000): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  const script = join(root, '.orin_run.mjs');
  writeFileSync(script, code);
  return new Promise((resolve) => {
    const p = spawn(
      process.execPath,
      ['--permission', `--allow-fs-read=${root}`, `--allow-fs-write=${root}`, '--max-old-space-size=128', '--disable-proto=delete', script],
      { cwd: root, env: { PATH: '/usr/bin:/bin', HOME: root, NODE_ENV: 'sandbox' }, timeout: timeoutMs, signal, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d: Buffer) => (stdout = (stdout + d.toString()).slice(-20_000)));
    p.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-20_000)));
    p.on('error', (e) => resolve({ stdout, stderr: `${stderr}\n${e.message}`, exitCode: null }));
    p.on('close', (code, sig) => {
      rmSync(script, { force: true });
      resolve({ stdout, stderr: sig ? `${stderr}\n(stopped: ${sig === 'SIGTERM' ? 'time limit reached' : sig})` : stderr, exitCode: code });
    });
  });
}
