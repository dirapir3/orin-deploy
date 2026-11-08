/**
 * Keeps secrets out of long-term memory and conversation summaries.
 *
 * Passwords, API keys, tokens, sign-in codes and card numbers belong in the Secure Vault (agent/vault.ts),
 * never in memories the model reads back on every message, in summaries or in logs. `secretProblem`
 * says why a text may not be remembered; `redactSecrets` blanks them out of free text (summaries).
 */

const KEY_PATTERNS: RegExp[] = [
  /\b(?:sk|pk|rk)-(?:proj-|live-|test-|ant-)?[A-Za-z0-9_-]{16,}/g, // OpenAI, Anthropic, Stripe style keys
  /\bAIza[0-9A-Za-z_-]{30,}/g, // Google API keys
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g, // Hugging Face
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:sbx|e2b|dtn|rnd|gsk|xai|pplx|nvapi|or)[-_][A-Za-z0-9_-]{20,}/g, // sandbox / provider tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, // JWTs
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
];

/** "password is hunter2", "api key: abc...", "my PIN = 1234", "the code is 482913" */
const LABELLED =
  /\b(?:password|passcode|passwd|pwd|pin(?: code)?|otp|one[- ]time code|2fa code|verification code|security code|sign[- ]?in code|login code|cvv|cvc|api[ _-]?key|secret(?: key)?|access token|auth(?:orization)? token|bearer token|token|private key|seed phrase|recovery phrase)\s*(?:is|was|=|:|-)\s*["'`]?([^\s"'`,;]{3,})/gi;

/** Long random-looking strings (mixed letters and digits, 32+), but not plain UUIDs or hex commit hashes of ≤40. */
const RANDOM = /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z0-9_-]*\d)(?=[A-Za-z0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX_HASH = /^[0-9a-f]{32,40}$/i;

/** 13-19 digit numbers that pass the Luhn check (payment cards). */
const CARDISH = /\b(?:\d[ -]?){12,18}\d\b/g;
function luhn(digits: string): boolean {
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (alt) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function findings(text: string): { kind: string; match: string }[] {
  const out: { kind: string; match: string }[] = [];
  for (const re of KEY_PATTERNS) for (const m of text.matchAll(re)) out.push({ kind: 'key', match: m[0] });
  for (const m of text.matchAll(LABELLED)) {
    const value = m[1] ?? '';
    // "my password is in the vault" / "the token is expired" are fine; a value-like word is not
    if (/^(?:in|on|at|the|a|an|my|your|saved|stored|set|expired|wrong|correct|fine|ok|okay|not|no|none|empty|missing|required|needed|there|here|same|different|changed|new|old|rejected|invalid|valid|working|broken|revoked|rotated|ready|done|below|above|this|that|it)$/i.test(value)) continue;
    out.push({ kind: 'labelled', match: m[0] });
  }
  for (const m of text.matchAll(RANDOM)) {
    if (UUID.test(m[0]) || HEX_HASH.test(m[0])) continue;
    out.push({ kind: 'random', match: m[0] });
  }
  for (const m of text.matchAll(CARDISH)) {
    const digits = m[0].replace(/[ -]/g, '');
    if (digits.length >= 13 && digits.length <= 19 && luhn(digits)) out.push({ kind: 'card', match: m[0] });
  }
  return out;
}

/** Why this text must not be remembered, or null when it is fine. */
export function secretProblem(text: string): string | null {
  const f = findings(text);
  if (!f.length) return null;
  const kind = f[0]!.kind;
  if (kind === 'card') return 'It looks like a card number.';
  if (kind === 'labelled') return 'It looks like a password, code or key.';
  return 'It looks like an API key, token or other secret.';
}

/** The same text with anything secret-looking replaced by [secret removed]. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const f of findings(text)) out = out.split(f.match).join('[secret removed]');
  return out;
}

export class MemorySecretError extends Error {
  constructor(reason: string) {
    super(`Not saved to memory. ${reason} Secrets belong in the Secure Vault, not in memory.`);
    this.name = 'MemorySecretError';
  }
}
