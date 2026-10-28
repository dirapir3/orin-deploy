import { gunzipSync, inflateRawSync } from "node:zlib";

/**
 * Reading the archives users upload (ZIP, TAR, TAR.GZ) without extracting them on the server:
 * list the entries with their real sizes, flag unsafe ones, and read one file at a time with a
 * size cap. Dependency-free. ZIP64 is supported; encrypted entries and other compression methods
 * are listed but not read (the agent's computer can still open them with unzip/7z).
 */

export const MAX_ARCHIVE_ENTRIES = 20_000;
/** Declared total size above which an archive is treated as a zip bomb and not opened. */
export const MAX_ARCHIVE_TOTAL = 1_000_000_000;
/** A .tar.gz bigger than this once unpacked is listed only on the agent's computer. */
export const MAX_TAR_UNPACKED = 200_000_000;

export type ArchiveFormat = "zip" | "tar" | "tgz";

export interface ArchiveEntry {
  /** cleaned relative path (forward slashes) */
  path: string;
  size: number;
  kind: "file" | "dir" | "link";
  /** why this entry is not safe to extract as is (absolute path, .., link, encrypted...) */
  unsafe?: string;
  /** zip: reading needs these */
  method?: number;
  compSize?: number;
  localOffset?: number;
  encrypted?: boolean;
  /** tar: where the data starts in the unpacked tar */
  dataOffset?: number;
}

export interface Archive {
  format: ArchiveFormat;
  entries: ArchiveEntry[];
  /** problems with the archive as a whole (too many entries, looks like a bomb...) */
  warnings: string[];
  /** the bytes entries are read from (the zip itself, or the unpacked tar) */
  data: Buffer;
}

export function archiveFormat(
  name: string,
  head: Buffer,
): ArchiveFormat | null {
  const n = name.toLowerCase();
  if (head.length >= 4 && head.readUInt32LE(0) === 0x04034b50) return "zip";
  if (head.length >= 4 && head.readUInt32LE(0) === 0x06054b50) return "zip"; // empty zip
  if (
    head.length >= 2 &&
    head[0] === 0x1f &&
    head[1] === 0x8b &&
    /\.(tgz|tar\.gz)$/.test(n)
  )
    return "tgz";
  if (
    head.length >= 262 &&
    head.subarray(257, 262).toString("latin1") === "ustar"
  )
    return "tar";
  if (n.endsWith(".tar") && head.length >= 512) return "tar";
  return null;
}

