import { existsSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import express, { type NextFunction, type Request, type Response, type Router } from 'express';

/**
 * Serves the exported Expo web app (npx expo export --platform web) from the same origin as the API.
 * - Static files with long caching for hashed bundles, no-store for index.html.
 * - SPA fallback: any other GET that accepts HTML returns index.html (Expo Router resolves the route).
 * - API (/v1), admin (/admin) and anything that is not a GET keep falling through to the API 404.
 * - Headers SQLite on the web (WebAssembly + SharedArrayBuffer) needs: COOP same-origin, COEP credentialless.
 */
export function webAppRouter(webDir: string): Router | null {
  const root = resolve(webDir);
  const indexFile = join(root, 'index.html');
  if (!existsSync(indexFile) || !statSync(indexFile).isFile()) return null;

  const csp = [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' data: https:",
    "img-src * data: blob:",
    "media-src * data: blob:",
    "connect-src 'self' https: wss: blob: data:",
    "frame-src 'self' https:",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'self'",
  ].join('; ');

  const isApiPath = (p: string) => p === '/v1' || p.startsWith('/v1/') || p === '/admin' || p.startsWith('/admin/');

  const setHeaders = (res: Response) => {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
  };

  const router = express.Router();
  const statics = express.static(root, {
    index: 'index.html',
    dotfiles: 'ignore',
    fallthrough: true,
    setHeaders: (res, path) => {
      setHeaders(res as unknown as Response);
      if (path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store');
      else if (/[\\/]_expo[\\/]|[\\/]assets[\\/]/.test(path)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=3600');
      if (path.endsWith('.wasm')) res.setHeader('Content-Type', 'application/wasm');
    },
  });

  router.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path)) return next();
    statics(req, res, next);
  });

  // SPA fallback for app routes (e.g. /chat/123, /settings). Missing files with an extension stay 404.
  router.use((req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || isApiPath(req.path)) return next();
    if (/\.[a-z0-9]{1,8}$/i.test(req.path) && !req.path.endsWith('.html')) return next();
    if (!req.accepts('html')) return next();
    setHeaders(res);
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(indexFile);
  });

  return router;
}
