import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import rateLimit from 'express-rate-limit';
import { loadConfig, type AppConfig } from '../config.js';
import type { FetchLike } from '../ai/http.js';
import { buildProviders, type Providers } from '../ai/registry.js';
import { FallbackChatProvider } from '../ai/fallback.js';
import { keyId, sharedKeyHealth } from '../ai/keyHealth.js';
import { openEnv, seal } from './secretBox.js';
import { last4, readEnvFile, splitKeys, updateEnvFile, validEnvValue } from './envFile.js';
import { MANAGED_ENV, SECTIONS, findCard, type AdminCard } from './fields.js';
import { runCardTest, type TestResult } from './tests.js';
import { ADMIN_CSS, ADMIN_JS, loginPage, messagePage, passwordPage, settingsPage, setupPage } from './page.js';
import { AdminCredential, passwordProblem } from './credential.js';

/** The objects the running server uses; reloads replace their contents in place. */
export interface LiveRuntime {
  config: AppConfig;
  providers: Providers;
  agent?: { setProvider(p: Providers['agent']): void; ensureStarted?(): void } | null;
  fetchImpl?: FetchLike;
}

export interface AdminOptions {
  envFile: string;
  /** legacy plain password (ADMIN_PASSWORD), read at request time; used only until a hashed password is set */
  password: () => string;
  /** owner credential (hashed password in .env); built from envFile + password when not given */
  credential?: AdminCredential;
  /** where test results are kept between restarts; null = memory only */
  statusFile?: string | null;
  env?: NodeJS.ProcessEnv;
}

const COOKIE = 'orin_admin';
const LOGIN_COOKIE = 'orin_admin_login';
const SESSION_MS = 12 * 60 * 60_000;

function sha(s: string) {
  return createHash('sha256').update(s).digest();
}

function parseCookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function setCookie(req: Request, res: Response, name: string, value: string, maxAgeMs: number) {
  const secure = req.secure ? '; Secure' : '';
  res.append('Set-Cookie', `${name}=${encodeURIComponent(value)}; Path=/admin; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`);
}

/** Same-origin check for POSTs: Origin (or Referer) host must be this host. */
function sameOrigin(req: Request): boolean {
  const src = req.headers.origin || req.headers.referer;
  if (!src) return true; // non-browser clients; the CSRF token still applies
  try {
    return new URL(String(src)).host === req.headers.host;
  } catch {
    return false;
  }
}

/** Re-reads .env and rebuilds config + providers in place, so no restart is needed. */
/** Keys that came from the .env file, so removing them from the file also unsets them (shell values stay). */
const fromFile = new Set<string>();

export function reloadRuntime(rt: LiveRuntime, envFile: string, env: NodeJS.ProcessEnv = process.env): void {
  const fileVals = readEnvFile(envFile);
  for (const k of MANAGED_ENV) {
    if (k in fileVals && fileVals[k] !== '') {
      env[k] = fileVals[k];
      fromFile.add(k);
    } else if (fromFile.has(k)) {
      delete env[k];
      fromFile.delete(k);
    }
  }
  const next = loadConfig(env);
  const cfg = rt.config as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(next)) cfg[k] = v;
  const np = buildProviders(rt.config, rt.fetchImpl);
  rt.providers.chat = np.chat;
  rt.providers.voice = np.voice;
  rt.providers.agent = np.agent;
  rt.agent?.setProvider(np.agent);
  rt.agent?.ensureStarted?.();
  console.log(`[admin] settings reloaded: chat=${rt.config.chat.provider} (${rt.config.chat.model}), chain=${rt.config.chat.chain.map((c) => c.provider).join('>') || 'none'}, voice=${np.voice?.id ?? 'none'}`);
}

