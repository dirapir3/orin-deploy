import type { Request } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';

/** Per-user (or per guest+IP) rate limiter. Must run after authenticate(). */
export function createRateLimiter(config: AppConfig, name: string, multiplier = 1) {
  return rateLimit({
    windowMs: config.access.rateLimitWindowMs,
    limit: (req: Request) =>
      Math.max(1, Math.round((req.auth?.kind === 'user' ? config.access.rateLimitMax : config.access.rateLimitGuestMax) * multiplier)),
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req: Request) => {
      const ip = ipKeyGenerator(req.ip ?? '0.0.0.0');
      const a = req.auth;
      if (a?.kind === 'user') return `${name}:u:${a.userId}`;
      // Guests are keyed by IP *and* guest id so a client cannot dodge limits by rotating ids.
      return `${name}:g:${ip}`;
    },
    handler: (_req, _res, next) => {
      next(new AppError('rate_limited', 'You are sending requests too quickly. Please wait a moment and try again.'));
    },
  });
}
