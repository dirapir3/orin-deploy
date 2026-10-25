import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Router, type NextFunction, type Request, type Response } from 'express';
import multer from 'multer';
import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import { AVATAR_MAX_UPLOAD_BYTES, processAvatar } from '../lib/avatarImage.js';
import { logger } from '../logger.js';
import { requesterKey } from '../middleware/auth.js';

/** Public avatar file names: 32 random hex characters, made by the server, never by the client. */
export const AVATAR_FILE_RE = /^[a-f0-9]{32}\.jpg$/;
/** Total space all profile pictures may use together (the host has little disk). */
const DEFAULT_STORE_MAX_BYTES = 5 * 1024 * 1024;

export interface AvatarInfo {
  url: string;
  width: number;
  height: number;
  bytes: number;
  updatedAt: string;
}

interface Pointer {
  file: string;
  width: number;
  height: number;
  bytes: number;
  updatedAt: string;
}

/**
 * One picture per account. avatars/<random>.jpg holds the image; avatars/owners/<sha256(owner)>.json
 * says which file belongs to which account. The owner always comes from the verified session (or the
 * guest id header), never from the request body.
 */
export class AvatarStore {
  readonly dir: string;
  private readonly ownersDir: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(dir: string, private readonly maxStoreBytes = DEFAULT_STORE_MAX_BYTES) {
    this.dir = resolve(dir);
    this.ownersDir = join(this.dir, 'owners');
  }

  static forConfig(config: AppConfig): AvatarStore {
    const d = config.agent.dataDir;
    const base = d && d !== ':memory:' ? resolve(d) : join(process.cwd(), '.orin-avatars-test');
    const max = Number(process.env.AVATAR_STORE_MAX_BYTES);
    return new AvatarStore(join(base, 'avatars'), Number.isFinite(max) && max > 0 ? max : DEFAULT_STORE_MAX_BYTES);
  }

  private ensure() {
    mkdirSync(this.ownersDir, { recursive: true, mode: 0o750 });
  }

  private pointerPath(owner: string) {
    return join(this.ownersDir, `${createHash('sha256').update(`orin-avatar:${owner}`).digest('hex')}.json`);
  }

  private read(owner: string): Pointer | null {
    try {
      const p = JSON.parse(readFileSync(this.pointerPath(owner), 'utf8')) as Pointer;
      if (!AVATAR_FILE_RE.test(p.file) || !existsSync(join(this.dir, p.file))) return null;
      return p;
    } catch {
      return null;
    }
  }

  private info(p: Pointer): AvatarInfo {
    return { url: `/v1/avatars/${p.file}`, width: p.width, height: p.height, bytes: p.bytes, updatedAt: p.updatedAt };
  }

  get(owner: string): AvatarInfo | null {
    const p = this.read(owner);
    return p ? this.info(p) : null;
  }

  usedBytes(): number {
    if (!existsSync(this.dir)) return 0;
    let total = 0;
    for (const f of readdirSync(this.dir)) {
      if (!AVATAR_FILE_RE.test(f)) continue;
      try {
        total += statSync(join(this.dir, f)).size;
      } catch {
        /* removed meanwhile */
      }
    }
    return total;
  }

  /** Absolute path of a stored picture, or null. Only server-made names resolve. */
  filePath(name: string): string | null {
    if (!AVATAR_FILE_RE.test(name)) return null;
    const p = join(this.dir, name);
    return existsSync(p) ? p : null;
  }

