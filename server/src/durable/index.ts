import { createHmac } from 'node:crypto';
import { FirestoreClient } from './firestore.js';
import { DurableSync } from './sync.js';

export { DurableSync } from './sync.js';

type Log = (level: 'info' | 'warn' | 'error', msg: string) => void;

/** The Firebase Auth password of the server's storage account, derived from VAULT_KEY. Never stored. */
export function serverPassword(vaultKey: string): string {
  return createHmac('sha256', vaultKey).update('orin-firebase-login-v1').digest('base64url');
}

/**
 * Turns on Firestore-backed durable storage when FIREBASE_PROJECT_ID and FIREBASE_API_KEY are set
 * (both are public identifiers) and VAULT_KEY is in the environment. Restores the saved copy into
 * dataDir and returns the syncer (call start() once the app is up), or null when it is off.
 */
export async function startDurable(dataDir: string, log: Log, env: NodeJS.ProcessEnv = process.env): Promise<DurableSync | null> {
  const projectId = (env.FIREBASE_PROJECT_ID ?? '').trim();
  const apiKey = (env.FIREBASE_API_KEY ?? '').trim();
  if ((env.DURABLE_STORAGE ?? '').toLowerCase() === 'off' || !projectId || !apiKey) {
    log('info', '[durable] off (set FIREBASE_PROJECT_ID and FIREBASE_API_KEY to keep data across restarts)');
    return null;
  }
  if (!dataDir || dataDir === ':memory:') return null;
  const vaultKey = (env.VAULT_KEY ?? '').trim();
  if (!vaultKey) {
    log('error', '[durable] off: VAULT_KEY must be set in the host environment (a generated one would be lost on restart)');
    return null;
  }
  const client = new FirestoreClient({
    projectId,
    apiKey,
    email: (env.FIREBASE_SERVER_EMAIL ?? '').trim() || 'orin-server@example.com',
    password: serverPassword(vaultKey),
    firestoreBase: env.FIRESTORE_BASE_URL || undefined,
    authBase: env.FIREBASE_AUTH_BASE_URL || undefined,
  });
  const sec = Number(env.DURABLE_SYNC_SEC);
  const sync = new DurableSync({ dataDir, client, secret: vaultKey, log, intervalMs: Number.isFinite(sec) && sec >= 5 ? sec * 1000 : 30_000 });
  await sync.restore();
  return sync;
}
