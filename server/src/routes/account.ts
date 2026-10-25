import { Router } from 'express';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';
import { logger } from '../logger.js';
import { AvatarStore } from './profile.js';

export function accountRouter(deps: Deps) {
  const r = Router();

  r.get('/me', (req, res) => {
    const a = req.auth;
    if (a?.kind !== 'user') throw new AppError('auth_required', 'Please sign in.');
    res.json({ userId: a.userId, email: a.email ?? null });
  });

  r.delete('/', async (req, res, next) => {
    try {
      const a = req.auth;
      if (a?.kind !== 'user') throw new AppError('auth_required', 'Please sign in.');
      if (!deps.accounts) {
        throw new AppError('provider_not_configured', 'Account deletion needs SUPABASE_SERVICE_ROLE_KEY on the server.');
      }
      await deps.accounts.deleteAccount(a.userId);
      await AvatarStore.forConfig(deps.config).remove(`u:${a.userId}`).catch(() => false);
      logger.info('account deleted', { user: a.userId.slice(0, 8) });
      res.status(204).end();
    } catch (err) {
      if (err instanceof AppError) return next(err);
      next(new AppError('database_error', 'Could not delete the account. Please try again.'));
    }
  });

  return r;
}
