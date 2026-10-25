import { z } from 'zod';

export const MAX_MESSAGE_CHARS = 32_000;
export const MAX_MESSAGES = 200;
export const MAX_IMAGES_PER_MESSAGE = 4;

export const PreferencesSchema = z
  .object({
    preferredName: z.string().trim().max(60).optional(),
    style: z.enum(['friendly', 'formal', 'casual', 'professional']).optional(),
    responseLength: z.enum(['short', 'balanced', 'detailed']).optional(),
    language: z.string().trim().max(10).regex(/^[a-zA-Z-]+$/).optional(),
    customInstructions: z.string().trim().max(2000).optional(),
  })
  .strict();

export type Preferences = z.infer<typeof PreferencesSchema>;

const ImageSchema = z.object({
  mimeType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']),
  data: z
    .string()
    .min(16)
    .regex(/^[A-Za-z0-9+/=\r\n]+$/, 'Image data must be base64'),
});

const DocumentSchema = z.object({
  name: z.string().trim().min(1).max(200),
  text: z.string().max(120_000),
});

export const ChatMessageSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.string().max(MAX_MESSAGE_CHARS),
  images: z.array(ImageSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
  documents: z.array(DocumentSchema).max(3).optional(),
});

export const ChatRequestSchema = z
  .object({
    conversationId: z.string().uuid().optional(),
    messages: z.array(ChatMessageSchema).min(1).max(MAX_MESSAGES),
    preferences: PreferencesSchema.optional(),
    mode: z.enum(['chat', 'voice']).default('chat'),
    /** user's IANA timezone, for reminders, schedules and dates */
    timezone: z.string().trim().max(60).optional(),
    /** incognito chat: nothing is saved (no memory, no summaries) */
    incognito: z.boolean().optional(),
    /** which character/persona answers (orin, nova, sage, max) */
    character: z.string().trim().max(30).optional(),
    /** set false to get a plain reply without tools */
    agent: z.boolean().optional(),
  })
  .superRefine((val, ctx) => {
    const last = val.messages[val.messages.length - 1];
    if (!last || last.role !== 'user') {
      ctx.addIssue({ code: 'custom', path: ['messages'], message: 'The last message must be from the user.' });
      return;
    }
    if (!last.content.trim() && !last.images?.length && !last.documents?.length) {
      ctx.addIssue({ code: 'custom', path: ['messages'], message: 'Message cannot be empty.' });
    }
  });

export type ChatRequestBody = z.infer<typeof ChatRequestSchema>;

export const TitleRequestSchema = z.object({
  messages: z
    .array(z.object({ role: z.enum(['user', 'assistant']), content: z.string().max(8000) }))
    .min(1)
    .max(4),
  language: z.string().max(10).optional(),
});

export const SpeechRequestSchema = z.object({
  text: z.string().trim().min(1, 'Text is required').max(4096),
  voice: z.string().trim().min(1).max(40).optional(),
  /** Speak in this character's own voice (orin, nova, sage, max) unless `voice` is set. */
  character: z.string().trim().min(1).max(20).optional(),
  preferences: PreferencesSchema.optional(),
});

export const GuestIdSchema = z.string().uuid();