  /** Pictures are processed one at a time, which caps the memory decoding can take. */
  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  set(owner: string, upload: Buffer): Promise<AvatarInfo> {
    return this.serial(() => {
      const img = processAvatar(upload);
      this.ensure();
      const old = this.read(owner);
      const used = this.usedBytes() - (old?.bytes ?? 0);
      if (used + img.jpeg.length > this.maxStoreBytes) {
        throw new AppError('file_too_large', 'Profile picture storage on this server is full right now. Please try again later.', { status: 507 });
      }
      const file = `${randomBytes(16).toString('hex')}.jpg`;
      writeFileSync(join(this.dir, file), img.jpeg, { mode: 0o640, flag: 'wx' });
      const ptr: Pointer = { file, width: img.width, height: img.height, bytes: img.jpeg.length, updatedAt: new Date().toISOString() };
      const target = this.pointerPath(owner);
      const tmp = `${target}.${randomBytes(4).toString('hex')}.tmp`;
      try {
        writeFileSync(tmp, JSON.stringify(ptr), { mode: 0o640 });
        renameSync(tmp, target);
      } catch (err) {
        safeUnlink(join(this.dir, file));
        safeUnlink(tmp);
        throw err;
      }
      if (old && old.file !== file) safeUnlink(join(this.dir, old.file));
      return this.info(ptr);
    });
  }

  remove(owner: string): Promise<boolean> {
    return this.serial(() => {
      const old = this.read(owner);
      safeUnlink(this.pointerPath(owner));
      if (old) safeUnlink(join(this.dir, old.file));
      return Boolean(old);
    });
  }
}

function safeUnlink(p: string) {
  try {
    unlinkSync(p);
  } catch {
    /* already gone */
  }
}

/** The account the picture belongs to. Guests need a real guest id; an IP fallback is not an identity. */
export function avatarOwner(req: Request): string {
  const a = req.auth;
  if (!a || (a.kind === 'guest' && a.guestId.startsWith('ip:'))) {
    throw new AppError('auth_required', 'Open Orin in the app to set a profile picture.');
  }
  return requesterKey(req);
}

export function profileRouter(store: AvatarStore) {
  const r = Router();
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: AVATAR_MAX_UPLOAD_BYTES, files: 1, fields: 4, parts: 6, fieldSize: 1024 },
  }).single('avatar');
  const receive = (req: Request, res: Response, next: NextFunction) =>
    upload(req, res, (err: unknown) => {
      if (err instanceof multer.MulterError) {
        return next(
          err.code === 'LIMIT_FILE_SIZE'
            ? new AppError('file_too_large', 'Profile pictures can be up to 2 MB.')
            : new AppError('validation_error', 'Send one picture in the "avatar" field.'),
        );
      }
      next(err as Error | undefined);
    });

  r.get('/avatar', (req, res) => {
    const owner = avatarOwner(req);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ avatar: store.get(owner) });
  });

  const save = async (req: Request, res: Response, next: NextFunction) => {
    try {
      const owner = avatarOwner(req);
      if (!req.file) throw new AppError('validation_error', 'No picture was received.');
      const avatar = await store.set(owner, req.file.buffer);
      logger.info('avatar saved', { bytes: avatar.bytes });
      res.setHeader('Cache-Control', 'no-store');
      res.json({ avatar });
    } catch (err) {
      next(err);
    }
  };
  // The owner check runs before the body is read, so anonymous uploads are refused without buffering.
  const ownerFirst = (req: Request, _res: Response, next: NextFunction) => {
    try {
      avatarOwner(req);
      next();
    } catch (err) {
      next(err);
    }
  };
  r.put('/avatar', ownerFirst, receive, save);
  r.post('/avatar', ownerFirst, receive, save);

  r.delete('/avatar', async (req, res, next) => {
    try {
      await store.remove(avatarOwner(req));
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return r;
}

/** Serves stored pictures. Names are random and change on every upload, so they cache forever. */
export function avatarFileHandler(store: AvatarStore) {
  return (req: Request, res: Response, next: NextFunction) => {
    const p = store.filePath(String(req.params.file ?? ''));
    if (!p) return next(new AppError('not_found', 'Not found.'));
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline; filename="avatar.jpg"');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.sendFile(p, { dotfiles: 'deny', headers: { 'Content-Type': 'image/jpeg' } }, (err) => {
      if (err && !res.headersSent) next(new AppError('not_found', 'Not found.'));
    });
  };
}
