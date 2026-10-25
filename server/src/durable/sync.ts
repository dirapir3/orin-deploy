import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bytes, getBytes, getInt, getStr, int, str, type FirestoreClient, type FsWrite } from './firestore.js';

/**
 * Durable storage: mirrors the server's data folder (agent SQLite database with memories, notes,
 * tasks, schedules, skills, the Secure Vault and saved AI keys; workspace files; published sites;
 * media; avatars; admin settings) to Firestore, and restores it on boot before anything opens it.
 *
 * - Everything sent to Firestore is encrypted with AES-256-GCM using a key derived from VAULT_KEY
 *   (which lives only in the host's environment). Vault rows are already encrypted on top of that.
 *   File names are encrypted too; document ids are keyed hashes.
 * - The SQLite database is copied with VACUUM INTO, so a copy is never half-written.
 * - Files are split into ~600 KB encrypted chunks. A file's manifest entry only points at a new
 *   version after all of its chunks are written, so a crash mid-upload leaves the old version intact.
 * - If the restore at boot fails, uploading is switched off for this run so an empty disk can never
 *   overwrite the saved copy.
 * - The newest server instance takes a lease; an older one (during a redeploy) stops writing.
 * - Never synced: VAULT_KEY / ORIN_MASTER_KEY lines, the master key file, SQLite -wal/-shm files.
 */

export const FILES = 'orin_files';
export const BLOBS = 'orin_blobs';
export const META = 'orin_meta';
const CHUNK = 600_000;
const COMMIT_BUDGET = 7_000_000; // base64 bytes per commit (Firestore limit is ~10 MB)

export interface DurableOptions {
  dataDir: string;
  client: FirestoreClient;
  /** Secret used to derive the encryption and hashing keys (VAULT_KEY). */
  secret: string;
  log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  intervalMs?: number;
}

interface Remote {
  id: string;
  h: string;
  v: string;
  n: number;
}
interface Known {
  sig: string;
  h: string;
  size: number;
}

export interface DurableStatus {
  enabled: boolean;
  restored: boolean;
  restoredFiles: number;
  restoreFailures: number;
  savedFiles: number;
  lastSyncAt: number | null;
  lastError: string | null;
  superseded: boolean;
  skipped: string[];
}

const SKIP_NAMES = new Set(['.orin-master-key']);
const SKIP_DIRS = new Set(['node_modules', '.cache', 'tmp', '.durable-tmp']);
const SKIP_SUFFIX = ['-wal', '-shm', '-journal', '.tmp', '.part'];
const STRIP_ENV_KEYS = /^\s*(VAULT_KEY|ORIN_MASTER_KEY)\s*=.*$/gm;

export class DurableSync {
  private readonly dir: string;
  private readonly encKey: Buffer;
  private readonly macKey: Buffer;
  private readonly instance = randomUUID();
  private remote = new Map<string, Remote>();
  private known = new Map<string, Known>();
  /** Paths that exist remotely but could not be restored: never deleted remotely. */
  private protectedPaths = new Set<string>();
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private readonly st: DurableStatus = {
    enabled: true,
    restored: false,
    restoredFiles: 0,
    restoreFailures: 0,
    savedFiles: 0,
    lastSyncAt: null,
    lastError: null,
    superseded: false,
    skipped: [],
  };

  constructor(private readonly o: DurableOptions) {
    if (!o.secret) throw new Error('Durable storage needs VAULT_KEY.');
    this.dir = resolve(o.dataDir);
    this.encKey = createHash('sha256').update(`orin-durable-enc:${o.secret}`).digest();
    this.macKey = createHash('sha256').update(`orin-durable-mac:${o.secret}`).digest();
  }

  status(): DurableStatus {
    return { ...this.st, skipped: [...this.st.skipped] };
  }

  private log(level: 'info' | 'warn' | 'error', msg: string) {
    this.o.log?.(level, `[durable] ${msg}`);
  }

