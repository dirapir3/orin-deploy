/**
 * Spotting actions that reach outside the chat, so they wait for the user's approval card:
 * buttons and links that send, buy, book, post or delete, and shell commands that send data
 * to a site, publish, push or deploy.
 */

/** Words on a button or link that mean pressing it does something for the user. */
const RISKY_CONTROL =
  /\b(send|submit|post|publish|share|buy|purchase|order|checkout|check out|pay|payment|donate|subscribe|unsubscribe|book|reserve|confirm|place|delete|remove|erase|cancel|close account|deactivate|sign up|register|apply|transfer|withdraw|tweet|reply|comment|invite|accept|decline|approve|upload|deploy)\b/i;

export function isRiskyControl(text: string): boolean {
  return RISKY_CONTROL.test(text.replace(/[_-]+/g, ' '));
}

const SENDS: { re: RegExp; why: string }[] = [
  { re: /\bcurl\b[^\n|;&]*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s--request\s+(POST|PUT|PATCH|DELETE)\b|\s-d\b|\s--data(-raw|-binary|-urlencode)?\b|\s-F\b|\s--form\b|\s--json\b|\s-T\b|\s--upload-file\b)/i, why: 'sends data to a website' },
  { re: /\bwget\b[^\n|;&]*--(post-data|post-file|body-data|body-file|method)\b/i, why: 'sends data to a website' },
  { re: /\bhttps?\s+(POST|PUT|PATCH|DELETE)\b/i, why: 'sends data to a website' },
  { re: /\b(requests|httpx|session|client|aiohttp)\.(post|put|patch|delete)\s*\(/i, why: 'sends data to a website' },
  { re: /\bmethod\s*[:=]\s*['"](POST|PUT|PATCH|DELETE)['"]/i, why: 'sends data to a website' },
  { re: /\baxios\.(post|put|patch|delete)\s*\(/i, why: 'sends data to a website' },
  { re: /\b(smtplib|nodemailer|sendmail|mailx?)\b/i, why: 'sends email' },
  { re: /\bgit\s+push\b/i, why: 'pushes code to a remote repository' },
  { re: /\b(npm|pnpm|yarn)\s+publish\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b/i, why: 'publishes a package' },
  { re: /\b(vercel|netlify|wrangler|firebase|fly|flyctl|heroku|surge|gh-pages)\b[^\n]*\b(deploy|publish|--prod)\b/i, why: 'deploys to a hosting service' },
  { re: /\bgh\s+(pr|issue|release|repo|gist)\s+(create|merge|close|delete|edit|comment)\b/i, why: 'changes something on GitHub' },
  { re: /\bhuggingface-cli\s+upload\b|\bupload_(file|folder)\s*\(/i, why: 'uploads files to a website' },
  { re: /\b(scp|rsync|sftp)\b[^\n]*\S+@\S+:/i, why: 'copies files to another computer' },
  { re: /\bssh\s+\S+@\S+/i, why: 'runs commands on another computer' },
];

/** Why a shell command or code snippet needs the user's OK (it sends, pushes, publishes or deploys), or null. */
export function commandRisk(code: string): string | null {
  for (const s of SENDS) {
    if (!s.re.test(code)) continue;
    // testing a server running on the sandbox itself sends nothing anywhere
    if (s.why === 'sends data to a website') {
      const hosts = [...code.matchAll(/\bhttps?:\/\/([^/\s:'"`]+)/gi)].map((m) => m[1]!.toLowerCase());
      const bare = [...code.matchAll(/\b(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?\b/gi)].length;
      if ((hosts.length || bare) && hosts.every((h) => /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])$/.test(h))) continue;
    }
    return s.why;
  }
  return null;
}