/** Cleans an entry name; returns the reason when it would land outside the target folder. */
export function cleanEntryPath(raw: string): { path: string; unsafe?: string } {
  let p = raw.replace(/\\/g, "/");
  // eslint-disable-next-line no-control-regex -- detecting control characters in names
  if (/[\u0000-\u001f]/.test(p))
    return {
      path: p.replace(/[\u0000-\u001f]/g, "?"),
      unsafe: "control characters in the name",
    };
  if (/^[a-zA-Z]:/.test(p))
    return { path: p.slice(2).replace(/^\/+/, ""), unsafe: "absolute path" };
  if (p.startsWith("/"))
    return { path: p.replace(/^\/+/, ""), unsafe: "absolute path" };
  p = p.replace(/^\.\//, "");
  const parts = p.split("/").filter((s) => s !== "" && s !== ".");
  if (parts.some((s) => s === ".."))
    return {
      path: parts.filter((s) => s !== "..").join("/"),
      unsafe: "points outside the folder (..)",
    };
  return { path: parts.join("/") };
}

export function openArchive(name: string, buf: Buffer): Archive {
  const fmt = archiveFormat(name, buf.subarray(0, 512));
  if (fmt === "zip") return listZip(buf);
  if (fmt === "tgz") {
    let tar: Buffer;
    try {
      tar = gunzipSync(buf, { maxOutputLength: MAX_TAR_UNPACKED });
    } catch (e) {
      if (
        String((e as Error)?.message).includes("larger than") ||
        (e as { code?: string })?.code === "ERR_BUFFER_TOO_LARGE"
      ) {
        throw new Error(
          `This archive is over ${MAX_TAR_UNPACKED / 1_000_000} MB unpacked; open it on the computer instead.`,
          { cause: e },
        );
      }
      throw new Error("This .tar.gz is damaged.", { cause: e });
    }
    return { ...listTar(tar), format: "tgz" };
  }
  if (fmt === "tar") return listTar(buf);
  throw new Error("Not a ZIP or TAR archive.");
}

function findEocd(buf: Buffer): number {
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

export function listZip(buf: Buffer): Archive {
  const eocd = findEocd(buf);
  if (eocd < 0)
    throw new Error("This ZIP file is damaged (no central directory).");
  let count = buf.readUInt16LE(eocd + 10);
  let cd = buf.readUInt32LE(eocd + 16);
  // ZIP64 end of central directory
  if (
    (count === 0xffff || cd === 0xffffffff) &&
    eocd >= 20 &&
    buf.readUInt32LE(eocd - 20) === 0x07064b50
  ) {
    const z64 = Number(buf.readBigUInt64LE(eocd - 20 + 8));
    if (z64 + 56 <= buf.length && buf.readUInt32LE(z64) === 0x06064b50) {
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cd = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const warnings: string[] = [];
  if (count > MAX_ARCHIVE_ENTRIES) {
    warnings.push(
      `It has ${count} entries; only the first ${MAX_ARCHIVE_ENTRIES} are listed.`,
    );
    count = MAX_ARCHIVE_ENTRIES;
  }
  const entries: ArchiveEntry[] = [];
  let p = cd;
  let total = 0;
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const madeBy = buf.readUInt16LE(p + 4) >> 8;
    const ext = buf.readUInt32LE(p + 38);
    let local = buf.readUInt32LE(p + 42);
    const rawName = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    // ZIP64 extra field: the 0xFFFFFFFF values follow in order
    let x = p + 46 + nameLen;
    const xEnd = x + extraLen;
    while (x + 4 <= xEnd) {
      const id = buf.readUInt16LE(x);
      const len = buf.readUInt16LE(x + 2);
      if (id === 0x0001) {
        let q = x + 4;
        if (size === 0xffffffff && q + 8 <= x + 4 + len) {
          size = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (compSize === 0xffffffff && q + 8 <= x + 4 + len) {
          compSize = Number(buf.readBigUInt64LE(q));
          q += 8;
        }
        if (local === 0xffffffff && q + 8 <= x + 4 + len)
          local = Number(buf.readBigUInt64LE(q));
      }
      x += 4 + len;
    }
    p += 46 + nameLen + extraLen + commentLen;
    const isDir = rawName.endsWith("/") || rawName.endsWith("\\");
    const isLink = madeBy === 3 && ((ext >>> 16) & 0o170000) === 0o120000;
    const c = cleanEntryPath(rawName);
    if (!c.path) continue;
    const e: ArchiveEntry = {
      path: c.path,
      size,
      kind: isDir ? "dir" : isLink ? "link" : "file",
      method,
      compSize,
      localOffset: local,
      encrypted: (flags & 1) === 1,
    };
    if (c.unsafe) e.unsafe = c.unsafe;
    else if (isLink) e.unsafe = "symbolic link";
    else if (e.encrypted) e.unsafe = "password protected";
    total += isDir ? 0 : size;
    entries.push(e);
  }
  if (total > MAX_ARCHIVE_TOTAL)
    warnings.push(
      `It unpacks to ${Math.round(total / 1_000_000)} MB, over the ${MAX_ARCHIVE_TOTAL / 1_000_000} MB limit (possible zip bomb).`,
    );
  const comp = entries.reduce((n, e) => n + (e.compSize ?? 0), 0);
  if (total > 50_000_000 && comp > 0 && total / comp > 200)
    warnings.push(
      "It is compressed suspiciously well (possible zip bomb); extract it with care.",
    );
  return { format: "zip", entries, warnings, data: buf };
}

function octal(buf: Buffer, start: number, len: number): number {
  // GNU base-256 for big sizes
  if ((buf[start]! & 0x80) !== 0) {
    let v = 0;
    for (let i = start + 1; i < start + len; i++) v = v * 256 + buf[i]!;
    return v;
  }
  const s = buf
    .subarray(start, start + len)
    .toString("latin1")
    .replace(/\0.*$/s, "")
    .trim();
  return s ? parseInt(s, 8) || 0 : 0;
}

export function listTar(buf: Buffer): Archive {
  const entries: ArchiveEntry[] = [];
  const warnings: string[] = [];
  let p = 0;
  let longName: string | null = null;
  let paxPath: string | null = null;
  let total = 0;
  while (p + 512 <= buf.length) {
    const h = buf.subarray(p, p + 512);
    if (h.every((b) => b === 0)) break;
    let name = h.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
    const size = octal(h, 124, 12);
    const type = String.fromCharCode(h[156] || 48);
    if (h.subarray(257, 262).toString("latin1") === "ustar") {
      const prefix = h
        .subarray(345, 500)
        .toString("utf8")
        .replace(/\0.*$/s, "");
      if (prefix) name = `${prefix}/${name}`;
    }
    const dataOffset = p + 512;
    p = dataOffset + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = buf
        .subarray(dataOffset, dataOffset + size)
        .toString("utf8")
        .replace(/\0.*$/s, "");
      continue;
    }
    if (type === "x") {
      const pax = buf.subarray(dataOffset, dataOffset + size).toString("utf8");
      const m = pax.match(/\d+ path=([^\n]*)\n/);
      paxPath = m ? m[1]! : null;
      continue;
    }
    if (type === "g") continue;
    const raw = paxPath ?? longName ?? name;
    paxPath = null;
    longName = null;
    const c = cleanEntryPath(raw);
    if (!c.path) continue;
    const kind: ArchiveEntry["kind"] =
      type === "5" ? "dir" : type === "2" || type === "1" ? "link" : "file";
    const e: ArchiveEntry = {
      path: c.path,
      size: kind === "file" ? size : 0,
      kind,
      dataOffset,
    };
    if (c.unsafe) e.unsafe = c.unsafe;
    else if (kind === "link")
      e.unsafe = type === "1" ? "hard link" : "symbolic link";
    else if (kind === "file" && !["0", "\0", "7"].includes(type))
      e.unsafe = "special file";
    total += e.size;
    entries.push(e);
    if (entries.length >= MAX_ARCHIVE_ENTRIES) {
      warnings.push(
        `It has more than ${MAX_ARCHIVE_ENTRIES} entries; only the first ${MAX_ARCHIVE_ENTRIES} are listed.`,
      );
      break;
    }
  }
  if (total > MAX_ARCHIVE_TOTAL)
    warnings.push(
      `It unpacks to ${Math.round(total / 1_000_000)} MB, over the ${MAX_ARCHIVE_TOTAL / 1_000_000} MB limit.`,
    );
  return { format: "tar", entries, warnings, data: buf };
}

/** Reads one file of the archive, refusing anything bigger than maxBytes unpacked. */
export function readEntry(
  a: Archive,
  e: ArchiveEntry,
  maxBytes: number,
): Buffer {
  if (e.kind !== "file") throw new Error(`${e.path} is not a file.`);
  if (e.unsafe) throw new Error(`${e.path} can't be read here: ${e.unsafe}.`);
  if (e.size > maxBytes)
    throw new Error(
      `${e.path} is ${Math.round(e.size / 1000)} KB, too big to read here; put the upload on your computer and read it there.`,
    );
  if (a.format !== "zip")
    return Buffer.from(a.data.subarray(e.dataOffset!, e.dataOffset! + e.size));
  const buf = a.data;
  const local = e.localOffset!;
  if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50)
    throw new Error(`${e.path} is damaged in the ZIP.`);
  const start =
    local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
  const data = buf.subarray(start, start + (e.compSize ?? 0));
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) {
    try {
      return inflateRawSync(data, { maxOutputLength: Math.max(1, maxBytes) });
    } catch {
      throw new Error(
        `${e.path} could not be unpacked (damaged, or bigger than it says).`,
      );
    }
  }
  throw new Error(
    `${e.path} uses a compression this reader doesn't support; open it on the computer.`,
  );
}
