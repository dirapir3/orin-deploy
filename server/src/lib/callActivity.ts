/**
 * When someone was last on a voice call (no ids, no content: just times). /v1/health reports it so a
 * deploy can wait for a quiet moment instead of restarting the server in the middle of a call
 * (tools/deploy_when_quiet.sh). A call counts as active while voice requests keep arriving.
 */
const QUIET_MS = 3 * 60_000;
let lastAt = 0;
const recent: number[] = [];

export function noteCallActivity(now = Date.now()): void {
  lastAt = now;
  recent.push(now);
  while (recent.length && now - recent[0]! > QUIET_MS) recent.shift();
  if (recent.length > 500) recent.splice(0, recent.length - 500);
}

export function callActivity(now = Date.now()): { active: boolean; lastVoiceSecondsAgo: number | null; voiceRequestsLast3Min: number; quietForDeploy: boolean } {
  while (recent.length && now - recent[0]! > QUIET_MS) recent.shift();
  const ago = lastAt ? Math.round((now - lastAt) / 1000) : null;
  const active = Boolean(lastAt) && now - lastAt < 90_000;
  return { active, lastVoiceSecondsAgo: ago, voiceRequestsLast3Min: recent.length, quietForDeploy: !lastAt || now - lastAt >= QUIET_MS };
}

/** tests */
export function resetCallActivity(): void {
  lastAt = 0;
  recent.length = 0;
}
