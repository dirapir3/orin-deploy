import { extractOfficeText, officeKind } from '../lib/officeText.js';
import { Router } from 'express';
import multer from 'multer';
import type { Deps } from '../app.js';
import { AppError } from '../errors.js';

export const MAX_EXTRACTED_CHARS = 100_000;

const TEXT_TYPES = new Set(['text/plain', 'text/markdown', 'text/csv', 'application/json', 'text/x-markdown']);

export async function extractPdfText(buf: Buffer): Promise<{ text: string; pages: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf');
  const pdf = await getDocumentProxy(new Uint8Array(buf));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { text: String(text ?? ''), pages: totalPages };
}

export function decodeText(buf: Buffer): string {
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  // Reject binary content posing as text.
  const sample = text.slice(0, 4000);
  // eslint-disable-next-line no-control-regex -- intentionally detecting control characters
  const controls = sample.match(/[\u0000-\u0008\u000E-\u001F]/g)?.length ?? 0;
  if (sample.length > 0 && controls / sample.length > 0.02) {
    throw new AppError('unsupported_file', 'This file does not look like plain text.');
  }
  return text;
}

export function filesRouter(deps: Deps) {
  const r = Router();
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: deps.config.access.maxUploadBytes, files: 1 } });

  r.post('/extract', upload.single('file'), async (req, res, next) => {
    const started = Date.now();
    try {
      const file = req.file;
      if (!file || file.size === 0) throw new AppError('validation_error', 'No file was received.');
      const name = (file.originalname || 'document').slice(0, 200);
      const mime = (file.mimetype || '').toLowerCase();
      const isPdf = mime === 'application/pdf' || name.toLowerCase().endsWith('.pdf');
      let text: string;
      let pages: number | undefined;
      if (isPdf) {
        if (file.buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
          throw new AppError('unsupported_file', 'This file is not a valid PDF.');
        }
        try {
          const out = await extractPdfText(file.buffer);
          text = out.text;
          pages = out.pages;
        } catch {
          throw new AppError('extraction_failed', 'Could not read text from this PDF. It may be encrypted or damaged.');
        }
      } else if (officeKind(name, mime)) {
        try {
          const out = extractOfficeText(file.buffer, officeKind(name, mime)!);
          text = out.text;
          pages = out.pages;
        } catch {
          throw new AppError('extraction_failed', 'Could not read this document. It may be damaged or password protected.');
        }
      } else if (TEXT_TYPES.has(mime) || /\.(txt|md|markdown|csv|json)$/i.test(name)) {
        text = decodeText(file.buffer);
      } else {
        throw new AppError('unsupported_file', 'Supported: PDF, Word (DOCX), PowerPoint (PPTX), Excel (XLSX), OpenDocument and plain text (TXT, MD, CSV, JSON).');
      }
      // eslint-disable-next-line no-control-regex -- strip NUL bytes from extracted text
      text = text.replace(/\u0000/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      if (!text) {
        throw new AppError('extraction_failed', isPdf ? 'No selectable text found in this PDF (scanned PDFs need OCR, which is not supported).' : 'The file is empty.');
      }
      const truncated = text.length > MAX_EXTRACTED_CHARS;
      deps.usage.record(req.auth, { kind: 'extract', provider: 'local', model: isPdf ? 'unpdf' : officeKind(name, mime) ?? 'text', status: 'ok', units: file.size, durationMs: Date.now() - started });
      res.json({
        name,
        mimeType: isPdf ? 'application/pdf' : officeKind(name, mime) ? mime || 'application/octet-stream' : 'text/plain',
        pages,
        chars: Math.min(text.length, MAX_EXTRACTED_CHARS),
        truncated,
        text: truncated ? text.slice(0, MAX_EXTRACTED_CHARS) : text,
      });
    } catch (err) {
      next(err);
    }
  });

  return r;
}