  // ---------- crypto ----------
  private mac(data: Buffer | string): string {
    return createHmac('sha256', this.macKey).update(data).digest('hex');
  }
  private fileId(rel: string): string {
    return this.mac(`path:${rel}`).slice(0, 40);
  }
  private seal(plain: Buffer, aad: string): Buffer {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey, iv);
    c.setAAD(Buffer.from(aad));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), ct]);
  }
  private open(box: Buffer, aad: string): Buffer {
    const d = createDecipheriv('aes-256-gcm', this.encKey, box.subarray(0, 12));
    d.setAAD(Buffer.from(aad));
    d.setAuthTag(box.subarray(12, 28));
    return Buffer.concat([d.update(box.subarray(28)), d.final()]);
  }

  // ---------- restore ----------
  /** Downloads the saved copy into the data folder. Call before anything opens the data. */
  async restore(attempts = 3): Promise<boolean> {
    let lastErr: unknown;
    for (let a = 0; a < attempts; a++) {
      try {
        await this.restoreOnce();
        this.st.restored = true;
        this.log('info', `restored ${this.st.restoredFiles} file(s)${this.st.restoreFailures ? `, ${this.st.restoreFailures} failed` : ''}`);
        return true;
      } catch (e) {
        lastErr = e;
        this.log('warn', `restore attempt ${a + 1} failed: ${(e as Error).message}`);
        await new Promise((r) => setTimeout(r, 1500 * (a + 1)));
      }
    }
    this.st.enabled = false;
    this.st.lastError = `restore failed: ${(lastErr as Error)?.message ?? lastErr}`;
    this.log('error', 'restore failed; saving is OFF for this run so the saved copy is not overwritten');
    return false;
  }

  private async restoreOnce() {
    this.remote.clear();
    this.protectedPaths.clear();
    this.st.restoredFiles = 0;
    this.st.restoreFailures = 0;
    const docs = await this.o.client.list(FILES);
    mkdirSync(this.dir, { recursive: true });
    for (const d of docs) {
      let rel = '';
      try {
        rel = this.open(getBytes(d, 'p'), `path:${d.id}`).toString('utf8');
        if (!isSafeRel(rel) || this.fileId(rel) !== d.id) throw new Error('bad path entry');
        const r: Remote = { id: d.id, h: getStr(d, 'h'), v: getStr(d, 'v'), n: getInt(d, 'n') };
        const parts: Buffer[] = [];
        for (let i = 0; i < r.n; i++) {
          const b = await this.o.client.get(BLOBS, `${r.id}_${r.v}_${i}`);
          if (!b) throw new Error(`missing chunk ${i}`);
          parts.push(this.open(getBytes(b, 'd'), `${r.id}:${r.v}:${i}`));
        }
        const content = Buffer.concat(parts);
        if (this.mac(content) !== r.h) throw new Error('content check failed');
        const abs = join(this.dir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        // A stale -wal/-shm next to a restored database would corrupt it.
        if (rel.endsWith('.sqlite')) for (const s of ['-wal', '-shm']) rmSync(abs + s, { force: true });
        const tmp = `${abs}.durable-${process.pid}.tmp`;
        writeFileSync(tmp, content, { mode: rel.endsWith('.env') ? 0o600 : 0o644 });
        renameSync(tmp, abs);
        this.remote.set(rel, r);
        this.st.restoredFiles++;
      } catch (e) {
        this.st.restoreFailures++;
        if (rel) this.protectedPaths.add(rel);
        // Keep the entry known so it is never treated as "deleted locally".
        if (rel) this.remote.set(rel, { id: d.id, h: getStr(d, 'h'), v: getStr(d, 'v'), n: getInt(d, 'n') });
        this.log('warn', `could not restore one file (${(e as Error).message})`);
      }
    }
  }

  // ---------- saving ----------
  /** Takes the lease and starts the periodic save. */
  async start(): Promise<void> {
    if (!this.st.enabled) return;
    try {
      await this.o.client.commit([{ op: 'set', collection: META, id: 'lease', fields: { i: str(this.instance), t: int(Date.now()) } }]);
    } catch (e) {
      this.st.lastError = `lease: ${(e as Error).message}`;
      this.log('warn', this.st.lastError);
    }
    const every = this.o.intervalMs ?? 30_000;
    this.timer = setInterval(() => void this.sync().catch(() => undefined), every);
    this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Saves now and waits (used on shutdown). */
  async flush(timeoutMs = 20_000): Promise<void> {
    this.stop();
    await Promise.race([this.sync(true), new Promise((r) => setTimeout(r, timeoutMs).unref())]);
  }

  /** One save pass. Concurrent calls share the running pass. */
  sync(force = false): Promise<void> {
    if (!this.st.enabled || this.st.superseded || !this.st.restored) return Promise.resolve();
    if (this.running) return force ? this.running.then(() => this.syncPass()) : this.running;
    this.running = this.syncPass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async syncPass(): Promise<void> {
    try {
      const lease = await this.o.client.get(META, 'lease');
      if (lease && getStr(lease, 'i') && getStr(lease, 'i') !== this.instance) {
        this.st.superseded = true;
        this.stop();
        this.log('warn', 'a newer server instance took over saving; this one stops writing');
        return;
      }
      const local = this.scan();
      let total = 0;
      const skipped: string[] = [];
      for (const [rel, f] of local) {
        total += f.size;
        if (f.size > (this.o.maxFileBytes ?? 20_000_000) || total > (this.o.maxTotalBytes ?? 400_000_000)) {
          skipped.push(rel);
          continue;
        }
        const r = this.remote.get(rel);
        if (r && r.h === f.h) continue;
        await this.upload(rel, f.content(), f.h);
      }
      for (const [rel, r] of [...this.remote]) {
        if (local.has(rel) || this.protectedPaths.has(rel)) continue;
        await this.remove(rel, r);
      }
      this.st.skipped = skipped;
      this.st.savedFiles = this.remote.size;
      this.st.lastSyncAt = Date.now();
      this.st.lastError = null;
    } catch (e) {
      this.st.lastError = (e as Error).message;
      this.log('warn', `save failed: ${this.st.lastError}`);
    }
  }

  private async upload(rel: string, content: Buffer, h: string) {
    const id = this.fileId(rel);
    const v = h.slice(0, 16);
    const old = this.remote.get(rel);
    const n = Math.max(1, Math.ceil(content.length / CHUNK));
    let batch: FsWrite[] = [];
    let size = 0;
    for (let i = 0; i < n; i++) {
      const box = this.seal(content.subarray(i * CHUNK, (i + 1) * CHUNK), `${id}:${v}:${i}`);
      const b64 = Math.ceil(box.length / 3) * 4;
      if (batch.length && size + b64 > COMMIT_BUDGET) {
        await this.o.client.commit(batch);
        batch = [];
        size = 0;
      }
      batch.push({ op: 'set', collection: BLOBS, id: `${id}_${v}_${i}`, fields: { d: bytes(box) } });
      size += b64;
    }
    // Manifest flips to the new version in the same commit as the last chunks.
    batch.push({
      op: 'set',
      collection: FILES,
      id,
      fields: { p: bytes(this.seal(Buffer.from(rel), `path:${id}`)), h: str(h), v: str(v), n: int(n), s: int(content.length), t: int(Date.now()) },
    });
    await this.o.client.commit(batch);
    this.remote.set(rel, { id, h, v, n });
    if (old && old.v !== v) await this.deleteChunks(old);
  }

  private async remove(rel: string, r: Remote) {
    await this.o.client.commit([{ op: 'delete', collection: FILES, id: r.id }]);
    this.remote.delete(rel);
    await this.deleteChunks(r);
  }

  private async deleteChunks(r: Remote) {
    const writes: FsWrite[] = [];
    for (let i = 0; i < r.n; i++) writes.push({ op: 'delete', collection: BLOBS, id: `${r.id}_${r.v}_${i}` });
    for (let i = 0; i < writes.length; i += 400) await this.o.client.commit(writes.slice(i, i + 400)).catch(() => undefined);
  }

  /** Lists local files with content hashes; unchanged files reuse the last hash. */
  private scan(): Map<string, { size: number; h: string; content: () => Buffer }> {
    const out = new Map<string, { size: number; h: string; content: () => Buffer }>();
    const seen = new Set<string>();
    const walk = (abs: string, rel: string) => {
      let entries;
      try {
        entries = readdirSync(abs, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const a = join(abs, e.name);
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) walk(a, r);
          continue;
        }
        if (!e.isFile() || SKIP_NAMES.has(e.name) || SKIP_SUFFIX.some((s) => e.name.endsWith(s)) || e.name.includes('.durable-')) continue;
        if (!isSafeRel(r)) continue;
        seen.add(r);
        try {
          const f = this.readLocal(a, r);
          if (f) out.set(r, f);
        } catch (err) {
          this.log('warn', `could not read a file for saving (${(err as Error).message})`);
        }
      }
    };
    walk(this.dir, '');
    for (const k of [...this.known.keys()]) if (!seen.has(k)) this.known.delete(k);
    return out;
  }

  private readLocal(abs: string, rel: string) {
    const st = statSync(abs);
    const isDb = rel.endsWith('.sqlite');
    let sig = `${st.size}:${st.mtimeMs}`;
    if (isDb && existsSync(`${abs}-wal`)) {
      const w = statSync(`${abs}-wal`);
      sig += `|${w.size}:${w.mtimeMs}`;
    }
    const k = this.known.get(rel);
    let content: Buffer | null = null;
    const load = (): Buffer => {
      if (content) return content;
      if (isDb) content = snapshotSqlite(abs);
      else if (rel.endsWith('.env')) content = Buffer.from(readFileSync(abs, 'utf8').replace(STRIP_ENV_KEYS, '').replace(/\n{3,}/g, '\n\n'));
      else content = readFileSync(abs);
      return content;
    };
    if (k && k.sig === sig) return { size: k.size, h: k.h, content: load };
    const c = load();
    const h = this.mac(c);
    this.known.set(rel, { sig, h, size: c.length });
    return { size: c.length, h, content: load };
  }
}

/** A consistent copy of a live SQLite database (WAL mode safe). */
export function snapshotSqlite(abs: string): Buffer {
  const dir = join(tmpdir(), 'orin-durable');
  mkdirSync(dir, { recursive: true });
  const out = join(dir, `snap-${process.pid}-${randomUUID()}.sqlite`);
  const db = new DatabaseSync(abs, { readOnly: true });
  try {
    db.exec('PRAGMA busy_timeout = 5000');
    db.prepare('VACUUM INTO ?').run(out);
  } finally {
    db.close();
  }
  try {
    return readFileSync(out);
  } finally {
    rmSync(out, { force: true });
  }
}

function isSafeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  if (sep !== '/' && rel.includes(sep)) return false;
  return rel.split('/').every((p) => p && p !== '.' && p !== '..');
}
