import type { Preferences } from '../schemas.js';

const STYLE: Record<NonNullable<Preferences['style']>, string> = {
  friendly: 'Be warm, encouraging and approachable.',
  formal: 'Use a formal, precise and respectful register.',
  casual: 'Keep a relaxed, conversational tone, like talking to a friend.',
  professional: 'Be concise, clear and businesslike.',
};

const LENGTH: Record<NonNullable<Preferences['responseLength']>, string> = {
  short: 'Keep answers brief: a few sentences unless the user asks for more.',
  balanced: 'Give complete but focused answers; avoid padding.',
  detailed: 'Give thorough, well-structured answers with examples where helpful.',
};

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  bn: 'Bengali (বাংলা)',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  hi: 'Hindi',
  ar: 'Arabic',
  ja: 'Japanese',
};

export function buildSystemPrompt(prefs: Preferences | undefined, mode: 'chat' | 'voice', now = new Date()): string {
  const p = prefs ?? {};
  const lines = [
    'You are Orin, a thoughtful, friendly AI assistant inside a mobile app.',
    'Be honest about uncertainty. Never claim to have done something you did not do, and never invent sources.',
    `Today's date is ${now.toISOString().slice(0, 10)}.`,
    STYLE[p.style ?? 'friendly'],
    LENGTH[p.responseLength ?? 'balanced'],
  ];
  if (mode === 'voice') {
    lines.push(
      'This is a spoken conversation: answer in natural spoken sentences, no Markdown, no lists, no code blocks, no emojis. Keep turns short (usually under 60 words) unless asked for detail.',
    );
  } else {
    lines.push('Format with Markdown when it helps readability. Use fenced code blocks with a language tag for code.');
  }
  if (p.language && p.language !== 'auto') {
    lines.push(`Always reply in ${LANGUAGE_NAMES[p.language] ?? p.language}, unless the user explicitly asks for another language.`);
  } else {
    lines.push("Reply in the language the user writes in.");
  }
  if (p.preferredName) lines.push(`The user would like to be called "${p.preferredName}".`);
  if (p.customInstructions) {
    lines.push(
      'The user provided these custom instructions. Follow them unless they conflict with honesty or safety:',
      `"""\n${p.customInstructions}\n"""`,
    );
  }
  return lines.join('\n');
}

export function voiceInstructions(prefs: Preferences | undefined): string {
  const style = prefs?.style ?? 'friendly';
  return `Speak in a ${style}, natural and calm way.`;
}

/** Local fallback title: first meaningful words of the first user message. */
export function fallbackTitle(text: string, max = 48): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#*_>`~[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) return 'New conversation';
  const firstSentence = clean.split(/(?<=[.!?।])\s/)[0] ?? clean;
  const chars = Array.from(firstSentence);
  if (chars.length <= max) return firstSentence;
  const cut = chars.slice(0, max).join('');
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.5 ? cut.slice(0, lastSpace) : cut).trim()}…`;
}

export function cleanTitle(raw: string): string {
  return raw
    .replace(/^["'“”‘’\s]+|["'“”‘’.\s]+$/g, '')
    .replace(/^title:\s*/i, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
}
