import 'dotenv/config';
import { AgentRuntime } from './agent/runtime.js';
import { buildProviders } from './ai/registry.js';
import { createApp } from './app.js';
import { dirname, resolve } from 'node:path';
import { ensureAdminPassword, ensureVaultKey, readEnvFile, updateEnvFile } from './admin/envFile.js';
import { SECTIONS } from './admin/fields.js';
import { isSealed, seal, setMasterKeyFile } from './admin/secretBox.js';
import { loadConfig } from './config.js';
import { logger } from './logger.js';
import { createSupabaseVerifier } from './middleware/auth.js';
import { createAccountService, createSupabaseAdmin } from './services/supabaseAdmin.js';
import { LogUsageSink, SupabaseUsageSink } from './services/usage.js';

// Admin key page: make sure it has a password (generated + saved to .env on first start).
const envFile = resolve(process.env.ADMIN_ENV_FILE || '.env');
// Once the owner has chosen a password (stored hashed as ADMIN_PASSWORD_HASH), no plain one is made.
const hasHash = (readEnvFile(envFile).ADMIN_PASSWORD_HASH ?? '').startsWith('scrypt.');
if (hasHash) delete process.env.ADMIN_PASSWORD;
const adminPw = hasHash ? { password: '', generated: false } : ensureAdminPassword(envFile);

// API keys are kept encrypted in .env (master key in a separate owner-only file next to it).
setMasterKeyFile(process.env.ORIN_MASTER_KEY_FILE || resolve(dirname(envFile), '.orin-master-key'));
try {
  const vals = readEnvFile(envFile);
  const updates: Record<string, string> = {};
  for (const sec of SECTIONS) for (const card of sec.cards) for (const f of card.fields) if (f.secret && vals[f.env] && !isSealed(vals[f.env])) updates[f.env] = seal(vals[f.env]!);
  if (Object.keys(updates).length) {
    updateEnvFile(envFile, updates);
    logger.info(`Encrypted ${Object.keys(updates).length} saved API key setting(s) in ${envFile}`);
  }
} catch (e) {
  logger.warn('Could not encrypt saved keys: ' + (e as Error).message);
}

const config = loadConfig();
const providers = buildProviders(config);
const admin = createSupabaseAdmin(config);

// Agent runtime: tool registry, SQLite store (notes, memory, tasks, schedules), background
// task worker and cron scheduler. Background timers only run when a tool-capable model exists.
try {
  if (ensureVaultKey(envFile)) logger.info(`Generated VAULT_KEY for the Secure Vault (saved to ${envFile}). Keep it: without it saved logins cannot be read.`);
} catch (e) {
  logger.warn('Could not save VAULT_KEY: ' + (e as Error).message);
}
const agent = new AgentRuntime({ config, provider: providers.agent });
if (agent.enabled) agent.start();

const app = createApp({
  config,
  providers,
  verifier: createSupabaseVerifier(config),
  usage: admin ? new SupabaseUsageSink(admin) : new LogUsageSink(),
  accounts: createAccountService(admin),
  agent,
  admin: {
    envFile,
    password: () => (hasHash ? '' : (process.env.ADMIN_PASSWORD ?? '')),
    host: process.env.ADMIN_HOST || undefined,
    allowPublicPath: process.env.ADMIN_PUBLIC_PATH === '1',
  },
});

// Some hosts (alwaysdata, etc.) give a specific address to bind to in IP or HOST.
const bindHost = process.env.IP || process.env.HOST || undefined;
const onListen = () => {
  logger.info('Orin API listening', {
    port: config.port,
    chat: providers.chat ? `${providers.chat.id}${providers.chat.isDemo ? ' (DEMO, not AI)' : ` / ${config.chat.model}`}` : 'NOT CONFIGURED',
    serverVoice: providers.voice ? `${providers.voice.id} (optional upgrade)` : 'off (app uses on-device voice)',
    accounts: Boolean(config.supabase.url || config.supabase.jwtSecret),
    agent: agent.enabled
      ? `on (${agent.tools.available('', agent.services).length} tools, worker ${config.agent.worker ? 'on' : 'off'})`
      : 'off (no tool-capable model)',
  });
  const adminHost = process.env.ADMIN_HOST;
  logger.info(`Admin site: ${adminHost ? `https://${adminHost}/admin (only on that host${process.env.ADMIN_PUBLIC_PATH === '1' ? ', and /admin on the public host' : ''})` : `http://localhost:${config.port}/admin${config.agent.publicUrl ? ` (public: ${config.agent.publicUrl}/admin)` : ''}`}`);
  if (adminPw.generated) {
    // The value is never printed. The owner sets their own password with a one-time link:
    logger.info(`Admin password generated and saved in ${envFile}. To choose your own, run: node dist/admin/cli.js setup-link`);
  }
  if (config.chat.chain.length > 1) logger.info('AI fallback chain: ' + config.chat.chain.map((c) => `${c.provider}${c.keys.length > 1 ? ` x${c.keys.length} keys` : ''}`).join(' > '));
  if (!providers.chat) {
    logger.warn(
      config.chat.provider !== 'none'
        ? `AI_PROVIDER=${config.chat.provider} but its key is missing. Chat will return provider_not_configured.`
        : 'No AI model connected. Free options: GEMINI_API_KEY (recommended), GROQ_API_KEY, OPENROUTER_API_KEY, or AI_PROVIDER=ollama. See README.',
    );
  }
  if (config.chat.provider === 'ollama') {
    logger.info('Using Ollama at ' + config.chat.baseUrl + '. Make sure `ollama serve` is running and the model is pulled: ollama pull ' + config.chat.model);
  }
};
const server = bindHost ? app.listen(config.port, bindHost, onListen) : app.listen(config.port, onListen);

// Long-lived SSE responses: keep sockets open long enough for slow generations.
server.requestTimeout = 0;
server.headersTimeout = 65_000;

const shutdown = (signal: string) => {
  logger.info('shutting down', { signal });
  void agent.stop().finally(() => {
    agent.store.close();
    server.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 10_000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
