import type { AppConfig } from '../config.js';
import { AppError } from '../errors.js';
import type { ChatRequestBody } from '../schemas.js';
import { buildSystemPrompt } from './prompt.js';
import type { ImageInput, ProviderMessage } from './types.js';

const CONTEXT_CHAR_BUDGET = 60_000;
const MAX_IMAGE_TURNS = 2;

const SIGNATURES: Record<ImageInput['mimeType'], (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/gif': (b) => b.subarray(0, 4).toString('ascii') === 'GIF8',
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

/** Validates decoded size and magic bytes so a client cannot smuggle other file types as images. */
export function validateImage(img: ImageInput, maxBytes: number): ImageInput {
  const data = img.data.replace(/[\r\n]/g, '');
  const approxBytes = Math.floor((data.length * 3) / 4);
  if (approxBytes > maxBytes) {
    throw new AppError('file_too_large', `Images must be under ${Math.round(maxBytes / 1024 / 1024)} MB.`);
  }
  const head = Buffer.from(data.slice(0, 24), 'base64');
  if (!SIGNATURES[img.mimeType](head)) {
    throw new AppError('unsupported_file', 'The attached file is not a valid JPEG, PNG, WebP or GIF image.');
  }
  return { mimeType: img.mimeType, data };
}

function renderDocuments(docs: { name: string; text: string }[] | undefined): string {
  if (!docs?.length) return '';
  return docs
    .map((d) => `\n\n[Attached document: ${d.name}]\n<<<\n${d.text.slice(0, 60_000)}\n>>>`)
    .join('');
}

export interface BuiltContext {
  messages: ProviderMessage[];
  hasImages: boolean;
  trimmed: number;
}

export function buildContext(body: ChatRequestBody, config: AppConfig, opts: { allowImages: boolean; budget?: number }): BuiltContext {
  const msgs: ProviderMessage[] = body.messages.map((m) => ({
    role: m.role,
    content: m.content + renderDocuments(m.documents),
    images: m.images?.map((img) => validateImage(img, config.access.maxImageBytes)),
  }));

  // Only keep images on the most recent turns that have them (cost + payload control).
  let imageTurns = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.images?.length) {
      imageTurns++;
      if (imageTurns > MAX_IMAGE_TURNS) {
        m.content = `${m.content}\n[An image was attached earlier in the conversation.]`;
        delete m.images;
      }
    }
  }
  const hasImages = msgs.some((m) => m.images?.length);
  if (hasImages && !opts.allowImages) {
    throw new AppError(
      'vision_not_supported',
      config.chat.provider === 'pollinations'
        ? 'The free default model cannot read images. Add a free GEMINI_API_KEY on the server to let Orin see photos.'
        : 'The configured AI model cannot read images. Set AI_VISION_MODEL / AI_SUPPORTS_VISION on the server.',
    );
  }

  // Drop the oldest turns until we fit the budget, always keeping the latest user message.
  let trimmed = 0;
  const size = () => msgs.reduce((n, m) => n + m.content.length, 0);
  while (msgs.length > 1 && size() > (opts.budget ?? CONTEXT_CHAR_BUDGET)) {
    msgs.shift();
    trimmed++;
  }
  // Providers expect the first non-system message to be from the user.
  while (msgs.length > 1 && msgs[0]!.role !== 'user') {
    msgs.shift();
    trimmed++;
  }

  return {
    messages: [{ role: 'system', content: buildSystemPrompt(body.preferences, body.mode) }, ...msgs],
    hasImages,
    trimmed,
  };
}
