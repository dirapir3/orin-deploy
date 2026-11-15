import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { gunzipSync, gzipSync } from 'node:zlib';
import { bytes, getBytes, getInt, getStr, int, str, type FirestoreClient, type FsDoc, type FsUsage, type FsWrite } from './firestore.js';

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
 *
 * Two layouts. The first ('files', collections orin_files/orin_blobs) keeps one manifest document
 * and at least one chunk per file: every start-up paid two or more reads per file (about 5,000 for
 * 2,500 files), which used up Firestore's free 50,000 reads a day after a handful of restarts.
 * The second ('packs', orin_packs/orin_pack_blobs, chosen by orin_meta/format) groups small files
 * into 64 gzip'd packs by a keyed hash of their path; databases and files over 256 KB get a pack of
 * their own. A start-up then reads about one document per pack plus one per 600 KB of compressed
 * data. The first run that restores 'files' completely writes the packs, then the format marker,
 * and from then on writes packs only; the old 'files' copy stays behind untouched as a backup.
 * Writes: the lease is read only when something is about to be written, a pass runs every two
 * minutes, and a database or big file is saved at most every three minutes (shutdown saves all).
 */

export const FILES = 'orin_files';
export const BLOBS = 'orin_blobs';
export const META = 'orin_meta';
export const PACKS = 'orin_packs';
export const PACK_BLOBS = 'orin_pack_blobs';
/** orin_meta document whose f field names the layout in use. */
export const FORMAT_DOC = 'format';
export const PACK_FORMAT = 'packs-1';
const BUCKETS = 64;
const SOLO_MIN = 256_000;
/** Bump to run the one-time agent-DB repair again (see recoverOrphaned). */
export const RECOVERY_ID = 'agentdb-race-2026-11-15';

/** Row count, SQLite's own check, and the newest created_at/updated_at (ms) in a database file. */
function sqliteStats(src: string | Buffer): { ok: boolean; rows: number; latest: number } {
  // Checked on a private copy: a WAL-mode file cannot be opened read-only without its -shm, and the original stays untouched.
  const file = join(tmpdir(), `orin-durable-check-${process.pid}-${randomUUID()}.sqlite`);
  let db: DatabaseSync | null = null;
  try {
    writeFileSync(file, typeof src === 'string' ? readFileSync(src) : src);
    db = new DatabaseSync(file);
    const chk = db.prepare('PRAGMA quick_check').get() as Record<string, unknown> | undefined;
    if (!chk || Object.values(chk)[0] !== 'ok') return { ok: false, rows: 0, latest: 0 };
    let rows = 0;
    let latest = 0;
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
    for (const { name } of tables) {
      const q = `"${name.replace(/"/g, '""')}"`;
      rows += Number((db.prepare(`SELECT COUNT(*) AS c FROM ${q}`).get() as { c: number }).c);
      const cols = (db.prepare(`PRAGMA table_info(${q})`).all() as { name: string }[]).map((c) => c.name);
      for (const c of ['updated_at', 'created_at']) {
        if (!cols.includes(c)) continue;
        const m = Number((db.prepare(`SELECT MAX(${c}) AS m FROM ${q}`).get() as { m: number | null }).m ?? 0);
        if (m > latest) latest = m;
      }
    }
    return { ok: true, rows, latest };
  } catch {
    return { ok: false, rows: 0, latest: 0 };
  } finally {
    db?.close();
    for (const sfx of ['', '-wal', '-shm', '-journal']) rmSync(file + sfx, { force: true });
  }
}
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
  /** restore: tries per file when a chunk is missing or fails its check (default 4) */
  restoreRetries?: number;
  /** restore: base wait between those tries (default 2000 ms) */
  restoreRetryMs?: number;
  /** A database or big file (a pack of its own) is saved at most this often, except on flush (default 180000 ms). */
  soloGapMs?: number;
  /** Keep the old one-document-per-file layout (tests). */
  noMigrate?: boolean;
}

