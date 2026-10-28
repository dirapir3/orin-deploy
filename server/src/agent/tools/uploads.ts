import { readFileSync } from "node:fs";
import { z } from "zod";
import { openArchive, readEntry } from "../../lib/archive.js";
import { SANDBOX_WORKDIR, sandboxPath, shq } from "../sandbox/index.js";
import {
  asText,
  fmtBytes,
  getUpload,
  listUploads,
  looksSecret,
  MAX_ENTRY_READ,
  outline,
  UNTRUSTED_NOTE,
  uploadContext,
  uploadText,
  type UploadMeta,
} from "../uploads.js";
import {
  MAX_FILE_BYTES,
  workspaceDir,
  writeBigFile,
  writeWsFile,
} from "../workspace.js";
import { log, sandboxNeeds, short, withSandbox } from "./sandbox.js";
import { defineTool } from "./types.js";

/**
 * Working on what the user uploads: list it, read inside it (archives file by file, documents by
 * offset), unpack it safely on the computer to edit/run/test it, and send the finished project
 * back as a ZIP without secrets or heavy folders.
 */

const when = (t: number) =>
  new Date(t).toISOString().replace("T", " ").slice(0, 16) + " UTC";

function describe(m: UploadMeta): string {
  const a = m.archive;
  const what = a
    ? `${a.format.toUpperCase()}, ${a.files} files${a.guides[0] ? `, guide ${a.guides[0]}` : ""}`
    : m.kind;
  return `${m.id}  ${m.name}  (${fmtBytes(m.size)}, ${what}, uploaded ${when(m.uploadedAt)})${m.problem ? ` - ${m.problem}` : ""}`;
}

export const listUploadsTool = defineTool({
  name: "list_uploads",
  description:
    "List the files the user uploaded in chats (newest first): project ZIPs, hand-offs, documents, code, images. Each has an upload id for read_upload and upload_to_computer. " +
    'Use it when the user refers to "the file I sent", "the zip", "the hand-off" and it is not in the current message.',
  schema: z.object({}),
  label: () => "Checking your uploads…",
  handler: async (_a, ctx) => {
    const all = listUploads(ctx.services, ctx.owner);
    if (!all.length)
      return {
        content:
          "The user has no uploads on the server (none sent yet, or they were lost in a server restart).",
        summary: "No uploads",
      };
    return {
      content: all.slice(0, 40).map(describe).join("\n"),
      summary: `${all.length} upload${all.length === 1 ? "" : "s"}`,
    };
  },
});

