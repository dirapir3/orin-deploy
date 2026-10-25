/**
 * Owner command-line tool for the admin site. Run on the server, in the server folder:
 *
 *   node dist/admin/cli.js setup-link [minutes]   one-time link to choose the owner password
 *   node dist/admin/cli.js status                 which kind of admin password is set (never prints it)
 *
 * Uses ADMIN_ENV_FILE (default ./.env) and ADMIN_HOST / PUBLIC_URL for the link's address.
 */
import { resolve } from 'node:path';
import { AdminCredential } from './credential.js';
import { readEnvFile } from './envFile.js';

const envFile = resolve(process.env.ADMIN_ENV_FILE || '.env');
const cred = new AdminCredential(envFile, () => process.env.ADMIN_PASSWORD || readEnvFile(envFile).ADMIN_PASSWORD || '');
const [cmd, arg] = process.argv.slice(2);

function base(): string {
  const host = process.env.ADMIN_HOST || readEnvFile(envFile).ADMIN_HOST;
  if (host) return `https://${host}`;
  return (process.env.PUBLIC_URL || readEnvFile(envFile).PUBLIC_URL || 'http://localhost:8787').replace(/\/+$/, '');
}

if (cmd === 'setup-link') {
  const minutes = Math.min(24 * 60, Math.max(5, Number(arg) || 30));
  const token = cred.createSetupToken(minutes);
  console.log(`${base()}/admin/setup?t=${token}`);
  console.error(`One-time link, valid ${minutes} minutes. Opening it lets you choose the owner password.`);
} else if (cmd === 'status') {
  console.log(`admin password: ${cred.mode()}`);
} else {
  console.error('Usage: node dist/admin/cli.js setup-link [minutes] | status');
  process.exit(2);
}
