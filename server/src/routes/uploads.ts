import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Router, type Request } from "express";
import multer from "multer";
import type { Deps } from "../app.js";
import { AppError } from "../errors.js";
import { agentOwnerKey } from "../middleware/auth.js";
import {
  deleteUpload,
  getUpload,
  listUploads,
  MAX_UPLOAD_BYTES,
  saveUpload,
  uploadContext,
  UploadError,
  type UploadMeta,
} from "../agent/uploads.js";
import { extractPdfText } from "./files.js";

/**
 * Uploading files for the agent to work on: any file up to 50 MB (project ZIPs, hand-offs,
 * documents, code). The original is kept; the reply carries the text block the chat message
 * sends with it, so the agent sees what the file is and how to work on it.
 *
 *   POST   /v1/agent/uploads            multipart "file" (+ "conversationId")
 *   GET    /v1/agent/uploads            the user's uploads, newest first
 *   GET    /v1/agent/uploads/:id/file   the original bytes
 *   DELETE /v1/agent/uploads/:id
 */

const owner = (req: Request) => agentOwnerKey(req);

export function publicUpload(m: UploadMeta) {
  return {
    id: m.id,
    name: m.name,
    size: m.size,
    mimeType: m.mimeType,
    kind: m.kind,
    uploadedAt: m.uploadedAt,
    conversationId: m.conversationId ?? null,
    pages: m.pages ?? null,
    files: m.archive?.files ?? null,
    guide: m.archive?.guides[0] ?? null,
    stack: m.archive?.stack ?? [],
    problem: m.problem ?? null,
    notDurable: !!m.notDurable,
  };
}

export function uploadsRouter(deps: Deps): Router {
  const r = Router();
  const agent = deps.agent!;
  const dir = join(tmpdir(), "orin-uploads");
  mkdirSync(dir, { recursive: true });
  const upload = multer({
    dest: dir,
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 5 },
  });

  r.post("/agent/uploads", upload.single("file"), async (req, res, next) => {
    const file = req.file;
    try {
      if (!file || file.size === 0)
        throw new AppError("validation_error", "No file was received.");
      const conversationId =
        typeof req.body?.conversationId === "string"
          ? req.body.conversationId
          : undefined;
      const meta = await saveUpload(agent.services, owner(req), {
        name: Buffer.from(file.originalname || "file", "latin1").toString(
          "utf8",
        ),
        mimeType: file.mimetype,
        data: readFileSync(file.path),
        ...(conversationId ? { conversationId } : {}),
        pdfText: extractPdfText,
      });
      deps.usage.record(req.auth, {
        kind: "extract",
        provider: "local",
        model: `upload:${meta.kind}`,
        status: "ok",
        units: meta.size,
        durationMs: 0,
      });
      res.status(201).json({
        upload: publicUpload(meta),
        contextText: uploadContext(agent.services, owner(req), meta),
      });
    } catch (e) {
      if (e instanceof UploadError)
        next(
          new AppError(
            e.code === "too_large" ? "file_too_large" : "validation_error",
            e.message,
          ),
        );
      else next(e);
    } finally {
      if (file?.path) rmSync(file.path, { force: true });
    }
  });

  r.get("/agent/uploads", (req, res) => {
    res.json({
      uploads: listUploads(agent.services, owner(req)).map(publicUpload),
    });
  });

  r.get("/agent/uploads/:id/file", (req, res, next) => {
    try {
      const { meta, file } = getUpload(
        agent.services,
        owner(req),
        String(req.params.id),
      );
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename*=UTF-8''${encodeURIComponent(meta.name)}`,
      );
      res.sendFile(file);
    } catch {
      next(new AppError("not_found", "Upload not found."));
    }
  });

  r.delete("/agent/uploads/:id", (req, res) => {
    if (!deleteUpload(agent.services, owner(req), String(req.params.id)))
      throw new AppError("not_found", "Upload not found.");
    res.json({ ok: true });
  });

  return r;
}
