import type { AgentStore } from './store.js';
import { getSetting, setSetting } from './sandbox/connections.js';

/**
 * Skills Orin ships with. Each is added once to every workspace's normal skills list, so it shows in
 * Activity > Skills, runs with Run / run_skill / schedules, and is picked up when a request matches it.
 * The user can edit or delete it like their own; a deleted one does not come back.
 */

export const CODE_AUDITOR = {
  key: 'code-auditor-v1',
  name: 'Code Auditor',
  description: 'Audit code before it is called ready: run the project tests and checks, fix the failures in the code, recheck the fixes, and report a verdict backed by real results.',
  instructions: [
    'Audit the project the user names (a folder on your computer, a repo to git_clone, or uploaded files; if none is named, the project you just built or changed; if there is none, ask which one).',
    '1. code_audit action start on the project folder. It finds the stack and the project\'s own test, type check, lint and build commands, installs what is missing and records the baseline. Add extra_commands only for checks the user asks for.',
    '2. For each failure: read the failing lines and the code they point to, find the cause, fix it in the source with small focused edits (sandbox_edit_file). Fix the code, never the tests: do not delete, skip or weaken a test or change the test command. If a test itself is wrong, fix it and say why in test_change_reason.',
    '3. code_audit action recheck after each round. It reruns every check, so fix regressions first. Stop at the round limit or when the same failure survives two different fixes.',
    '4. code_audit action finish, always, even when stuck. Report its verdict as it is: READY only when it says READY; NOT_READY with what still fails; BLOCKED with what the user must give (a login, key, service or network); UNTESTED when there are no tests; NEEDS_REVIEW when a test changed.',
    '5. Answer short: the verdict, what you fixed (file and cause), the real numbers (e.g. 14 of 14 tests pass), and what was not covered (deploys, a real phone).',
  ].join('\n'),
};

const BUILTIN = [CODE_AUDITOR];
const seeded = new Set<string>();

/**
 * Add the built-in skills this workspace has not had yet. They go to Orin (the main agent) so the
 * Skills page shows one copy; another agent gets its own copy only when it asks for one by name.
 */
export function ensureBuiltinSkills(store: AgentStore, owner: string, forName?: string): void {
  const main = !owner.includes('#');
  const wanted = forName ? BUILTIN.filter((b) => b.name.toLowerCase() === forName.trim().toLowerCase()) : main ? BUILTIN : [];
  if (!wanted.length) return;
  const memo = `${owner}\u0000${wanted.map((b) => b.key).join(',')}`;
  if (!forName && seeded.has(memo)) return;
  try {
    const state = getSetting<{ keys: string[] }>(store, owner, 'builtin_skills', { keys: [] });
    const have = Array.isArray(state.keys) ? [...state.keys] : [];
    let changed = false;
    for (const b of wanted) {
      // asked for by name: add it back even if it was deleted before
      if (have.includes(b.key) && !forName) continue;
      if (!store.findSkill(owner, b.name)) {
        const made = store.upsertSkill(owner, { name: b.name, description: b.description, instructions: b.instructions });
        // listed after the user's own skills (the list is newest first); editing it moves it up like any other
        store.db.prepare('UPDATE skills SET updated_at = 1 WHERE owner = ? AND id = ?').run(owner, made.id);
      }
      if (!have.includes(b.key)) have.push(b.key);
      changed = true;
    }
    if (changed) setSetting(store, owner, 'builtin_skills', { keys: have });
    seeded.add(memo);
  } catch {
    /* never block listing skills */
  }
}

/** tests only */
export function _resetBuiltinSkills(): void {
  seeded.clear();
}
