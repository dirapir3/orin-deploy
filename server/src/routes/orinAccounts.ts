import { Router, type Request } from 'express';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';
import { OrinAccounts, type OrinAccount } from '../services/orinAccounts.js';

/** The workspace (guest id) this request comes from; accounts bind to it. */
function workspaceOf(req: Request): string {
  const a = req.auth;
  if (a?.kind !== 'guest' || a.guestId.startsWith('ip:')) {
    throw new AppError('validation_error', 'Update the app to set up an account.');
  }
  return a.guestId;
}

/**
 * /v1/accounts: sign up, sign in, the signed-in account, name changes, password reset, delete.
 * The session token travels in X-Orin-Session (never Authorization, which stays for Supabase).
 */
export function orinAccountsRouter(accounts: OrinAccounts | null) {
  const r = Router();
  const need = () => {
    if (!accounts) throw new AppError('provider_not_configured', 'Accounts are not set up on this server.');
    return accounts;
  };
  const current = async (req: Request): Promise<OrinAccount> => {
    const token = String(req.header('x-orin-session') ?? '').trim();
    if (!token) throw new AppError('auth_required', 'Please sign in.');
    return need().verify(token);
  };

  r.get('/status', (_req, res) => {
    res.json({ enabled: Boolean(accounts), methods: accounts ? ['email'] : [] });
  });

  r.post('/signup', async (req, res, next) => {
    try {
      const ws = workspaceOf(req);
      const { account, session } = await need().signUp(req.body ?? {}, ws);
      logger.info('account created', { user: account.uid.slice(0, 6) });
      res.status(201).json({ account: OrinAccounts.pub(account), session, workspace: account.workspace });
    } catch (e) {
      next(e);
    }
  });

  r.post('/signin', async (req, res, next) => {
    try {
      const ws = workspaceOf(req);
      const out = await need().signIn(req.body ?? {}, ws);
      res.json({ account: OrinAccounts.pub(out.account), session: out.session, workspace: out.workspace, moved: out.moved });
    } catch (e) {
      next(e);
    }
  });

  r.get('/me', async (req, res, next) => {
    try {
      const a = await current(req);
      res.json({ account: OrinAccounts.pub(a), workspace: a.workspace });
    } catch (e) {
      next(e);
    }
  });

  r.patch('/me', async (req, res, next) => {
    try {
      const a = need().update(await current(req), { name: (req.body ?? {}).name });
      res.json({ account: OrinAccounts.pub(a) });
    } catch (e) {
      next(e);
    }
  });

  r.post('/reset', async (req, res, next) => {
    try {
      await need().sendReset((req.body ?? {}).email);
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  r.post('/delete', async (req, res, next) => {
    try {
      const a = await current(req);
      await need().remove(a, (req.body ?? {}).password);
      logger.info('account deleted', { user: a.uid.slice(0, 6) });
      res.json({ ok: true });
    } catch (e) {
      next(e);
    }
  });

  return r;
}
