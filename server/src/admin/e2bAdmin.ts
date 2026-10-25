import express, { type Request, type Response } from 'express';
import { randomBytes } from 'node:crypto';

/**
 * Owner-only tools for Orin's E2B workspace, used from the admin API (cookie session or the
 * x-admin-password header via /admin/app/...). They use the server's own E2B_API_KEY, so the key
 * never has to leave the server:
 *  - build the custom sandbox template (Dockerfile text in the request body) and read its logs;
 *  - run a test job (a bash script) in a fresh sandbox of any template and read its output.
 * Nothing here touches user data.
 */

type Mod = {
  Template: {
    (): { fromDockerfile(d: string): unknown };
    buildInBackground(t: unknown, name: string, o: Record<string, unknown>): Promise<{ templateId: string; buildId: string; name: string }>;
    getBuildStatus(d: { templateId: string; buildId: string }, o: Record<string, unknown>): Promise<unknown>;
    exists(name: string, o: Record<string, unknown>): Promise<boolean>;
  };
  Sandbox: {
    create(...a: unknown[]): Promise<Sbx>;
    connect(id: string, o: Record<string, unknown>): Promise<Sbx>;
  };
};
interface Sbx {
  sandboxId: string;
  commands: { run(cmd: string, o?: Record<string, unknown>): Promise<{ stdout: string; stderr: string; exitCode: number }> };
  files: { write(p: string, d: string): Promise<unknown> };
  kill(): Promise<unknown>;
}

const load = async () => (await import('@e2b/code-interpreter')) as unknown as Mod;

interface Job {
  id: string;
  sandboxId: string;
  template: string;
  startedAt: number;
}

export function e2bAdminRoutes(key: () => string, requireSession: express.RequestHandler, limiter: express.RequestHandler): express.Router {
  const r = express.Router();
  const jobs = new Map<string, Job>();
  const opts = () => ({ apiKey: key(), requestTimeoutMs: 60_000 });
  const fail = (res: Response, e: unknown) => res.status(500).json({ error: String((e as Error)?.message ?? e).slice(0, 2000) });
  const need = (res: Response) => {
    if (key()) return false;
    res.status(400).json({ error: 'E2B_API_KEY is not set' });
    return true;
  };

  r.get('/api/e2b/info', limiter, requireSession, async (req: Request, res: Response) => {
    if (need(res)) return;
    try {
      const m = await load();
      const name = String(req.query.name ?? process.env.E2B_TEMPLATE ?? 'orin-workspace');
      res.json({ template: name, exists: await m.Template.exists(name, opts()), envTemplate: process.env.E2B_TEMPLATE ?? null });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/api/e2b/template/build', limiter, requireSession, async (req: Request, res: Response) => {
    if (need(res)) return;
    const b = (req.body ?? {}) as { name?: string; dockerfile?: string; cpuCount?: number; memoryMB?: number; minFreeDiskMb?: number; skipCache?: boolean };
    const name = String(b.name ?? '').trim();
    if (!/^[a-z0-9][a-z0-9-]{1,40}$/.test(name) || !b.dockerfile) return res.status(400).json({ error: 'name (lowercase) and dockerfile are required' });
    try {
      const m = await load();
      const tpl = m.Template().fromDockerfile(String(b.dockerfile));
      const o: Record<string, unknown> = { ...opts() };
      for (const k of ['cpuCount', 'memoryMB', 'minFreeDiskMb'] as const) if (typeof b[k] === 'number') o[k] = b[k];
      if (b.skipCache) o.skipCache = true;
      const info = await m.Template.buildInBackground(tpl, name, o);
      res.json({ templateId: info.templateId, buildId: info.buildId, name: info.name ?? name });
    } catch (e) {
      fail(res, e);
    }
  });

  r.get('/api/e2b/template/status', limiter, requireSession, async (req: Request, res: Response) => {
    if (need(res)) return;
    try {
      const m = await load();
      const st = await m.Template.getBuildStatus(
        { templateId: String(req.query.templateId ?? ''), buildId: String(req.query.buildId ?? '') },
        { ...opts(), logsOffset: Number(req.query.logsOffset ?? 0) || 0 },
      );
      res.json(st);
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/api/e2b/job', limiter, requireSession, async (req: Request, res: Response) => {
    if (need(res)) return;
    const b = (req.body ?? {}) as { template?: string; script?: string; timeoutMin?: number };
    if (!b.script) return res.status(400).json({ error: 'script is required' });
    const template = String(b.template ?? '').trim();
    const timeoutMs = Math.min(Math.max(Number(b.timeoutMin ?? 30), 1), 60) * 60_000;
    try {
      const m = await load();
      const o = { ...opts(), timeoutMs, metadata: { app: 'orin', owner: 'admin-job' } };
      const sbx = template ? await m.Sandbox.create(template, o) : await m.Sandbox.create(o);
      await sbx.files.write('/tmp/orin-job.sh', String(b.script));
      await sbx.commands.run("bash -lc 'nohup bash /tmp/orin-job.sh > /tmp/orin-job.log 2>&1; echo $? > /tmp/orin-job.exit' >/dev/null 2>&1", { background: true, timeoutMs: 0, cwd: '/home/user' });
      const id = randomBytes(6).toString('hex');
      jobs.set(id, { id, sandboxId: sbx.sandboxId, template: template || '(default)', startedAt: Date.now() });
      res.json({ id, sandboxId: sbx.sandboxId });
    } catch (e) {
      fail(res, e);
    }
  });

  const connect = async (req: Request, res: Response) => {
    const j = jobs.get(String(req.params.id));
    const sandboxId = j?.sandboxId ?? String(req.query.sandboxId ?? '');
    if (!sandboxId) {
      res.status(404).json({ error: 'unknown job' });
      return null;
    }
    const m = await load();
    return { j, sbx: await m.Sandbox.connect(sandboxId, opts()) };
  };

  r.get('/api/e2b/job/:id', limiter, requireSession, async (req: Request, res: Response) => {
    if (need(res)) return;
    try {
      const c = await connect(req, res);
      if (!c) return;
      const lines = Math.min(Number(req.query.lines ?? 80) || 80, 400);
      const out = await c.sbx.commands.run(`tail -n ${lines} /tmp/orin-job.log 2>/dev/null; echo '@@EXIT'; cat /tmp/orin-job.exit 2>/dev/null; echo '@@SYS'; df -h / | tail -1; free -m | sed -n 2p; nproc`, { timeoutMs: 30_000 });
      const [log, rest = ''] = out.stdout.split('@@EXIT\n');
      const [exit, sys = ''] = rest.split('@@SYS\n');
      res.json({ sandboxId: c.sbx.sandboxId, minutes: c.j ? Math.round((Date.now() - c.j.startedAt) / 6000) / 10 : null, exit: exit!.trim() || null, sys: sys.trim(), log });
    } catch (e) {
      fail(res, e);
    }
  });

  r.post('/api/e2b/job/:id/kill', limiter, requireSession, async (req: Request, res: Response) => {
    if (need(res)) return;
    try {
      const c = await connect(req, res);
      if (!c) return;
      await c.sbx.kill();
      jobs.delete(String(req.params.id));
      res.json({ ok: true });
    } catch (e) {
      fail(res, e);
    }
  });

  return r;
}