export function createAdminRouter(rt: LiveRuntime, opts: AdminOptions): express.Router {
  const env = opts.env ?? process.env;
  for (const k of Object.keys(readEnvFile(opts.envFile))) if (MANAGED_ENV.includes(k)) fromFile.add(k);
  const router = express.Router();
  const cred = opts.credential ?? new AdminCredential(opts.envFile, opts.password);
  const sessions = new Map<string, { exp: number; csrf: string }>();
  const status = new Map<string, TestResult>();
  if (opts.statusFile && existsSync(opts.statusFile)) {
    try {
      for (const [k, v] of Object.entries(JSON.parse(readFileSync(opts.statusFile, 'utf8')) as Record<string, TestResult>)) status.set(k, v);
    } catch {
      /* ignore a broken file */
    }
  }
  const saveStatus = () => {
    if (!opts.statusFile) return;
    try {
      writeFileSync(opts.statusFile, JSON.stringify(Object.fromEntries(status)), { mode: 0o600 });
    } catch {
      /* not fatal */
    }
  };

  // Behind an HTTPS proxy that reports a plain-http request: send the browser to https first,
  // so the owner password is never posted in clear text.
  router.use((req, res, next) => {
    // Some proxies send no X-Forwarded-Proto for plain http, so any proxied request
    // that is not https counts as plain http.
    const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim();
    const plain = proto === 'http' || (!proto && !req.secure && !!req.headers['x-forwarded-for']);
    if (plain && req.headers.host && (req.method === 'GET' || req.method === 'HEAD')) {
      return res.redirect(301, `https://${req.headers.host}${req.originalUrl}`);
    }
    if (plain && req.headers.host) return res.status(403).json({ error: 'https_required' });
    next();
  });
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '20kb' }));
  router.use(express.json({ limit: '100kb' }));

  const session = (req: Request) => {
    const id = parseCookies(req)[COOKIE];
    if (!id) return null;
    const s = sessions.get(id);
    if (!s || s.exp < Date.now()) {
      sessions.delete(id);
      return null;
    }
    return { id, ...s };
  };

  const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, handler: (_req, res) => res.status(429).type('html').send(loginPage('Too many attempts. Wait 15 minutes and try again.', '')) });
  const apiLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: 'draft-7', legacyHeaders: false });

  router.get('/admin.css', (_req, res) => res.type('text/css').send(ADMIN_CSS));
  router.get('/admin.js', (_req, res) => res.type('application/javascript').send(ADMIN_JS));

  const freshLoginToken = (req: Request, res: Response) => {
    const token = randomBytes(18).toString('base64url');
    setCookie(req, res, LOGIN_COOKIE, token, 30 * 60_000);
    return token;
  };

  router.get('/', (req, res) => {
    const s = session(req);
    if (s) return res.type('html').send(settingsPage(s.csrf, cred.mode() !== 'hash'));
    const note = req.query.changed === '1' ? 'Password changed. Sign in with the new password.' : '';
    res.type('html').send(loginPage('', freshLoginToken(req, res), note));
  });

  router.post('/login', loginLimiter, (req, res) => {
    const body = (req.body ?? {}) as { password?: string; csrf?: string };
    const expected = parseCookies(req)[LOGIN_COOKIE];
    const retry = () => {
      const token = randomBytes(18).toString('base64url');
      setCookie(req, res, LOGIN_COOKIE, token, 30 * 60_000);
      return token;
    };
    if (!sameOrigin(req) || !expected || body.csrf !== expected) {
      return res.status(403).type('html').send(loginPage('Your login form expired. Please try again.', retry()));
    }
    if (!cred.check(body.password)) {
      return res.status(401).type('html').send(loginPage('Wrong password.', retry()));
    }
    const id = randomBytes(32).toString('base64url');
    sessions.set(id, { exp: Date.now() + SESSION_MS, csrf: randomBytes(24).toString('base64url') });
    setCookie(req, res, COOKIE, id, SESSION_MS);
    setCookie(req, res, LOGIN_COOKIE, '', 0);
    res.redirect(303, req.baseUrl || '/admin');
  });

  // Everything below needs a session; POSTs also need the CSRF token header.
  // The phone app's "AI keys" screen: the admin password in a header instead of a cookie session.
  // /admin/app/<x> is served by the same handlers as /admin/api/<x>.
  const appLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, skipSuccessfulRequests: true, handler: (_req, res) => res.status(429).json({ error: 'too_many_attempts' }) });
  router.use((req, res, next) => {
    if (!req.url.startsWith('/app/')) return next();
    appLimiter(req, res, () => {
      if (!cred.check(req.headers['x-admin-password'])) return res.status(401).json({ error: 'wrong_password' });
      res.locals.appAuth = true;
      req.url = req.url.replace(/^\/app\//, '/api/');
      next();
    });
  });

  const requireSession = (req: Request, res: Response, next: NextFunction) => {
    if (res.locals.appAuth === true) {
      res.locals.session = { id: 'app', exp: Date.now() + 60_000, csrf: '' };
      return next();
    }
    const s = session(req);
    if (!s) return res.status(401).json({ error: 'login_required' });
    if (req.method !== 'GET') {
      const token = req.headers['x-csrf-token'];
      if (!sameOrigin(req) || typeof token !== 'string' || !timingSafeEqual(sha(token), sha(s.csrf))) return res.status(403).json({ error: 'csrf' });
    }
    res.locals.session = s;
    next();
  };

  // One-time setup link (made by the owner's command-line tool): choose a new owner password.
  router.get('/setup', (req, res) => {
    const t = String(req.query.t ?? '');
    if (!cred.checkSetupToken(t)) return res.status(404).type('html').send(messagePage('Link expired', 'This setup link is not valid or has expired. Ask for a new one.'));
    res.type('html').send(setupPage('', freshLoginToken(req, res), t));
  });

  router.post('/setup', loginLimiter, (req, res) => {
    const body = (req.body ?? {}) as { t?: string; csrf?: string; password?: string; confirm?: string };
    const t = String(body.t ?? '');
    if (!cred.checkSetupToken(t)) return res.status(404).type('html').send(messagePage('Link expired', 'This setup link is not valid or has expired. Ask for a new one.'));
    // The one-time token in the form is itself the anti-forgery secret here, so no cookie is needed
    // (some embedded/remote browsers drop the strict form cookie between loading and posting).
    if (!sameOrigin(req)) return res.status(403).type('html').send(setupPage('Your form expired. Please try again.', freshLoginToken(req, res), t));
    const pw = String(body.password ?? '').trim();
    const problem = passwordProblem(pw) ?? (pw !== String(body.confirm ?? '').trim() ? 'The two passwords do not match.' : null);
    if (problem) return res.status(400).type('html').send(setupPage(problem, freshLoginToken(req, res), t));
    cred.set(pw);
    sessions.clear();
    setCookie(req, res, LOGIN_COOKIE, '', 0);
    console.log('[admin] owner password set from a setup link; all admin sessions signed out');
    res.redirect(303, `${req.baseUrl || '/admin'}?changed=1`);
  });

  // Change the owner password while signed in (needs the current one).
  router.get('/password', (req, res) => {
    const s = session(req);
    if (!s) return res.redirect(303, req.baseUrl || '/admin');
    res.type('html').send(passwordPage('', s.csrf, cred.mode() !== 'hash'));
  });

  router.post('/password', loginLimiter, (req, res) => {
    const s = session(req);
    if (!s) return res.redirect(303, req.baseUrl || '/admin');
    const body = (req.body ?? {}) as { csrf?: string; current?: string; password?: string; confirm?: string };
    const legacy = cred.mode() !== 'hash';
    if (!sameOrigin(req) || typeof body.csrf !== 'string' || !timingSafeEqual(sha(body.csrf), sha(s.csrf))) return res.status(403).type('html').send(passwordPage('Your form expired. Please try again.', s.csrf, legacy));
    if (!cred.check(body.current)) return res.status(401).type('html').send(passwordPage('The current password is wrong.', s.csrf, legacy));
    const pw = String(body.password ?? '').trim();
    const problem = passwordProblem(pw) ?? (pw !== String(body.confirm ?? '').trim() ? 'The two new passwords do not match.' : null);
    if (problem) return res.status(400).type('html').send(passwordPage(problem, s.csrf, legacy));
    cred.set(pw);
    sessions.clear();
    setCookie(req, res, COOKIE, '', 0);
    console.log('[admin] owner password changed; all admin sessions signed out');
    res.redirect(303, `${req.baseUrl || '/admin'}?changed=1`);
  });

  router.post('/logout', requireSession, (_req, res) => {
    sessions.delete((res.locals.session as { id: string }).id);
    res.json({ ok: true });
  });

  /** .env values with saved keys decrypted (they are stored encrypted). */
  const fileEnv = () => openEnv(readEnvFile(opts.envFile));

  const cardState = (card: AdminCard, vals: Record<string, string>) => {
    const fields = card.fields.map((f) => {
      const raw = vals[f.env] ?? '';
      if (f.secret) {
        const keys = f.pool ? splitKeys(raw) : raw.trim() ? [raw.trim()] : [];
        return {
          env: f.env,
          label: f.label,
          secret: true,
          pool: !!f.pool,
          placeholder: f.placeholder,
          help: f.help,
          keys: keys.map((k) => {
            const id = keyId(k);
            const h = sharedKeyHealth.status(id);
            return { last4: last4(k), id, state: h.state, coolingFor: h.coolingFor, ok: h.ok, fail: h.fail, lastOkAt: h.lastOkAt, lastErrorAt: h.lastErrorAt, lastError: h.lastError, lastCode: h.lastCode };
          }),
        };
      }
      return { env: f.env, label: f.label, secret: false, placeholder: f.placeholder, help: f.help, options: f.options, value: raw };
    });
    const hasValue = card.fields.some((f) => (vals[f.env] ?? '').trim() !== '');
    const t = status.get(card.id);
    const st = t ? t : hasValue ? { state: 'saved', message: '', at: 0 } : { state: 'unset', message: '', at: 0 };
    return { id: card.id, title: card.title, link: card.link, linkText: card.linkText, note: card.note, testable: card.test !== 'none', status: st, fields };
  };

  router.get('/api/state', apiLimiter, requireSession, (req, res) => {
    const vals = fileEnv();
    const c = rt.config;
    const chat = rt.providers.chat;
    const chain = chat instanceof FallbackChatProvider ? chat.describe() : chat ? [{ label: chat.displayName, group: chat.id, model: c.chat.model, coolingFor: 0 }] : [];
    const base = c.agent.publicUrl || `${req.protocol}://${req.get('host')}`;
    res.json({
      sections: SECTIONS.map((s) => ({ id: s.id, title: s.title, intro: s.intro, cards: s.cards.map((card) => cardState(card, vals)) })),
      active: {
        provider: c.chat.provider,
        providerName: c.chat.displayName,
        model: c.chat.model,
        fastModel: c.chat.fastModel,
        mode: c.chat.autoSelected ? 'auto' : 'manual',
        chain,
        agent: rt.providers.agent ? `${rt.providers.agent.displayName}` : 'off',
        voice: rt.providers.voice?.id ?? 'phone voices only',
        search: c.integrations.tavilyKey ? 'Tavily' : c.integrations.braveKey ? 'Brave' : c.integrations.serperKey ? 'Serper' : c.integrations.exaKey ? 'Exa' : 'DuckDuckGo + Wikipedia (free)',
        sandbox: c.integrations.e2bKey ? 'E2B' : 'off',
        googleRedirect: `${base}/v1/connectors/google/callback`,
      },
    });
  });

  const apply = (updates: Record<string, string | null>) => {
    updateEnvFile(opts.envFile, updates);
    reloadRuntime(rt, opts.envFile, env);
  };

  router.post('/api/save', apiLimiter, requireSession, (req, res) => {
    const body = (req.body ?? {}) as { card?: string; values?: Record<string, unknown>; mode?: string };
    const card = findCard(String(body.card ?? ''));
    if (!card) return res.status(400).json({ error: 'unknown_card' });
    const values = body.values ?? {};
    const current = fileEnv();
    const updates: Record<string, string | null> = {};
    for (const f of card.fields) {
      if (!(f.env in values)) continue;
      const v = String(values[f.env] ?? '').trim();
      if (!validEnvValue(v)) return res.status(400).json({ error: 'bad_value', field: f.env });
      if (f.options && v && !f.options.includes(v)) return res.status(400).json({ error: 'bad_option', field: f.env });
      if (f.secret) {
        if (!v) continue; // empty paste box = keep what is saved
        const pasted = f.pool ? splitKeys(v) : [v];
        const merged = f.pool && body.mode === 'append' ? [...splitKeys(current[f.env]), ...pasted] : pasted;
        updates[f.env] = seal([...new Set(merged)].join(','));
      } else {
        updates[f.env] = v === '' || (f.options && v === f.options[0] && f.env !== 'POLLINATIONS_ENABLED') ? null : v;
      }
    }
    if (Object.keys(updates).length === 0) return res.json({ ok: true, unchanged: true });
    try {
      apply(updates);
    } catch (e) {
      return res.status(400).json({ error: 'save_failed', message: (e as Error).message });
    }
    status.delete(card.id);
    saveStatus();
    res.json({ ok: true });
  });

  router.post('/api/remove', apiLimiter, requireSession, (req, res) => {
    const body = (req.body ?? {}) as { card?: string; env?: string; index?: number };
    const card = findCard(String(body.card ?? ''));
    if (!card) return res.status(400).json({ error: 'unknown_card' });
    const current = fileEnv();
    const updates: Record<string, string | null> = {};
    if (body.env && typeof body.index === 'number') {
      const f = card.fields.find((x) => x.env === body.env && x.secret);
      if (!f) return res.status(400).json({ error: 'unknown_field' });
      const keys = splitKeys(current[f.env]);
      keys.splice(body.index, 1);
      updates[f.env] = keys.length ? seal(keys.join(',')) : null;
    } else {
      for (const f of card.fields) updates[f.env] = null;
    }
    try {
      apply(updates);
    } catch (e) {
      return res.status(400).json({ error: 'save_failed', message: (e as Error).message });
    }
    status.delete(card.id);
    saveStatus();
    res.json({ ok: true });
  });

  router.post('/api/test', apiLimiter, requireSession, async (req, res) => {
    const card = findCard(String((req.body as { card?: string })?.card ?? ''));
    if (!card || card.test === 'none') return res.status(400).json({ error: 'unknown_card' });
    const result = await runCardTest(card, rt.config, fileEnv(), rt.fetchImpl ?? fetch);
    status.set(card.id, result);
    saveStatus();
    res.json(result);
  });

  return router;
}

export function defaultStatusFile(config: AppConfig): string | null {
  return config.agent.dataDir && config.agent.dataDir !== ':memory:' ? join(config.agent.dataDir, 'admin-key-status.json') : null;
}
