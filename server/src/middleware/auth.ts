import type { NextFunction, Request, Response } from 'express';
import { createRemoteJWKSet, decodeProtectedHeader, jwtVerify, type JWTPayload } from 'jose';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { GuestIdSchema } from '../schemas.js';

export type AuthContext =
  | { kind: 'user'; userId: string; email?: string; token: string }
  | { kind: 'guest'; guestId: string };

declare module 'express-serve-static-core' {
  interface Request {
    auth?: AuthContext;
  }
}

export interface TokenVerifier {
  verify(token: string): Promise<{ sub: string; email?: string }>;
}

/** Verifies Supabase access tokens: HS256 (legacy JWT secret) or asymmetric keys via the project's JWKS endpoint. */
export function createSupabaseVerifier(config: AppConfig): TokenVerifier | null {
  const { url, jwtSecret } = config.supabase;
  if (!url && !jwtSecret) return null;
  const issuer = url ? `${url}/auth/v1` : undefined;
  const jwks = url ? createRemoteJWKSet(new URL(`${url}/auth/v1/.well-known/jwks.json`)) : null;
  const secret = jwtSecret ? new TextEncoder().encode(jwtSecret) : null;

  return {
    async verify(token: string) {
      let alg: string | undefined;
      try {
        alg = decodeProtectedHeader(token).alg;
      } catch {
        throw new AppError('auth_expired', 'Invalid session token. Please sign in again.');
      }
      let payload: JWTPayload;
      try {
        const opts = { audience: 'authenticated', ...(issuer ? { issuer } : {}) };
        if (alg === 'HS256') {
          if (!secret) throw new Error('HS256 token but no SUPABASE_JWT_SECRET configured');
          payload = (await jwtVerify(token, secret, opts)).payload;
        } else {
          if (!jwks) throw new Error('Asymmetric token but no SUPABASE_URL configured');
          payload = (await jwtVerify(token, jwks, opts)).payload;
        }
      } catch (err) {
        const code = (err as { code?: string }).code;
        throw new AppError(
          'auth_expired',
          code === 'ERR_JWT_EXPIRED' ? 'Your session expired. Please sign in again.' : 'Invalid session token. Please sign in again.',
        );
      }
      if (!payload.sub) throw new AppError('auth_expired', 'Invalid session token.');
      return { sub: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
    },
  };
}

/**
 * mode 'user': a valid account token is required.
 * mode 'guest-ok': a valid token is used when present; otherwise guests are allowed if ALLOW_GUESTS.
 * A token that is present but invalid always fails (so the app can refresh the session).
 */
export function authenticate(config: AppConfig, verifier: TokenVerifier | null, mode: 'user' | 'guest-ok') {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const header = req.header('authorization');
      if (header) {
        const match = /^Bearer\s+(.+)$/i.exec(header);
        if (!match?.[1]) throw new AppError('auth_expired', 'Malformed Authorization header.');
        if (!verifier) throw new AppError('auth_required', 'Accounts are not configured on this server.');
        const { sub, email } = await verifier.verify(match[1]);
        req.auth = { kind: 'user', userId: sub, email, token: match[1] };
        return next();
      }
      if (mode === 'user') throw new AppError('auth_required', 'Please sign in to use this feature.');
      if (!config.access.allowGuests) throw new AppError('auth_required', 'Please sign in to chat.');
      const guestHeader = req.header('x-guest-id');
      const parsed = GuestIdSchema.safeParse(guestHeader);
      req.auth = { kind: 'guest', guestId: parsed.success ? parsed.data : `ip:${req.ip ?? 'unknown'}` };
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** The four agents (characters). Each has its own memory, notes, tasks, schedules, skills and connected apps. */
export const AGENT_IDS = ['orin', 'nova', 'sage', 'max'] as const;
export function agentIdOf(req: Request): string {
  const body = req.body as { character?: unknown } | undefined;
  const raw = String(req.headers['x-orin-agent'] ?? (typeof body?.character === 'string' ? body.character : '') ?? '').toLowerCase();
  return (AGENT_IDS as readonly string[]).includes(raw) ? raw : 'orin';
}
/** Owner key for agent-scoped data: the account plus the agent (Orin keeps the plain key, so older data stays). */
export function agentOwnerKey(req: Request): string {
  const a = agentIdOf(req);
  return a === 'orin' ? requesterKey(req) : `${requesterKey(req)}#${a}`;
}
/** The account part of an owner key (vault and usage are per account, shared by the four agents). */
export function baseOwner(owner: string): string {
  return owner.split('#')[0]!;
}
export function agentOwners(base: string): string[] {
  return AGENT_IDS.map((a) => (a === 'orin' ? base : `${base}#${a}`));
}

export function requesterKey(req: Request): string {
  const a = req.auth;
  if (!a) return `ip:${req.ip}`;
  return a.kind === 'user' ? `u:${a.userId}` : `g:${a.guestId}`;
}
