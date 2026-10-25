/**
 * Orin's own computer: a short-lived cloud sandbox the agent works in (run commands and code,
 * read and write files, build and serve sites). The provider is pluggable: E2B today, any other
 * service that can start a Linux box, run a command and move files can be added as a provider.
 */

/** Folder inside the sandbox where Orin works; relative paths resolve here and it is what gets saved. */
export const SANDBOX_WORKDIR = '/home/user/work';

export interface ExecOptions {
  /** working directory inside the sandbox (default SANDBOX_WORKDIR) */
  cwd?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** extra environment variables for this command only (vault secrets) */
  envs?: Record<string, string>;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** null when the command was stopped (time limit or cancelled) */
  exitCode: number | null;
  timedOut?: boolean;
}

export interface SandboxSession {
  readonly id: string;
  /** provider id, e.g. "e2b" */
  readonly provider: string;
  /** Runs a shell command (bash -lc) and waits for it. Never throws for a non-zero exit. */
  exec(cmd: string, opts?: ExecOptions): Promise<ExecResult>;
  /** Starts a long-running command (a dev server) and returns at once. */
  execBackground(cmd: string, opts?: { cwd?: string; envs?: Record<string, string> }): Promise<{ pid: number | null }>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  /** Public https address of a port inside the sandbox, when the provider supports it. */
  publicUrl?(port: number): string;
  /** Moves the provider-side kill timer (the sandbox dies on its own if the server never closes it). */
  extend(ms: number): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxProvider {
  readonly id: string;
  /** null when ready, otherwise what is missing (shown on the capabilities list) */
  needs(): string | null;
  create(opts: { timeoutMs: number; metadata?: Record<string, string>; signal?: AbortSignal }): Promise<SandboxSession>;
}

export type SandboxEventKind = 'start' | 'command' | 'code' | 'file' | 'save' | 'restore' | 'close' | 'error';

export interface SandboxEvent {
  at: number;
  kind: SandboxEventKind;
  text: string;
  ok: boolean;
  /** milliseconds the step took */
  ms?: number;
  sandboxId?: string;
}

/** Turns a user/agent path into an absolute path inside the sandbox. */
export function sandboxPath(p: string | undefined): string {
  const raw = (p ?? '').trim().replace(/\\/g, '/');
  if (!raw || raw === '.' || raw === './') return SANDBOX_WORKDIR;
  const abs = raw.startsWith('/') ? raw : `${SANDBOX_WORKDIR}/${raw.replace(/^\.\//, '')}`;
  // collapse . and .. so the result is a clean absolute path
  const out: string[] = [];
  for (const part of abs.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return `/${out.join('/')}`;
}

/** Single-quotes a value for bash. */
export function shq(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
