import { z } from 'zod';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { defineTool, type AgentServices, type ToolContext } from './types.js';

export interface ImageOut {
  url: string;
  provider: string;
}

function saveMedia(svc: AgentServices, ctx: ToolContext, b64: string, mime: string): string {
  mkdirSync(svc.mediaDir, { recursive: true });
  const ext = mime.includes('jpeg') ? 'jpg' : mime.includes('webp') ? 'webp' : 'png';
  const file = `${randomUUID()}.${ext}`;
  writeFileSync(join(svc.mediaDir, file), Buffer.from(b64, 'base64'));
  return `${ctx.baseUrl}/v1/media/${file}`;
}

export function pollinationsImageUrl(base: string, prompt: string, w: number, h: number, seed: number): string {
  return `${base}/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&seed=${seed}&nologo=true&model=flux`;
}

async function viaPollinations(svc: AgentServices, ctx: ToolContext, prompt: string, w: number, h: number): Promise<ImageOut> {
  const seed = Math.floor(Math.random() * 1_000_000);
  const url = pollinationsImageUrl(svc.config.chat.pollinations.imageUrl, prompt, w, h, seed);
  // Generate it now (it is cached by URL), so the phone loads it instantly and we know it worked.
  const res = await svc.fetchImpl(url, { signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(90_000)]) });
  const ct = res.headers.get('content-type') ?? '';
  if (!res.ok || !ct.startsWith('image/')) throw new Error(`Pollinations returned HTTP ${res.status} (${ct || 'no content type'})`);
  await res.arrayBuffer();
  return { url, provider: 'Pollinations (free)' };
}

async function viaGemini(svc: AgentServices, ctx: ToolContext, prompt: string): Promise<ImageOut> {
  const res = await svc.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-image:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': svc.config.integrations.geminiKey },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { responseModalities: ['IMAGE'] } }),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(90_000)]),
  });
  if (!res.ok) throw new Error(`Gemini image HTTP ${res.status}`);
  const json = (await res.json()) as { candidates?: { content?: { parts?: { inlineData?: { mimeType: string; data: string } }[] } }[] };
  const part = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData);
  if (!part?.inlineData) throw new Error('Gemini returned no image');
  return { url: saveMedia(svc, ctx, part.inlineData.data, part.inlineData.mimeType), provider: 'Gemini' };
}

async function viaOpenAI(svc: AgentServices, ctx: ToolContext, prompt: string, w: number, h: number): Promise<ImageOut> {
  const size = w > h ? '1536x1024' : h > w ? '1024x1536' : '1024x1024';
  const res = await svc.fetchImpl('https://api.openai.com/v1/images/generations', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${svc.config.integrations.openaiKey}` },
    body: JSON.stringify({ model: 'gpt-image-1', prompt, size, n: 1 }),
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(120_000)]),
  });
  if (!res.ok) throw new Error(`OpenAI image HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { b64_json?: string; url?: string }[] };
  const d = json.data?.[0];
  if (d?.b64_json) return { url: saveMedia(svc, ctx, d.b64_json, 'image/png'), provider: 'OpenAI' };
  if (d?.url) return { url: d.url, provider: 'OpenAI' };
  throw new Error('OpenAI returned no image');
}

export async function generateImage(svc: AgentServices, ctx: ToolContext, prompt: string, w = 1024, h = 1024): Promise<ImageOut> {
  const p = svc.config.integrations.imageProvider;
  const errors: string[] = [];
  const order: ('openai' | 'gemini' | 'pollinations')[] =
    p === 'openai' ? ['openai', 'pollinations'] : p === 'gemini' ? ['gemini', 'pollinations'] : p === 'pollinations' ? ['pollinations'] : [];
  for (const which of order) {
    if (which === 'pollinations' && !svc.config.chat.pollinations.enabled) continue;
    try {
      if (which === 'openai') return await viaOpenAI(svc, ctx, prompt, w, h);
      if (which === 'gemini') return await viaGemini(svc, ctx, prompt);
      return await viaPollinations(svc, ctx, prompt, w, h);
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      errors.push(`${which}: ${(e as Error).message}`);
    }
  }
  throw new Error(errors.length ? `Image generation failed (${errors.join('; ')})` : 'No image provider is configured.');
}

export const generateImageTool = defineTool({
  name: 'generate_image',
  description: 'Create an image from a text description. The image is shown to the user automatically; do not paste the URL as a link, just describe what you made in one short sentence.',
  schema: z.object({
    prompt: z.string().min(3).max(1000).describe('Detailed visual description in English'),
    aspect: z.enum(['square', 'portrait', 'landscape']).optional(),
  }),
  label: () => 'Creating an image…',
  needs: ({ services }) => (services.config.integrations.imageProvider === 'none' ? 'POLLINATIONS_ENABLED=1 or GEMINI_API_KEY / OPENAI_API_KEY' : null),
  handler: async (a, ctx) => {
    const [w, h] = a.aspect === 'portrait' ? [768, 1024] : a.aspect === 'landscape' ? [1024, 768] : [1024, 1024];
    const img = await generateImage(ctx.services, ctx, a.prompt, w, h);
    return {
      content: `Image created with ${img.provider}. It is already displayed to the user. URL: ${img.url}`,
      summary: 'Image created',
      display: { kind: 'image', url: img.url, prompt: a.prompt, provider: img.provider },
    };
  },
});