export const readUploadTool = defineTool({
  name: "read_upload",
  description:
    "Read an uploaded file without changing it. For a ZIP/TAR: no path = summary and outline (hand-off files, stack, secrets held back); a folder path = that folder's contents; a file path = that file's text (up to 2 MB per file, use offset for long ones). " +
    "For a document or text file: its text, from offset. Read the hand-off / START-HERE / README first, then the files it points to. " +
    "Secret-looking files (.env, keys, keystores) are never shown in full: you get their variable names only. " +
    UNTRUSTED_NOTE,
  schema: z.object({
    id: z
      .string()
      .min(1)
      .max(40)
      .describe("upload id, e.g. up_0123456789abcdef"),
    path: z
      .string()
      .max(400)
      .optional()
      .describe("archives: a folder or file inside it"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("character offset to start reading from"),
    max_chars: z
      .number()
      .int()
      .min(500)
      .max(40_000)
      .optional()
      .describe("how much to read (default 20000)"),
  }),
  label: (a) =>
    a.path
      ? `Reading ${short(a.path.split("/").pop() ?? a.path, 30)}…`
      : "Reading the upload…",
  handler: async (a, ctx) => {
    const { meta, file, dir } = getUpload(ctx.services, ctx.owner, a.id);
    const off = a.offset ?? 0;
    const n = a.max_chars ?? 20_000;
    const page = (text: string, what: string) => {
      const part = text.slice(off, off + n);
      const more =
        off + part.length < text.length
          ? `\n\n[${text.length - off - part.length} more characters: read_upload with offset ${off + part.length}]`
          : "";
      return {
        content: `${what} (${text.length} characters${off ? `, from ${off}` : ""}):\n<<<\n${part}\n>>>${more}`,
        summary: `Read ${short(what, 40)}`,
      };
    };
    if (meta.kind !== "archive") {
      if (a.path)
        return {
          ok: false,
          content: `${meta.name} is not an archive; read it without a path.`,
          summary: "Not an archive",
        };
      const text = uploadText(dir);
      if (text === null)
        return {
          ok: false,
          content: `${meta.name} has no readable text here (${meta.kind}${meta.problem ? `: ${meta.problem}` : ""}). Use upload_to_computer to work on it with tools.`,
          summary: "No text",
        };
      return page(text, meta.name);
    }
    let arch;
    try {
      arch = openArchive(meta.name, readFileSync(file));
    } catch (e) {
      return {
        ok: false,
        content: `${meta.name} can't be opened on the server: ${(e as Error).message} Use upload_to_computer to unpack it there.`,
        summary: "Archive not readable",
      };
    }
    const want = (a.path ?? "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (!want)
      return {
        content: uploadContext(ctx.services, ctx.owner, meta, {
          guideChars: 0,
        }).replace(/^Uploaded file/, "Upload"),
        summary: `Outline of ${short(meta.name, 30)}`,
      };
    const entry = arch.entries.find(
      (e) => e.path === want && e.kind === "file",
    );
    if (!entry) {
      const lines = outline(arch.entries, want, 200);
      if (lines.length)
        return {
          content: `${want}/ contains:\n${lines.join("\n")}`,
          summary: `Listed ${short(want, 30)}`,
        };
      const near = arch.entries
        .filter((e) =>
          e.path.toLowerCase().includes(want.split("/").pop()!.toLowerCase()),
        )
        .slice(0, 10)
        .map((e) => e.path);
      return {
        ok: false,
        content: `Nothing at ${want} in ${meta.name}.${near.length ? ` Close matches: ${near.join(", ")}` : ""}`,
        summary: "Not found",
      };
    }
    if (looksSecret(entry.path)) {
      let names = "";
      try {
        const t = asText(readEntry(arch, entry, 200_000)) ?? "";
        names = [
          ...t.matchAll(
            /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*[=:]/gm,
          ),
        ]
          .map((m) => m[1])
          .slice(0, 60)
          .join(", ");
      } catch {
        // binary key file
      }
      return {
        content: `${entry.path} looks like a secret file, so its values are not shown.${names ? ` It sets: ${names}.` : " It is a binary key/certificate."} If the work needs these values, ask the user to put them in the Secure Vault and use them from there.`,
        summary: "Secret file held back",
      };
    }
    let buf: Buffer;
    try {
      buf = readEntry(arch, entry, MAX_ENTRY_READ);
    } catch (e) {
      return {
        ok: false,
        content: (e as Error).message,
        summary: "Could not read",
      };
    }
    const text = asText(buf);
    if (text === null)
      return {
        content: `${entry.path} is a binary file (${fmtBytes(entry.size)}). Use upload_to_computer to work with it.`,
        summary: "Binary file",
      };
    return page(text, entry.path);
  },
});

/** Python run on the computer: unpacks with the same rules as the server-side reader. */
const UNPACK_PY = String.raw`
import json, os, stat, sys, tarfile, zipfile, re
src, dest, include_secrets = sys.argv[1], sys.argv[2], sys.argv[3] == '1'
SECRET = re.compile(r'^(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks|mobileprovision|ovpn)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\..+)?\.json|.*service[-_]?account.*\.json|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.orin-master-key|secrets?\.(json|ya?ml|toml))$', re.I)
NOT_SECRET = re.compile(r'^\.env\.(example|sample|template|dist|defaults)$|\.pub$', re.I)
MAX_TOTAL, MAX_ENTRIES = 1_000_000_000, 20000
def clean(p):
    p = p.replace('\\', '/')
    if re.match(r'^[a-zA-Z]:', p) or p.startswith('/'): return None, 'absolute path'
    parts = [s for s in p.split('/') if s not in ('', '.')]
    if '..' in parts: return None, 'points outside the folder (..)'
    if any(ord(c) < 32 for c in p): return None, 'control characters in the name'
    return '/'.join(parts), None
items = []
if zipfile.is_zipfile(src):
    z = zipfile.ZipFile(src)
    for i in z.infolist():
        mode = i.external_attr >> 16
        kind = 'dir' if i.is_dir() else ('link' if stat.S_ISLNK(mode) else 'file')
        items.append((i.filename, kind, i.file_size, (lambda i=i: z.open(i)), bool(i.flag_bits & 1)))
else:
    t = tarfile.open(src)
    for m in t.getmembers():
        kind = 'dir' if m.isdir() else ('file' if m.isfile() else 'link')
        items.append((m.name, kind, m.size, (lambda m=m: t.extractfile(m)), False))
paths = [clean(n)[0] for n, k, *_ in items if clean(n)[0]]
tops = {p.split('/')[0] for p in paths}
root = list(tops)[0] if len(tops) == 1 and any('/' in p for p in paths) else None
os.makedirs(dest, exist_ok=True)
real_dest = os.path.realpath(dest)
skipped, secrets, written, total = [], [], 0, 0
for n, kind, size, opener, enc in items[:MAX_ENTRIES]:
    p, why = clean(n)
    if why: skipped.append([n, why]); continue
    if not p: continue
    rel = p[len(root) + 1:] if root and p.startswith(root + '/') else ('' if root and p == root else p)
    if not rel: continue
    if kind == 'link': skipped.append([p, 'link']); continue
    target = os.path.realpath(os.path.join(dest, rel))
    if not (target == real_dest or target.startswith(real_dest + os.sep)): skipped.append([p, 'points outside the folder']); continue
    if kind == 'dir': os.makedirs(target, exist_ok=True); continue
    base = rel.split('/')[-1]
    if SECRET.match(base) and not NOT_SECRET.search(base) and not include_secrets: secrets.append(rel); continue
    if enc: skipped.append([p, 'password protected']); continue
    if total + size > MAX_TOTAL: skipped.append([p, 'over the 1 GB unpack limit']); continue
    os.makedirs(os.path.dirname(target), exist_ok=True)
    got = 0
    with opener() as f, open(target, 'wb') as out:
        while True:
            chunk = f.read(1 << 20)
            if not chunk: break
            got += len(chunk)
            if total + got > MAX_TOTAL: break
            out.write(chunk)
    if total + got > MAX_TOTAL:
        os.remove(target); skipped.append([p, 'bigger than it says (zip bomb?)']); break
    total += got; written += 1
open(os.path.join(dest, '.orin-upload-id'), 'w').write(sys.argv[4])
print(json.dumps({'files': written, 'bytes': total, 'root': root, 'skipped': skipped[:40], 'secrets': secrets[:40], 'more_entries': max(0, len(items) - MAX_ENTRIES)}))
`;

const slugOf = (name: string) =>
  name
    .replace(/\.(zip|tar|tgz|tar\.gz)$/i, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|-+$/g, "")
    .slice(0, 60) || "upload";

export const uploadToComputerTool = defineTool({
  name: "upload_to_computer",
  description:
    `Put an uploaded file on your sandbox computer so you can edit, run, build and test it. A ZIP/TAR is unpacked safely into its own folder under ${SANDBOX_WORKDIR} (a single top folder is dropped; links, paths that escape the folder, and zip bombs are refused; secret-looking files like .env and keystores are held back unless include_secrets). ` +
    "Any other file is copied to work/uploads/. The uploaded original on the server is never changed, and calling this again for the same upload reuses the folder (your edits are kept); a different upload with the same name gets a new folder. " +
    "After unpacking: read the hand-off/README, install dependencies (heavy folders like node_modules were not in the upload or should be reinstalled), make the changes, run the tests, update the hand-off with what you changed and what is next, then send the result with deliver_project.",
  schema: z.object({
    id: z.string().min(1).max(40).describe("upload id"),
    to: z
      .string()
      .max(200)
      .optional()
      .describe(
        `folder to unpack into (default: ${SANDBOX_WORKDIR}/<name of the archive>)`,
      ),
    include_secrets: z
      .boolean()
      .optional()
      .describe(
        "also unpack .env and key files (asks the user first); only when running the project really needs them",
      ),
  }),
  label: () => "Putting the upload on the computer…",
  needs: ({ services }) => sandboxNeeds(services),
  writes: true,
  timeoutMs: 300_000,
  approval: (a, ctx) => {
    if (!a.include_secrets) return null;
    let name = a.id;
    let secrets: string[] = [];
    try {
      const { meta } = getUpload(ctx.services, ctx.owner, a.id);
      name = meta.name;
      secrets = meta.archive?.secrets ?? [];
    } catch {
      // the handler reports a missing upload
    }
    if (!secrets.length) return null;
    return {
      title: "Unpack secret files",
      headline: name,
      body: "Orin wants to unpack the secret-looking files from this upload onto her computer so the project can run. She won't show their values or send them back.",
      fields: [
        {
          label: "Files",
          value:
            secrets.slice(0, 10).join(", ") +
            (secrets.length > 10 ? ` and ${secrets.length - 10} more` : ""),
        },
      ],
    };
  },
  handler: async (a, ctx) => {
    const { meta, file } = getUpload(ctx.services, ctx.owner, a.id);
    const data = readFileSync(file);
    const isArchive = meta.kind === "archive";
    const out = await withSandbox(ctx, async (s) => {
      const stash = `/home/user/.orin/uploads/${meta.id}/${meta.name}`;
      const have = await s.exec(
        `[ -f ${shq(stash)} ] && sha256sum ${shq(stash)} | cut -d' ' -f1 || true`,
        { cwd: "/", timeoutMs: 30_000 },
      );
      if (have.stdout.trim() !== meta.sha256) {
        await s.exec(`mkdir -p ${shq(`/home/user/.orin/uploads/${meta.id}`)}`, {
          cwd: "/",
          timeoutMs: 15_000,
        });
        await s.writeFile(stash, new Uint8Array(data));
      }
      if (!isArchive) {
        let dest = a.to
          ? sandboxPath(a.to)
          : `${SANDBOX_WORKDIR}/uploads/${meta.name}`;
        const chk = await s.exec(
          `if [ -e ${shq(dest)} ]; then sha256sum ${shq(dest)} 2>/dev/null | cut -d' ' -f1 || echo dir; fi`,
          { cwd: "/", timeoutMs: 15_000 },
        );
        const existing = chk.stdout.trim();
        if (existing && existing !== meta.sha256 && !a.to)
          dest = `${SANDBOX_WORKDIR}/uploads/${meta.id.slice(3, 9)}-${meta.name}`;
        const r = await s.exec(
          `mkdir -p "$(dirname ${shq(dest)})" && cp ${shq(stash)} ${shq(dest)}`,
          { cwd: "/", timeoutMs: 60_000 },
        );
        if (r.exitCode !== 0)
          throw new Error(`Copying failed: ${r.stderr.slice(0, 300)}`);
        return { dest, reused: existing === meta.sha256 };
      }
      // archives: never unpack over a folder that came from another upload; reuse our own folder
      const base = a.to
        ? sandboxPath(a.to)
        : `${SANDBOX_WORKDIR}/${slugOf(meta.archive?.root ?? meta.name)}`;
      let dest = base;
      for (let i = 2; i < 20; i++) {
        const r = await s.exec(
          `if [ -f ${shq(`${dest}/.orin-upload-id`)} ]; then cat ${shq(`${dest}/.orin-upload-id`)}; elif [ -e ${shq(dest)} ] && [ -n "$(ls -A ${shq(dest)} 2>/dev/null)" ]; then echo busy; fi`,
          { cwd: "/", timeoutMs: 15_000 },
        );
        const mark = r.stdout.trim();
        if (mark === meta.id) {
          const ls = await s.exec(`ls -A ${shq(dest)} | head -60`, {
            cwd: "/",
            timeoutMs: 15_000,
          });
          return { dest, reused: true, listing: ls.stdout.trim() };
        }
        if (!mark) break;
        if (a.to)
          throw new Error(
            `${dest} already holds other files; choose an empty folder.`,
          );
        dest = `${base}-${i}`;
      }
      await s.writeFile("/home/user/.orin/unpack.py", UNPACK_PY);
      const r = await s.exec(
        `python3 /home/user/.orin/unpack.py ${shq(stash)} ${shq(dest)} ${a.include_secrets ? 1 : 0} ${meta.id}`,
        { cwd: "/", timeoutMs: 240_000 },
      );
      if (r.exitCode !== 0)
        throw new Error(
          `Unpacking failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`,
        );
      const rep = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
        files: number;
        bytes: number;
        skipped: [string, string][];
        secrets: string[];
        more_entries: number;
      };
      const ls = await s.exec(
        `ls -A ${shq(dest)} | grep -v '^.orin-upload-id$' | head -60`,
        { cwd: "/", timeoutMs: 15_000 },
      );
      return { dest, reused: false, listing: ls.stdout.trim(), rep };
    });
    log(
      ctx,
      "file",
      out.reused
        ? `Reused ${out.dest}`
        : `Unpacked ${meta.name} to ${out.dest}`,
    );
    const lines: string[] = [];
    if (!isArchive) {
      lines.push(
        `${meta.name} is on your computer at ${out.dest}${out.reused ? " (it was already there, unchanged)" : ""}.`,
      );
    } else if (out.reused) {
      lines.push(
        `${meta.name} was already unpacked at ${out.dest}; it may hold your earlier edits, so keep working there. (Pass a new "to" folder for a fresh copy.)`,
        `Top level:\n${out.listing}`,
      );
    } else {
      const rep = "rep" in out ? out.rep! : null;
      lines.push(
        `Unpacked ${meta.name} into ${out.dest}: ${rep?.files ?? 0} files, ${fmtBytes(rep?.bytes ?? 0)}.`,
        `Top level:\n${out.listing}`,
      );
      if (rep?.secrets.length)
        lines.push(
          `Held back (secret-looking): ${rep.secrets.join(", ")}. If the project needs them to run, call again with include_secrets (the user is asked), or have the user put the values in the Secure Vault.`,
        );
      if (rep?.skipped.length)
        lines.push(
          `Not unpacked: ${rep.skipped.map(([p, w]) => `${p} (${w})`).join("; ")}`,
        );
      if (rep?.more_entries)
        lines.push(
          `${rep.more_entries} more entries were over the 20,000 entry limit and not unpacked.`,
        );
    }
    const guides = meta.archive?.guides ?? [];
    if (guides.length && !out.reused) {
      const root = meta.archive?.root;
      lines.push(
        `Read first: ${guides
          .slice(0, 4)
          .map(
            (g) =>
              `${out.dest}/${root && g.startsWith(`${root}/`) ? g.slice(root.length + 1) : g}`,
          )
          .join(", ")}`,
      );
    }
    if (isArchive)
      lines.push(
        "When the work is done and tested, update the hand-off (what changed, what was tested, what is next) and send it back with deliver_project.",
      );
    return {
      content: lines.join("\n\n"),
      summary: out.reused
        ? "Upload already on the computer"
        : isArchive
          ? "Unpacked the upload"
          : "Copied the upload",
    };
  },
});

const PACK_PY = String.raw`
import json, os, re, sys, zipfile
src, out = sys.argv[1], sys.argv[2]
HEAVY = {'node_modules', '.git', '.gradle', '.expo', '__pycache__', '.venv', 'venv', '.next', 'Pods', '.cache', '.turbo', '.orin'}
BUILD = {'build', 'dist', '.output'}
keep_build = sys.argv[3] == '1'
SECRET = re.compile(r'^(\.env(\..+)?|.*\.(pem|key|p12|pfx|keystore|jks|mobileprovision|ovpn)|id_(rsa|dsa|ecdsa|ed25519)(\.pub)?|credentials(\..+)?\.json|.*service[-_]?account.*\.json|\.npmrc|\.netrc|\.pgpass|\.git-credentials|\.orin-master-key|\.orin-upload-id|secrets?\.(json|ya?ml|toml))$', re.I)
NOT_SECRET = re.compile(r'^\.env\.(example|sample|template|dist|defaults)$|\.pub$', re.I)
root_name = os.path.basename(os.path.normpath(src))
files, total, secrets, skipped = 0, 0, [], set()
with zipfile.ZipFile(out, 'w', zipfile.ZIP_DEFLATED, compresslevel=6) as z:
    for d, dirs, names in os.walk(src):
        for x in list(dirs):
            if x in HEAVY or (x in BUILD and not keep_build) or os.path.islink(os.path.join(d, x)):
                skipped.add(x); dirs.remove(x)
        for n in names:
            p = os.path.join(d, n)
            rel = os.path.relpath(p, src)
            if os.path.islink(p) or os.path.abspath(p) == os.path.abspath(out): continue
            if SECRET.match(n) and not NOT_SECRET.search(n):
                if n != '.orin-upload-id': secrets.append(rel)
                continue
            size = os.path.getsize(p)
            if size > 50_000_000: skipped.add(rel + ' (over 50 MB)'); continue
            z.write(p, root_name + '/' + rel); files += 1; total += size
print(json.dumps({'files': files, 'bytes': total, 'secrets': secrets[:40], 'skipped': sorted(skipped)[:40], 'zip': os.path.getsize(out)}))
`;

/** A ZIP sent to the user can be at most this big (same as a single sandbox_save). */
const DELIVER_MAX = 60_000_000;

export const deliverProjectTool = defineTool({
  name: "deliver_project",
  description:
    "Send a finished project folder from your computer back to the user as a ZIP they can download from the chat (a file card appears). It leaves out secrets (.env, keys, keystores), node_modules, .git and caches (and build/dist unless include_build), so it is safe to hand to another agent or to upload again. " +
    "Before calling it: the changes are made and tested, and the hand-off/README in the folder says what changed, what was tested and what is next. One call per finished piece of work; the chat shows only the download, so put the summary in your reply.",
  schema: z.object({
    folder: z
      .string()
      .min(1)
      .max(300)
      .describe(
        `project folder on the computer; relative paths are inside ${SANDBOX_WORKDIR}`,
      ),
    name: z
      .string()
      .max(80)
      .optional()
      .describe(
        'ZIP file name, e.g. "orin-project-v2.zip" (default: folder name + date)',
      ),
    include_build: z
      .boolean()
      .optional()
      .describe("keep build/dist folders (e.g. a built web app)"),
  }),
  label: () => "Packing the project…",
  needs: ({ services }) => sandboxNeeds(services),
  writes: true,
  timeoutMs: 300_000,
  handler: async (a, ctx) => {
    const folder = sandboxPath(a.folder);
    const stamp = new Date().toISOString().slice(0, 10);
    let name = (
      a.name ??
      `${folder.split("/").filter(Boolean).pop() ?? "project"}-${stamp}.zip`
    )
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^[-.]+/, "");
    if (!name.toLowerCase().endsWith(".zip")) name += ".zip";
    const out = await withSandbox(ctx, async (s) => {
      const kind = await s.exec(
        `[ -d ${shq(folder)} ] && echo dir || echo none`,
        { cwd: "/", timeoutMs: 15_000 },
      );
      if (kind.stdout.trim() !== "dir")
        throw new Error(`No folder at ${folder} on the computer.`);
      const zipPath = `/home/user/.orin/out/${name}`;
      await s.writeFile("/home/user/.orin/pack.py", PACK_PY);
      const r = await s.exec(
        `mkdir -p /home/user/.orin/out && rm -f ${shq(zipPath)} && python3 /home/user/.orin/pack.py ${shq(folder)} ${shq(zipPath)} ${a.include_build ? 1 : 0}`,
        { cwd: "/", timeoutMs: 240_000 },
      );
      if (r.exitCode !== 0)
        throw new Error(
          `Packing failed: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 400)}`,
        );
      const rep = JSON.parse(r.stdout.trim().split("\n").pop() ?? "{}") as {
        files: number;
        bytes: number;
        secrets: string[];
        skipped: string[];
        zip: number;
      };
      if (!rep.files)
        throw new Error(
          `${folder} has no files to send (after leaving out secrets and heavy folders).`,
        );
      if (rep.zip > DELIVER_MAX) return { rep, tooBig: true as const };
      const data = Buffer.from(await s.readFile(zipPath));
      const root = workspaceDir(ctx.services, ctx.owner);
      const f =
        data.byteLength > MAX_FILE_BYTES
          ? writeBigFile(root, name, data)
          : writeWsFile(root, `deliveries/${name}`, data);
      return { rep, path: f.path, size: data.byteLength };
    });
    if ("tooBig" in out) {
      return {
        ok: false,
        content: `The ZIP came to ${fmtBytes(out.rep.zip)}, over the ${DELIVER_MAX / 1_000_000} MB limit for a download. Leave out large assets (or split the project) and try again.`,
        summary: "Project too big to send",
      };
    }
    log(ctx, "save", `Packed ${out.rep.files} files into ${name}`);
    const lines = [
      `Sent ${name} to the user (${fmtBytes(out.size)}, ${out.rep.files} files). It is in their files at ${out.path}.`,
    ];
    if (out.rep.secrets.length)
      lines.push(
        `Left out (secret-looking): ${out.rep.secrets.join(", ")}. Tell the user these must be added back by hand.`,
      );
    if (out.rep.skipped.length)
      lines.push(
        `Left out (heavy/rebuildable): ${out.rep.skipped.join(", ")}.`,
      );
    if (out.size > 20_000_000)
      lines.push(
        "It is over 20 MB, so the server keeps it only until it restarts: tell the user to download it now.",
      );
    return {
      content: lines.join("\n"),
      summary: `Sent ${short(name, 40)}`,
      display: { kind: "file", path: out.path, size: out.size },
    };
  },
});

export const uploadTools = [
  listUploadsTool,
  readUploadTool,
  uploadToComputerTool,
  deliverProjectTool,
];