interface PackRemote {
  id: string;
  h: string;
  v: string;
  n: number;
  c: number;
  t: number;
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
  /** 'files' (one document per file) or 'packs' (grouped). */
  format: 'files' | 'packs';
  packs: number;
  /** Billed Firestore reads, writes and deletes since this server started. */
  usage: FsUsage;
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
  private mode: 'files' | 'packs' = 'files';
  private packs = new Map<string, PackRemote>();
  /** Packs that exist remotely but could not be restored: never rewritten or deleted this run. */
  private protectedPacks = new Set<string>();
  private packsListed = false;
  private soloSavedAt = new Map<string, number>();
  /** Some files of the start-up restore were lost to Firestore's daily quota (the rest came back). */
  private restoreHitQuota = false;
  private recoveryMarker: { id: string; rel: string; v: string; rows: number } | null = null;
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
    format: 'files',
    packs: 0,
    usage: { reads: 0, writes: 0, deletes: 0 },
  };

  constructor(private readonly o: DurableOptions) {
    if (!o.secret) throw new Error('Durable storage needs VAULT_KEY.');
    this.dir = resolve(o.dataDir);
    this.encKey = createHash('sha256').update(`orin-durable-enc:${o.secret}`).digest();
    this.macKey = createHash('sha256').update(`orin-durable-mac:${o.secret}`).digest();
  }

  status(): DurableStatus {
    const u = this.o.client.usage ?? { reads: 0, writes: 0, deletes: 0 };
    return { ...this.st, skipped: [...this.st.skipped], format: this.mode, packs: this.packs.size, usage: { ...u } };
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
        const fmt = await this.o.client.get(META, FORMAT_DOC);
        if (fmt && getStr(fmt, 'f') === PACK_FORMAT) {
          this.mode = 'packs';
          await this.restorePacks();
        } else {
          this.mode = 'files';
          await this.restoreOnce();
          // The 2026-11-15 repair is about the old layout only; in 'packs' the saved copy is newer than any leftover.
          await this.recoverOrphaned().catch((e) => this.log('warn', `repair check skipped: ${(e as Error).message}`));
        }
        this.st.restored = true;
        const u = this.o.client.usage;
        this.log(
          'info',
          `restored ${this.st.restoredFiles} file(s)${this.st.restoreFailures ? `, ${this.st.restoreFailures} failed` : ''} (${this.mode}, ${u?.reads ?? '?'} reads)`,
        );
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

  /** The start-up restore was lost to Firestore's daily quota (429): saving is off and the data folder is blank. */
  quotaBlocked(): boolean {
    // also when the restore finished but files were lost to the quota: those files stay blank (and unsaved) until a fresh restore
    return this.restoreHitQuota || (!this.st.restored && /\b429\b|RESOURCE_EXHAUSTED|quota/i.test(this.st.lastError ?? ''));
  }

  /** One cheap read: true when Firestore answers again (the quota reset). */
  async firestoreAnswers(): Promise<boolean> {
    try {
      await this.o.client.get(META, 'lease');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * One-time repair (RECOVERY_ID). On 2026-11-15 a restart restored the agent DB while the old instance was saving, failed
   * ("missing chunk 0"), started on a blank DB and saved that blank DB over the good one. The good version's chunks were left
   * behind: nothing deletes chunks that no manifest points at. This finds complete, decryptable leftover versions of the
   * agent DB, keeps those that pass SQLite's check and hold more rows than the current copy, and puts back the one with the
   * newest data. The marker in orin_meta is written only after a sync pass has saved it, so a crash before then retries.
   */
  private async recoverOrphaned(): Promise<void> {
    const rel = 'orin-agent.sqlite';
    const markerId = `recovered_${RECOVERY_ID}`;
    if (await this.o.client.get(META, markerId)) return;
    const id = this.fileId(rel);
    const cur = this.remote.get(rel);
    const versions = new Map<string, Set<number>>();
    // Only this file's chunks: '`' is the character after '_', so the range is every id starting with `${id}_`.
    for (const b of await this.o.client.listRange(BLOBS, `${id}_`, `${id}\``)) {
      const [bid, v, i] = b.id.split('_');
      if (bid !== id || !v || v === cur?.v || !/^\d+$/.test(i ?? '')) continue;
      if (!versions.has(v)) versions.set(v, new Set());
      versions.get(v)!.add(Number(i));
    }
    const abs = join(this.dir, rel);
    const local = existsSync(abs) ? sqliteStats(abs) : { ok: true, rows: 0, latest: 0 };
    let best: { v: string; content: Buffer; rows: number; latest: number } | null = null;
    for (const [v, idx] of versions) {
      if (!idx.has(0) || idx.size !== Math.max(...idx) + 1) continue; // a partial upload
      try {
        const parts: Buffer[] = [];
        for (let i = 0; i < idx.size; i++) {
          const b = await this.o.client.get(BLOBS, `${id}_${v}_${i}`);
          if (!b) throw new Error('chunk gone');
          parts.push(this.open(getBytes(b, 'd'), `${id}:${v}:${i}`));
        }
        const content = Buffer.concat(parts);
        const st = sqliteStats(content);
        this.log('info', `repair: leftover copy ${v}: ${st.ok ? `${st.rows} rows, newest ${new Date(st.latest).toISOString()}` : 'failed its check'}`);
        if (!st.ok || st.rows <= local.rows) continue;
        if (!best || st.latest > best.latest) best = { v, content, rows: st.rows, latest: st.latest };
      } catch (e) {
        this.log('warn', `repair: leftover copy ${v} unreadable (${(e as Error).message})`);
      }
    }
    if (!best) {
      await this.o.client.commit([{ op: 'set', collection: META, id: markerId, fields: { t: int(Date.now()), v: str('none'), rows: int(local.rows) } }]);
      this.log('info', `repair: nothing to recover (current copy has ${local.rows} rows)`);
      return;
    }
    for (const sfx of ['-wal', '-shm']) rmSync(abs + sfx, { force: true });
    const tmp = `${abs}.durable-${process.pid}.tmp`;
    writeFileSync(tmp, best.content, { mode: 0o644 });
    renameSync(tmp, abs);
    this.protectedPaths.delete(rel);
    this.recoveryMarker = { id: markerId, rel, v: best.v, rows: best.rows };
    this.log('warn', `repair: put back agent DB copy ${best.v} (${best.rows} rows vs ${local.rows} in the current copy)`);
  }

  private async restoreOnce() {
    this.remote.clear();
    this.protectedPaths.clear();
    this.st.restoredFiles = 0;
    this.st.restoreFailures = 0;
    const docs = await this.o.client.list(FILES);
    mkdirSync(this.dir, { recursive: true });
    for (const first of docs) {
      let d: FsDoc = first;
      let rel = '';
      // During a deploy or restart the old instance can still be saving: it may flip a file to a new version and delete
      // the old chunks while we read them ("missing chunk"). Re-read that file's manifest and try again before giving up.
      const tries = this.o.restoreRetries ?? 4;
      for (let attempt = 0; ; attempt++) {
        try {
          rel = this.open(getBytes(d, 'p'), `path:${d.id}`).toString('utf8');
          this.restoreDoc(d, rel, await this.chunksOf(d));
          break;
        } catch (e) {
          const raced = /^(missing chunk|content check failed)/.test((e as Error).message);
          if (raced && attempt + 1 < tries) {
            await new Promise((r) => setTimeout(r, (this.o.restoreRetryMs ?? 2000) * (attempt + 1)));
            const again: FsDoc | null = await this.o.client.get(FILES, first.id).catch(() => d);
            if (!again) break; // deleted meanwhile: nothing to restore
            d = again;
            continue;
          }
          this.st.restoreFailures++;
          if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test((e as Error).message)) this.restoreHitQuota = true;
          if (rel) this.protectedPaths.add(rel);
          // Keep the entry known so it is never treated as "deleted locally".
          if (rel) this.remote.set(rel, { id: d.id, h: getStr(d, 'h'), v: getStr(d, 'v'), n: getInt(d, 'n') });
          this.log('warn', `could not restore one file (${(e as Error).message})`);
          break;
        }
      }
    }
  }

  private async chunksOf(d: FsDoc): Promise<Buffer[]> {
    const id = d.id;
    const v = getStr(d, 'v');
    const n = getInt(d, 'n');
    const parts: Buffer[] = [];
    for (let i = 0; i < n; i++) {
      const b = await this.o.client.get(BLOBS, `${id}_${v}_${i}`);
      if (!b) throw new Error(`missing chunk ${i}`);
      parts.push(this.open(getBytes(b, 'd'), `${id}:${v}:${i}`));
    }
    return parts;
  }

  private restoreDoc(d: FsDoc, rel: string, parts: Buffer[]) {
    if (!isSafeRel(rel) || this.fileId(rel) !== d.id) throw new Error('bad path entry');
    const r: Remote = { id: d.id, h: getStr(d, 'h'), v: getStr(d, 'v'), n: getInt(d, 'n') };
    const content = Buffer.concat(parts);
    if (this.mac(content) !== r.h) throw new Error('content check failed');
    this.writeRestored(rel, content);
    this.remote.set(rel, r);
    this.st.restoredFiles++;
  }

  private writeRestored(rel: string, content: Buffer) {
    const abs = join(this.dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    // A stale -wal/-shm next to a restored database would corrupt it.
    if (rel.endsWith('.sqlite')) for (const s of ['-wal', '-shm']) rmSync(abs + s, { force: true });
    const tmp = `${abs}.durable-${process.pid}.tmp`;
    writeFileSync(tmp, content, { mode: rel.endsWith('.env') ? 0o600 : 0o644 });
    renameSync(tmp, abs);
  }

  // ---------- packs ----------
  /** Which pack a file belongs to: databases and big files get their own, the rest share 64 by a keyed hash of the path. */
  private packIdFor(rel: string, size: number): string {
    return rel.endsWith('.sqlite') || size >= SOLO_MIN ? this.soloId(rel) : this.bucketId(rel);
  }
  private soloId(rel: string): string {
    return `s${this.fileId(rel)}`;
  }
  private bucketId(rel: string): string {
    return `b${String(parseInt(this.mac(`bucket:${rel}`).slice(0, 6), 16) % BUCKETS).padStart(2, '0')}`;
  }

  private packDigest(members: { rel: string; h: string }[]): string {
    const rows = members.map((m) => `${m.rel}\0${m.h}`).sort();
    return this.mac(`pack\n${rows.join('\n')}`);
  }

  private async restorePacks() {
    this.remote.clear();
    this.packs.clear();
    this.protectedPacks.clear();
    this.protectedPaths.clear();
    this.st.restoredFiles = 0;
    this.st.restoreFailures = 0;
    // Small pages: a pack document can hold up to ~700 KB inline.
    // Oldest first: if a file ever sits in two packs (a move between them cut short), the newer copy wins.
    const docs = (await this.o.client.list(PACKS, undefined, 8)).sort((x, y) => getInt(x, 't') - getInt(y, 't'));
    mkdirSync(this.dir, { recursive: true });
    for (const first of docs) {
      let d: FsDoc = first;
      const tries = this.o.restoreRetries ?? 4;
      for (let attempt = 0; ; attempt++) {
        try {
          const files = await this.readPack(d);
          for (const f of files) this.writeRestored(f.rel, f.content);
          this.packs.set(d.id, packRemote(d));
          this.st.restoredFiles += files.length;
          break;
        } catch (e) {
          const raced = /^(missing chunk|content check failed)/.test((e as Error).message);
          if (raced && attempt + 1 < tries) {
            await new Promise((r) => setTimeout(r, (this.o.restoreRetryMs ?? 2000) * (attempt + 1)));
            const again: FsDoc | null = await this.o.client.get(PACKS, first.id).catch(() => d);
            if (!again) break;
            d = again;
            continue;
          }
          this.st.restoreFailures += Math.max(1, getInt(d, 'c'));
          if (/\b429\b|RESOURCE_EXHAUSTED|quota/i.test((e as Error).message)) this.restoreHitQuota = true;
          // Never rewritten or deleted this run, so its saved files survive.
          this.protectedPacks.add(d.id);
          this.packs.set(d.id, packRemote(d));
          this.log('warn', `could not restore one pack (${(e as Error).message})`);
          break;
        }
      }
    }
    this.packsListed = true;
  }

  /** Reads, decrypts and checks one pack; writes nothing. */
  private async readPack(d: FsDoc): Promise<{ rel: string; content: Buffer }[]> {
    const { id, v, n, h } = packRemote(d);
    let sealed: Buffer;
    if (n === 0) sealed = this.open(getBytes(d, 'd'), `pack:${id}:${v}`);
    else {
      const parts: Buffer[] = [];
      for (let i = 0; i < n; i++) {
        const b = await this.o.client.get(PACK_BLOBS, `${id}_${v}_${i}`);
        if (!b) throw new Error(`missing chunk ${i}`);
        parts.push(this.open(getBytes(b, 'd'), `${id}:${v}:${i}`));
      }
      sealed = Buffer.concat(parts);
    }
    const files = decodePack(gunzipSync(sealed));
    for (const f of files) if (!isSafeRel(f.rel)) throw new Error('bad path entry');
    if (this.packDigest(files.map((f) => ({ rel: f.rel, h: this.mac(f.content) }))) !== h) throw new Error('content check failed');
    return files;
  }

  /** Saves one pack from the files' current contents (hashed as uploaded, so the saved digest always matches). */
  private async uploadPack(id: string, members: { rel: string; content: () => Buffer }[]) {
    const entries = members.map((m) => ({ rel: m.rel, content: m.content() })).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const h = this.packDigest(entries.map((e) => ({ rel: e.rel, h: this.mac(e.content) })));
    const v = h.slice(0, 16);
    const old = this.packs.get(id);
    if (old && old.h === h) return;
    const gz = encodePack(entries);
    const meta = { h: str(h), v: str(v), c: int(entries.length), s: int(gz.length), t: int(Date.now()) };
    let n = 0;
    if (gz.length <= INLINE_MAX) {
      await this.o.client.commit([{ op: 'set', collection: PACKS, id, fields: { ...meta, n: int(0), d: bytes(this.seal(gz, `pack:${id}:${v}`)) } }]);
    } else {
      n = Math.ceil(gz.length / CHUNK);
      let batch: FsWrite[] = [];
      let size = 0;
      for (let i = 0; i < n; i++) {
        const box = this.seal(gz.subarray(i * CHUNK, (i + 1) * CHUNK), `${id}:${v}:${i}`);
        const b64 = Math.ceil(box.length / 3) * 4;
        if (batch.length && size + b64 > COMMIT_BUDGET) {
          await this.o.client.commit(batch);
          batch = [];
          size = 0;
        }
        batch.push({ op: 'set', collection: PACK_BLOBS, id: `${id}_${v}_${i}`, fields: { d: bytes(box) } });
        size += b64;
      }
      // The pack flips to the new version in the same commit as the last chunks.
      batch.push({ op: 'set', collection: PACKS, id, fields: { ...meta, n: int(n) } });
      await this.o.client.commit(batch);
    }
    this.packs.set(id, { id, h, v, n, c: entries.length, t: Date.now() });
    if (old && old.n > 0 && old.v !== v) await this.deletePackChunks(old);
  }

  private async removePack(id: string) {
    const old = this.packs.get(id);
    await this.o.client.commit([{ op: 'delete', collection: PACKS, id }]);
    this.packs.delete(id);
    if (old && old.n > 0) await this.deletePackChunks(old);
  }

  private async deletePackChunks(r: PackRemote) {
    const writes: FsWrite[] = [];
    for (let i = 0; i < r.n; i++) writes.push({ op: 'delete', collection: PACK_BLOBS, id: `${r.id}_${r.v}_${i}` });
    for (let i = 0; i < writes.length; i += 400) await this.o.client.commit(writes.slice(i, i + 400)).catch(() => undefined);
  }

  /** Lease check, read only when about to write. False when a newer instance took over. */
  private async holdLease(): Promise<boolean> {
    const lease = await this.o.client.get(META, 'lease');
    if (lease && getStr(lease, 'i') && getStr(lease, 'i') !== this.instance) {
      this.st.superseded = true;
      this.stop();
      this.log('warn', 'a newer server instance took over saving; this one stops writing');
      return false;
    }
    return true;
  }

  /** The files this pass may save, with the size limits applied. */
  private eligible(local: Map<string, { size: number; h: string; content: () => Buffer }>, skipped: string[]) {
    const out: [string, { size: number; h: string; content: () => Buffer }][] = [];
    let total = 0;
    for (const [rel, f] of local) {
      total += f.size;
      if (f.size > (this.o.maxFileBytes ?? 20_000_000) || total > (this.o.maxTotalBytes ?? 400_000_000)) {
        skipped.push(rel);
        continue;
      }
      out.push([rel, f]);
    }
    return out;
  }

  private groupPacks(files: [string, { size: number; h: string; content: () => Buffer }][]) {
    const groups = new Map<string, { rel: string; h: string; content: () => Buffer }[]>();
    for (const [rel, f] of files) {
      const id = this.packIdFor(rel, f.size);
      // A file that may sit in a pack whose saved copy could not be read is left alone, wherever its size would put it now.
      if (this.protectedPacks.size && (this.protectedPacks.has(this.soloId(rel)) || this.protectedPacks.has(this.bucketId(rel)))) continue;
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push({ rel, h: f.h, content: f.content });
    }
    return groups;
  }

  /** One save pass in the packed layout: only changed packs are written, and nothing at all is read when nothing changed. */
  private async packPass(force: boolean) {
    const skipped: string[] = [];
    const groups = this.groupPacks(this.eligible(this.scan(), skipped));
    const now = Date.now();
    const gap = this.o.soloGapMs ?? 180_000;
    const dirty: string[] = [];
    for (const [id, ms] of groups) {
      const r = this.packs.get(id);
      if (r && r.h === this.packDigest(ms)) continue;
      if (!force && r && id.startsWith('s') && now - (this.soloSavedAt.get(id) ?? 0) < gap) continue;
      dirty.push(id);
    }
    const gone = [...this.packs.keys()].filter((id) => !groups.has(id) && !this.protectedPacks.has(id));
    if (dirty.length || gone.length) {
      if (!(await this.holdLease())) return;
      for (const id of dirty) {
        await this.uploadPack(id, groups.get(id)!);
        if (id.startsWith('s')) this.soloSavedAt.set(id, Date.now());
      }
      for (const id of gone) await this.removePack(id);
    }
    this.st.skipped = skipped;
    this.st.savedFiles = [...groups.values()].reduce((a, g) => a + g.length, 0);
  }

  /** Moves a complete 'files' copy into packs, then switches the layout. The old copy stays as a backup. */
  private async migrate(): Promise<boolean> {
    if (!(await this.holdLease())) return false;
    const skipped: string[] = [];
    const groups = this.groupPacks(this.eligible(this.scan(), skipped));
    // Leftovers of an earlier, unfinished move: dropped so they are not restored later.
    const stray = (await this.o.client.list(PACKS, ['t'])).map((d) => d.id).filter((id) => !groups.has(id));
    this.packs.clear();
    for (const [id, ms] of groups) await this.uploadPack(id, ms);
    for (let i = 0; i < stray.length; i += 400) await this.o.client.commit(stray.slice(i, i + 400).map((id) => ({ op: 'delete' as const, collection: PACKS, id })));
    await this.o.client.commit([{ op: 'set', collection: META, id: FORMAT_DOC, fields: { f: str(PACK_FORMAT), t: int(Date.now()) } }]);
    this.mode = 'packs';
    this.packsListed = true;
    const now = Date.now();
    for (const id of groups.keys()) if (id.startsWith('s')) this.soloSavedAt.set(id, now);
    this.st.skipped = skipped;
    this.st.savedFiles = [...groups.values()].reduce((a, g) => a + g.length, 0);
    this.log('info', `moved ${this.st.savedFiles} file(s) into ${groups.size} pack(s); the old copy stays as a backup`);
    return true;
  }

  private canMigrate(): boolean {
    return (
      !this.o.noMigrate &&
      this.mode === 'files' &&
      this.st.restoreFailures === 0 &&
      !this.restoreHitQuota &&
      this.protectedPaths.size === 0 &&
      !this.recoveryMarker
    );
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
    if (this.running) return force ? this.running.then(() => this.syncPass(true)) : this.running;
    this.running = this.syncPass(force).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async syncPass(force = false): Promise<void> {
    try {
      if (this.mode === 'packs') {
        await this.packPass(force);
        if (!this.st.superseded) {
          this.st.lastSyncAt = Date.now();
          this.st.lastError = null;
        }
        return;
      }
      if (this.canMigrate()) {
        try {
          if (await this.migrate()) {
            this.st.lastSyncAt = Date.now();
            this.st.lastError = null;
          }
          return;
        } catch (e) {
          this.log('warn', `move to packs failed, saving the old way this time: ${(e as Error).message}`);
        }
      }
      if (!(await this.holdLease())) return;
      const local = this.scan();
      const skipped: string[] = [];
      for (const [rel, f] of this.eligible(local, skipped)) {
        // A file whose restore failed keeps its saved copy: never save this run's (likely blank) file over it.
        if (this.protectedPaths.has(rel)) continue;
        const r = this.remote.get(rel);
        if (r && r.h === f.h) continue;
        await this.upload(rel, f.content(), f.h);
      }
      for (const [rel, r] of [...this.remote]) {
        if (local.has(rel) || this.protectedPaths.has(rel)) continue;
        await this.remove(rel, r);
      }
      if (this.recoveryMarker && !this.protectedPaths.has(this.recoveryMarker.rel)) {
        const m = this.recoveryMarker;
        await this.o.client.commit([{ op: 'set', collection: META, id: m.id, fields: { t: int(Date.now()), v: str(m.v), rows: int(m.rows) } }]);
        this.recoveryMarker = null;
        this.log('info', 'repair saved: the recovered copy is the saved copy now');
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

const INLINE_MAX = 700_000;

function packRemote(d: FsDoc): PackRemote {
  return { id: d.id, h: getStr(d, 'h'), v: getStr(d, 'v'), n: getInt(d, 'n'), c: getInt(d, 'c'), t: getInt(d, 't') };
}

/** [u32 path length][u32 data length][path][data]... then gzip. */
export function encodePack(entries: { rel: string; content: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const e of entries) {
    const p = Buffer.from(e.rel, 'utf8');
    const hdr = Buffer.alloc(8);
    hdr.writeUInt32BE(p.length, 0);
    hdr.writeUInt32BE(e.content.length, 4);
    parts.push(hdr, p, e.content);
  }
  return gzipSync(Buffer.concat(parts), { level: 6 });
}

export function decodePack(raw: Buffer): { rel: string; content: Buffer }[] {
  const out: { rel: string; content: Buffer }[] = [];
  let o = 0;
  while (o < raw.length) {
    if (o + 8 > raw.length) throw new Error('content check failed: truncated pack');
    const pl = raw.readUInt32BE(o);
    const dl = raw.readUInt32BE(o + 4);
    o += 8;
    if (o + pl + dl > raw.length) throw new Error('content check failed: truncated pack');
    const rel = raw.subarray(o, o + pl).toString('utf8');
    o += pl;
    out.push({ rel, content: Buffer.from(raw.subarray(o, o + dl)) });
    o += dl;
  }
  return out;
}

function isSafeRel(rel: string): boolean {
  if (!rel || rel.startsWith('/') || rel.includes('\\') || rel.includes('\0')) return false;
  if (sep !== '/' && rel.includes(sep)) return false;
  return rel.split('/').every((p) => p && p !== '.' && p !== '..');
}
