import { durableHealth } from './durable/state.js';
import { agentExtraRouter } from './routes/agentExtra.js';
import { uploadsRouter } from './routes/uploads.js';
import { webAppRouter } from './webApp.js';
import { verifyToken } from './agent/vault.js';
import { mimeFor, readWsFile, workspaceDir } from './agent/workspace.js';
import { appendFileSync } from 'node:fs';
import cors from 'cors';
import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import multer from 'multer';
import type { AppConfig } from './config.js';
import type { FetchLike } from './ai/http.js';
import type { Providers } from './ai/registry.js';
import { AppError, toAppError } from './errors.js';
import { logger } from './logger.js';
import { authenticate, type TokenVerifier } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { accountRouter } from './routes/account.js';
import { AvatarStore, avatarFileHandler, profileRouter } from './routes/profile.js';
import { chatRouter } from './routes/chat.js';
import { filesRouter } from './routes/files.js';
import { realtimeRouter } from './routes/realtime.js';
import { voiceRouter } from './routes/voice.js';
import { setupRouter } from './routes/setup.js';
import { ttsStreams } from './ai/ttsStream.js';
import { agentRouter } from './routes/agent.js';
import { requestBaseUrl } from './routes/agentChat.js';
import { AgentRuntime } from './agent/runtime.js';
import { capabilityReport } from './agent/capabilities.js';
import { googleHandleCallback } from './agent/connectors.js';
import { createAdminRouter, defaultStatusFile } from './admin/router.js';
import type { AccountService } from './services/supabaseAdmin.js';
import type { UsageSink } from './services/usage.js';
import { aiKeysRouter } from './routes/aiKeys.js';

export interface Deps {
  config: AppConfig;
  providers: Providers;
  verifier: TokenVerifier | null;
  usage: UsageSink;
  accounts: AccountService | null;
  fetchImpl?: FetchLike;
  /** Agent runtime (tools, store, worker, scheduler). Created on demand when not supplied. */
  agent?: AgentRuntime;
  /** Admin key page at /admin (only when a password is set). */
  admin?: {
    envFile: string;
    password: () => string;
    env?: NodeJS.ProcessEnv;
    /** Owner-only admin hostname (ADMIN_HOST). When set, /admin is served only on this host and the
     *  admin host serves nothing else. Separation only; every admin request still needs owner auth. */
    host?: string;
    /** Keep /admin reachable on the public host too even when `host` is set (ADMIN_PUBLIC_PATH=1). */
    allowPublicPath?: boolean;
  };
  /** Folder with the exported web app to serve at / (defaults to the WEB_DIR env var). */
  webDir?: string;
}

export const API_VERSION = '1.0.0';

