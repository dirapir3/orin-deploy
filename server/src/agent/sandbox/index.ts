import type { AgentServices } from '../tools/types.js';
import { E2BProvider } from './e2b.js';
import { SandboxManager, type SandboxManagerOptions } from './manager.js';
import { restoreToSandbox, saveBeforeClose } from './persist.js';
import type { SandboxProvider } from './types.js';
import { baseOwner } from '../../middleware/auth.js';
import { sandboxConnections } from './connections.js';

export * from './types.js';
export { SandboxManager, SandboxBusyError, type SandboxStatus } from './manager.js';

/**
 * The providers this server knows. Add another service here (it only has to implement
 * SandboxProvider) and pick it with CODE_SANDBOX.
 */
export function pickProvider(svc: Pick<AgentServices, 'config'>): SandboxProvider | null {
  const i = svc.config.integrations;
  if (i.codeSandbox === 'e2b') return new E2BProvider(() => svc.config.integrations.e2bKey);
  return null;
}

/** The account's sandbox connections (AI setup > Sandboxes); the server key is the Built-in one. */
export function connectionsFor(svc: Pick<AgentServices, 'config' | 'store'>) {
  return sandboxConnections(svc.store, { serverKey: () => (svc.config.integrations.codeSandbox === 'e2b' ? svc.config.integrations.e2bKey : '') });
}

export function createSandboxManager(svc: AgentServices, opts: Partial<SandboxManagerOptions> = {}): SandboxManager {
  const conns = connectionsFor(svc);
  // a caller that hands in its own single provider (tests, tools) keeps the one-provider mode
  const single = Boolean(opts.provider) && !opts.candidates;
  return new SandboxManager({
    provider: () => pickProvider(svc),
    // many connections per account, tried in order (default first) with failover; see connections.ts
    ...(single
      ? {}
      : {
          candidates: (owner: string) => conns.candidates(baseOwner(owner)),
          onHealth: (owner: string, id: string, ok: boolean, error?: string) => conns.markHealth(baseOwner(owner), id, ok, error),
        }),
    idleMs: Number(process.env.SANDBOX_IDLE_MIN) * 60_000 || undefined,
    maxLifeMs: Number(process.env.SANDBOX_MAX_MIN) * 60_000 || undefined,
    maxSessions: Number(process.env.SANDBOX_MAX_SESSIONS) || undefined,
    onStart: async (owner, s, log) => void (await restoreToSandbox(svc, owner, s, log)),
    onBeforeClose: async (owner, s, log) => void (await saveBeforeClose(svc, owner, s, log)),
    ...opts,
  });
}
