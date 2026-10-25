import { createRequire } from 'node:module';
import { SANDBOX_WORKDIR, type ExecResult, type SandboxProvider, type SandboxSession } from './types.js';

/**
 * E2B (e2b.dev) provider. Uses the official SDK (@e2b/code-interpreter, which includes the base
 * `e2b` Sandbox API). The default template is E2B's code-interpreter image: Debian with Python 3
 * (numpy, pandas, matplotlib...), Node.js, git and the usual command line tools.
 * E2B_TEMPLATE (env) picks another template, e.g. one with Chromium baked in.
 */

const require = createRequire(import.meta.url);
const SDK = '@e2b/code-interpreter';

function hasSdk(): boolean {
  try {
    require.resolve(SDK);
    return true;
  } catch {
    return false;
  }
}

// Minimal shape of the SDK objects used here (the SDK is loaded lazily so the server starts without it).
interface E2BCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
}
interface E2BSandbox {
  sandboxId: string;
  commands: {
    run(cmd: string, o?: Record<string, unknown>): Promise<E2BCommandResult & { pid?: number }>;
  };
  files: {
    write(path: string, data: string | ArrayBuffer): Promise<unknown>;
    read(path: string, o: { format: 'bytes' }): Promise<Uint8Array>;
    makeDir(path: string): Promise<boolean>;
  };
  getHost(port: number): string;
  setTimeout(ms: number): Promise<void>;
  kill(): Promise<boolean>;
}
interface E2BSandboxClass {
  create(o: Record<string, unknown>): Promise<E2BSandbox>;
  create(template: string, o: Record<string, unknown>): Promise<E2BSandbox>;
}

const cap = (s: string, n: number) => (s.length > n ? `…${s.slice(-n)}` : s);

class E2BSession implements SandboxSession {
  readonly provider = 'e2b';
  constructor(private readonly sbx: E2BSandbox) {}

  get id() {
    return this.sbx.sandboxId;
  }

  async exec(cmd: string, o: { cwd?: string; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<ExecResult> {
    let stdout = '';
    let stderr = '';
    const timeoutMs = o.timeoutMs ?? 120_000;
    try {
      const r = await this.sbx.commands.run(cmd, {
        cwd: o.cwd ?? SANDBOX_WORKDIR,
        timeoutMs,
        // keep the tail if a command is very chatty
        onStdout: (d: string) => void (stdout = cap(stdout + d, 60_000)),
        onStderr: (d: string) => void (stderr = cap(stderr + d, 30_000)),
        ...(o.signal ? { signal: o.signal } : {}),
      });
      return { stdout: r.stdout || stdout, stderr: r.stderr || stderr, exitCode: r.exitCode };
    } catch (e) {
      // The SDK throws CommandExitError for a non-zero exit; it carries the result.
      const err = e as Partial<E2BCommandResult> & { name?: string; message?: string };
      if (typeof err.exitCode === 'number') return { stdout: err.stdout ?? stdout, stderr: err.stderr ?? stderr, exitCode: err.exitCode };
      const msg = String(err.message ?? e);
      if (/timeout|timed out|deadline/i.test(msg) || err.name === 'TimeoutError') {
        return { stdout, stderr: `${stderr}\n(stopped: time limit of ${Math.round(timeoutMs / 1000)} s reached)`.trim(), exitCode: null, timedOut: true };
      }
      if (o.signal?.aborted) return { stdout, stderr: `${stderr}\n(stopped: cancelled)`.trim(), exitCode: null };
      throw e;
    }
  }

  async execBackground(cmd: string, o: { cwd?: string } = {}) {
    const h = await this.sbx.commands.run(cmd, { cwd: o.cwd ?? SANDBOX_WORKDIR, background: true, timeoutMs: 0 });
    return { pid: typeof h.pid === 'number' ? h.pid : null };
  }

  async writeFile(path: string, data: string | Uint8Array) {
    const body = typeof data === 'string' ? data : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer);
    await this.sbx.files.write(path, body);
  }

  async readFile(path: string) {
    return this.sbx.files.read(path, { format: 'bytes' });
  }

  publicUrl(port: number) {
    return `https://${this.sbx.getHost(port)}`;
  }

  async extend(ms: number) {
    await this.sbx.setTimeout(ms);
  }

  async close() {
    await this.sbx.kill();
  }
}

export class E2BProvider implements SandboxProvider {
  readonly id = 'e2b';
  constructor(
    private readonly apiKey: () => string,
    private readonly template: () => string = () => process.env.E2B_TEMPLATE ?? '',
  ) {}

  needs(): string | null {
    if (!this.apiKey()) return 'E2B_API_KEY';
    if (!hasSdk()) return `npm install ${SDK} (in server/)`;
    return null;
  }

  async create(o: { timeoutMs: number; metadata?: Record<string, string> }): Promise<SandboxSession> {
    const mod = (await import(/* @vite-ignore */ SDK)) as { Sandbox: E2BSandboxClass };
    const opts = { apiKey: this.apiKey(), timeoutMs: o.timeoutMs, metadata: o.metadata ?? {}, requestTimeoutMs: 60_000 };
    const tpl = this.template();
    const sbx = tpl ? await mod.Sandbox.create(tpl, opts) : await mod.Sandbox.create(opts);
    const session = new E2BSession(sbx);
    try {
      await sbx.files.makeDir(SANDBOX_WORKDIR);
    } catch {
      await session.exec(`mkdir -p ${SANDBOX_WORKDIR}`, { cwd: '/' }).catch(() => undefined);
    }
    return session;
  }
}
