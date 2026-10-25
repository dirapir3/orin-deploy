import { z } from 'zod';
import { revealLogin } from '../vault.js';
import type { ToolContext } from '../tools/types.js';

/**
 * Vault secrets for commands on Orin's computer. The model names a Secure Vault entry and an
 * environment variable; the server puts the value into that variable for the one command and
 * never shows it: the value is not in the tool arguments, and every output that comes back from
 * the sandbox (command output, file reads, listings) has it replaced with [secret:NAME].
 */

export const secretsSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(80).describe('Secure Vault entry name, e.g. "OpenWeather key"'),
      env: z
        .string()
        .regex(/^[A-Z_][A-Z0-9_]{0,63}$/, 'env must look like OPENWEATHER_API_KEY')
        .describe('Environment variable it is put in for this command, e.g. OPENWEATHER_API_KEY'),
    }),
  )
  .max(10)
  .optional()
  .describe(
    'Keys or passwords from the user\'s Secure Vault to put into environment variables for this run, e.g. [{"name":"OpenWeather key","env":"OPENWEATHER_API_KEY"}]. Read them as $OPENWEATHER_API_KEY (bash) or os.environ / process.env. You never see the value; never print it.',
  );

export type SecretRefs = z.infer<typeof secretsSchema>;

interface Held {
  name: string;
  value: string;
  until: number;
}

/** Values to hide, per owner, for as long as a sandbox could still hold them (files, history). */
const held = new Map<string, Held[]>();
const HOLD_MS = 6 * 60 * 60_000;

function ownerKey(owner: string): string {
  return owner.split('#')[0]!;
}

export function holdSecret(owner: string, name: string, value: string) {
  remember(owner, name, value);
}

function remember(owner: string, name: string, value: string) {
  const k = ownerKey(owner);
  const now = Date.now();
  const list = (held.get(k) ?? []).filter((h) => h.until > now && h.value !== value);
  list.push({ name, value, until: now + HOLD_MS });
  held.set(k, list.slice(-50));
}

/** Resolves vault names to env values. Throws a plain message when one is missing. */
export function resolveSecrets(ctx: ToolContext, refs: SecretRefs): { envs: Record<string, string>; names: string[] } {
  const envs: Record<string, string> = {};
  const names: string[] = [];
  if (!refs?.length) return { envs, names };
  const missing: string[] = [];
  for (const r of refs) {
    const row = ctx.services.store.findVault(ownerKey(ctx.owner), r.name);
    if (!row) {
      missing.push(r.name);
      continue;
    }
    const { password, username } = revealLogin(row);
    const value = password || username;
    if (!value) {
      missing.push(r.name);
      continue;
    }
    envs[r.env] = value;
    names.push(row.name);
    remember(ctx.owner, row.name, value);
    if (password && username && username.length >= 6) {
      // a login used whole: give the username too, and hide it as well
      envs[`${r.env}_USER`] = username;
    }
  }
  if (missing.length) {
    const list = ctx.services.store.listVault(ownerKey(ctx.owner)).map((v) => `"${v.name}"`).slice(0, 20);
    throw new Error(
      `No Secure Vault entry named ${missing.map((m) => `"${m}"`).join(', ')}. ${list.length ? `Saved entries: ${list.join(', ')}.` : 'The vault is empty.'} Ask for it with ask_secret (what: api_key), then try again.`,
    );
  }
  return { envs, names };
}

/** Replaces every held secret value (and its common encodings) in text with [secret:NAME]. */
export function redactSecrets(owner: string, text: string): string {
  if (!text) return text;
  const list = held.get(ownerKey(owner));
  if (!list?.length) return text;
  let out = text;
  const now = Date.now();
  for (const h of list) {
    if (h.until < now || h.value.length < 4) continue;
    const forms = new Set([h.value, Buffer.from(h.value).toString('base64'), encodeURIComponent(h.value), JSON.stringify(h.value).slice(1, -1)]);
    for (const f of forms) if (f.length >= 4) out = out.split(f).join(`[secret:${h.name}]`);
  }
  return out;
}

/** For tests. */
export function _clearHeldSecrets() {
  held.clear();
}