export function createApp(deps: Deps) {
  const { config, providers, verifier } = deps;
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', 1);
  // Inline images from /v1/media are loaded by the app across origins.
  app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
  app.use(
    cors({
      origin: (origin, cb) => cb(null, !origin || config.corsOrigins.includes(origin)),
      allowedHeaders: ['Content-Type', 'Authorization', 'X-Guest-Id', 'X-Orin-Agent', 'X-Orin-AI'],
      methods: ['GET', 'POST', 'DELETE', 'PATCH', 'PUT'],
    }),
  );
  // Separate admin hostname: the admin site and the public app/API never share a host.
  const adminHost = (deps.admin?.host ?? '').trim().toLowerCase();
  if (deps.admin && adminHost) {
    const allowPublic = deps.admin.allowPublicPath === true;
    app.use((req, res, next) => {
      const host = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
      const adminPath = req.path === '/admin' || req.path.startsWith('/admin/');
      if (host === adminHost) {
        if (adminPath) return next();
        if (req.path === '/') return res.redirect(302, '/admin');
        if (req.path === '/robots.txt') return res.type('text/plain').send('User-agent: *\nDisallow: /\n');
        return next(new AppError('not_found', 'Not found.'));
      }
      if (adminPath && !allowPublic) return next(new AppError('not_found', 'Not found.'));
      next();
    });
  }
  app.use(express.json({ limit: '25mb' }));

  if (!deps.agent) deps.agent = new AgentRuntime({ config, provider: providers.agent, fetchImpl: deps.fetchImpl });
  const agent = deps.agent;

  app.get('/v1/health', (_req, res) => {
    const c = config.chat;
    const real = Boolean(providers.chat && !providers.chat.isDemo);
    res.json({
      ok: true,
      version: API_VERSION,
      storage: durableHealth(),
      ai: {
        configured: real,
        demo: Boolean(providers.chat?.isDemo),
        provider: providers.chat?.id ?? null,
        providerName: real ? c.displayName : providers.chat?.isDemo ? 'Demo responder' : null,
        free: real ? c.free : null,
        model: providers.chat ? (providers.chat.isDemo ? 'demo' : c.model) : null,
        vision: Boolean(real && providers.chat?.supportsVision),
        // Setup hints for the app's setup screen. Never includes key values.
        setup: real
          ? null
          : {
              requested: c.provider,
              missingKey: c.provider !== 'none' && c.provider !== 'demo' && !c.ready,
              keysPresent: c.keysPresent,
              recommended: 'gemini',
            },
      },
      voice: {
        // Server voice is an optional upgrade; the app's default voice is on-device and needs no key.
        configured: Boolean(providers.voice),
        provider: providers.voice?.id ?? null,
        stt: providers.voice?.sttModel ?? null,
        tts: providers.voice?.supportsTts ? providers.voice.ttsModel : null,
      },
      agent: {
        enabled: agent.enabled,
        strongModel: config.chat.model,
        fastModel: config.chat.fastModel,
        caps: config.chat.caps,
        tools: agent.enabled ? agent.tools.available('', agent.services).map((t: { name: string }) => t.name) : [],
      },
      capabilities: capabilityReport(config, providers, agent),
      auth: { accounts: Boolean(verifier), guests: config.access.allowGuests, accountDeletion: Boolean(deps.accounts) },
      limits: {
        maxImageMb: Math.round(config.access.maxImageBytes / 1024 / 1024),
        maxUploadMb: Math.round(config.access.maxUploadBytes / 1024 / 1024),
      },
    });
  });

  // Dev-only: lets the app report its own errors while testing on a phone. Off unless CLIENT_LOGS=1.
  if (process.env.CLIENT_LOGS === '1') {
    app.post('/v1/client-log', (req, res) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const line = JSON.stringify({ t: new Date().toISOString(), level: body.level, msg: body.msg }).slice(0, 8000);
      try {
        appendFileSync(process.env.CLIENT_LOG_FILE ?? 'client.log', line + '\n');
      } catch {
        /* ignore */
      }
      res.json({ ok: true });
    });
  }

  // Admin page to paste API keys; saves to .env and hot-reloads providers. Password protected.
  if (deps.admin) {
    const adm = deps.admin;
    app.get(/^\/admin\/$/, (_req, res) => res.redirect(301, '/admin'));
    app.use('/admin', createAdminRouter({ config, providers, agent, fetchImpl: deps.fetchImpl }, { envFile: adm.envFile, password: adm.password, env: adm.env, statusFile: defaultStatusFile(config) }));
  }

  const guestOk = authenticate(config, verifier, 'guest-ok');
  const userOnly = authenticate(config, verifier, 'user');

  // Profile > AI keys: the user's own AI keys, kept in the Secure Vault
  app.use('/v1/ai', guestOk, createRateLimiter(config, 'ai-keys', 2), aiKeysRouter(deps));
  app.use('/v1/chat', guestOk, createRateLimiter(config, 'chat'), chatRouter(deps));
  // streaming voice clips: the random id is the permission (players cannot send auth headers)
  app.get('/v1/voice/speech/stream/:id', createRateLimiter(config, 'voice-stream', 3), (req, res) => ttsStreams.serve(req, res));
  app.use('/v1/voice', guestOk, createRateLimiter(config, 'voice', 3), voiceRouter(deps));
  app.use('/v1/setup', guestOk, createRateLimiter(config, 'setup', 1), setupRouter(deps));
  app.use('/v1/files', guestOk, createRateLimiter(config, 'files', 0.5), filesRouter(deps));
  app.use('/v1/realtime', userOnly, createRateLimiter(config, 'realtime', 0.25), realtimeRouter(deps));
  app.use('/v1/account', userOnly, createRateLimiter(config, 'account', 0.5), accountRouter(deps));
  // Profile pictures: upload/replace/remove are owner-only; the stored files have random names.
  const avatars = AvatarStore.forConfig(config);
  app.use('/v1/profile', guestOk, createRateLimiter(config, 'profile'), profileRouter(avatars));
  app.get('/v1/avatars/:file', avatarFileHandler(avatars));

  // Images made by the image tool. File names are random ids, so they are not guessable.
  app.use('/v1/media', express.static(agent.services.mediaDir, { fallthrough: true, index: false, dotfiles: 'deny', maxAge: '7d' }));

  // Google OAuth lands here from the browser (no app auth header); the signed state names the owner.
  app.get('/v1/connectors/google/callback', async (req, res) => {
    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    const page = (msg: string) =>
      `<!doctype html><meta name="viewport" content="width=device-width"><body style="font-family:system-ui;padding:2rem"><p>${msg.replace(/[<>&]/g, '')}</p><p>You can close this window and go back to Orin.</p></body>`;
    if (!code || !state) {
      res.status(400).type('html').send(page(String(req.query.error ?? 'Missing sign-in code.')));
      return;
    }
    try {
      const r = await googleHandleCallback(agent.services, code, state, requestBaseUrl(req));
      res.type('html').send(page(`Google connected${r.email ? ` as ${r.email}` : ''}.`));
    } catch (err) {
      res.status(400).type('html').send(page((err as Error).message));
    }
  });

  // Auth + rate limit only the agent prefixes, so unknown /v1 paths still fall through to 404.
  // Signed, expiring download links for workspace files (opened in the phone's browser, no auth header).
  app.get('/v1/files/:token/:name', (req, res, next) => {
    const raw = verifyToken(String(req.params.token));
    if (!raw) return next(new AppError('not_found', 'This link has expired.'));
    try {
      const { o, p } = JSON.parse(raw) as { o: string; p: string };
      const buf = readWsFile(workspaceDir(agent.services, o), p);
      res.setHeader('Content-Type', mimeFor(p));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      if (/html|svg|javascript/.test(mimeFor(p))) res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src * data:; sandbox");
      res.send(buf);
    } catch {
      next(new AppError('not_found', 'File not found.'));
    }
  });

  // Auth + rate limit only the agent prefixes, so unknown /v1 paths still fall through to 404.
  app.use(['/v1/agent', '/v1/connectors'], guestOk, createRateLimiter(config, 'agent', 4));
  app.use('/v1', agentRouter(deps));
  app.use('/v1', agentExtraRouter(deps));
  app.use('/v1', uploadsRouter(deps));

  // Android APK download: on hosts without a persistent disk the APK lives elsewhere (e.g. a Hugging Face
  // repo) and APK_URL points at it, so the familiar /download/Orin.apk link keeps working.
  const apkUrl = (process.env.APK_URL ?? '').trim();
  if (apkUrl) app.get(['/download/Orin.apk', '/download/orin.apk'], (_req, res) => res.redirect(302, apkUrl));

  // The exported web app (same origin as the API) when WEB_DIR points at an Expo web export.
  const webDir = deps.webDir ?? process.env.WEB_DIR;
  if (webDir) {
    const web = webAppRouter(webDir);
    if (web) app.use(web);
    else logger.warn(`WEB_DIR is set but has no index.html: ${webDir}`);
  }

  app.use((_req, _res, next) => next(new AppError('not_found', 'Not found.')));

  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    let e: AppError;
    if (err instanceof multer.MulterError) {
      e =
        err.code === 'LIMIT_FILE_SIZE'
          ? new AppError('file_too_large', 'That file is too large.')
          : new AppError('validation_error', 'Invalid upload.');
    } else if ((err as { type?: string })?.type === 'entity.too.large') {
      e = new AppError('file_too_large', 'Request is too large. Try a smaller image.');
    } else if ((err as { type?: string })?.type === 'entity.parse.failed') {
      e = new AppError('validation_error', 'Request body is not valid JSON.');
    } else {
      e = toAppError(err);
    }
    if (e.status >= 500 && e.code === 'internal_error') logger.error('unhandled error', { path: req.path, err: String(err) });
    if (res.headersSent) {
      res.end();
      return;
    }
    if (e.code === 'auth_expired' || e.code === 'auth_required') res.setHeader('WWW-Authenticate', 'Bearer');
    res.status(e.status).json(e.toJSON());
  });

  return app;
}
