import { z } from 'zod';
import { defineTool, type ToolDef } from './tools/types.js';
import type { Task } from './store.js';

/**
 * Heavy work while the user keeps talking (task "heavy background work during voice calls", Nov 8).
 *
 * A voice turn has to answer within a few seconds. Coding, builds, the computer, the browser agent,
 * publishing, research and images take tens of seconds to minutes, and while a voice reply runs them
 * the call goes silent and the next thing the user says waits behind them. On a call those tools do
 * not run inside the spoken turn: calling one ends the turn at once and the work carries on as a
 * background task with the whole conversation so far (runtime.continueInBackground), so the voice
 * lane stays free. The task's approvals still reach the call (the app announces them at a gap), and
 * its result is said on the call when it finishes (app/src/lib/callResults.ts).
 */

/** tools that never run inside a spoken turn: they go to the background */
const HEAVY = /^(sandbox_(run|write_file|write_files|edit_file|job|browser|preview|save)|computer_|upload_to_computer|deliver_project|run_code|run_checks|code_map|scaffold_project|git_(clone|commit|push)|github_create_pr|browse$|browser_(open|click)|deep_research|publish_site|preview_site|trial_project|study_source|study_reference|compare_to_reference|review_design|generate_image|build_|deploy|apk_)/;

export function isHeavyVoiceTool(name: string): boolean {
  return HEAVY.test(name);
}

/** a spoken turn that has already spent this long on tools hands the rest to the background */
export const VOICE_TURN_BUDGET_MS = 15_000;

/** what the user hears when the work moves to the background */
export const VOICE_HANDOFF_NOTE = "I'll do that in the background so we can keep talking. I'll tell you when it's done.";
export const VOICE_HANDOFF_AGAIN_NOTE = "It's still going in the background. I'll tell you when it's done.";

export const DEFERRED_NOTE = (name: string) =>
  `Not run yet: on a voice call ${name} runs in background work so the conversation stays responsive. If you are reading this as that background work, run this step now with the same arguments and carry on with the job.`;

export interface VoiceWorkState {
  /** heavy calls this turn moved to the background */
  deferred: string[];
  started: number;
}

/**
 * On a call, heavy tools are swapped for stand-ins that do not run: they note the call and the turn
 * hands off right after this tool round (loop.ts `shouldHandoff`). Their approval cards are not shown
 * here; the background task asks for them when it really runs the step.
 * When the user's words were already passed to running work in this chat, the stand-in says so
 * instead, so the same job is not started twice.
 */
export function voiceTools(tools: ToolDef[], state: VoiceWorkState, opts: { passedTo?: { topic: string; taskId?: string }[] } = {}): ToolDef[] {
  const passed = (opts.passedTo ?? []).filter((p) => p.taskId);
  return tools.map((t) => {
    if (!isHeavyVoiceTool(t.name)) return t;
    const stand: ToolDef = {
      ...t,
      approval: undefined,
      handler: async () => {
        if (passed.length) {
          const p = passed[0]!;
          return {
            ok: true,
            content: `Not run: background work for this chat is already running ("${p.topic.slice(0, 100)}", task id ${p.taskId}) and the user's newest words were passed to it, so it includes them at its next step. Do not start it again. Tell the user in a few words that it's included. If this really is separate new work, use create_task with the full goal.`,
            summary: 'Passed to the running work',
          };
        }
        state.deferred.push(t.name);
        return { ok: true, content: DEFERRED_NOTE(t.name), summary: 'Moved to the background' };
      },
    };
    return stand;
  });
}

/** hand off after this tool round: a heavy call was moved, or the turn has used its time */
export function shouldHandOff(state: VoiceWorkState, now = Date.now()): boolean {
  return state.deferred.length > 0 || now - state.started > VOICE_TURN_BUDGET_MS;
}

/**
 * Short acknowledgements said on a call ("yeah", "okay", "go on") are conversation, not changes to
 * the work: they are not passed to running work as the user's notes.
 */
const FILLER = /^(?:(?:yeah|yea|yes|yep|yup|ya|ok|okay|k|sure|right|alright|all right|cool|nice|great|good|fine|mm+|hmm+|uh+|um+|ah+|oh|wow|thanks|thank you|thank|got it|i see|go on|go ahead|uh huh|mhm|haha|lol|no worries|it's okay|it's fine|that's fine|perfect|awesome|amazing|exactly|true|sounds good|that's what i'm saying|that's it|i'm saying|im saying|that's|thats|that is|i got it|i did)[\s,.!?…'-]*)+$/i;

export function isFiller(said: string): boolean {
  const s = said.trim();
  if (!s) return true;
  return FILLER.test(s.replace(/\s+/g, ' '));
}

/** the voice-only block for the system prompt */
export const VOICE_WORK_LINES = [
  '## Working while you talk (this call)',
  'Heavy work (coding, builds, the computer, browsing, publishing, studying projects, images) never runs inside a spoken reply: when you call one of those tools the work moves to the background by itself, with this whole conversation, and you keep talking. For a big job you can also use create_task with the full goal. Either way say in one short sentence that you are on it, never read out steps or logs, and do not say it is done: the result is said on this call and posted in the chat when it really finishes.',
  'While work runs, answer what the user says normally and briefly. Changes or additions to running work go to it with add_to_task. If the user clearly asks to stop a running task, use cancel_task with its id (they approve it). For progress, answer from the work list (task_status for detail).',
].join('\n');

/** cancel_task: stop the user's own running or queued background task (behind an approval card) */
export function cancelTaskTool(host: { getTask(owner: string, id: string): Task | null; cancelTask(owner: string, id: string): boolean }): ToolDef {
  return defineTool({
    name: 'cancel_task',
    description: "Stop one of the user's running or queued background tasks by id (from the work list or task_status). Only when the user clearly asks to stop or cancel that work. The user approves it first.",
    schema: z.object({ id: z.string().min(1).max(80) }),
    label: () => 'Stopping a task…',
    interactiveOnly: true,
    approval: (a, ctx) => {
      const t = host.getTask(ctx.owner, a.id);
      if (!t || (t.status !== 'running' && t.status !== 'queued')) return null;
      return { title: 'Stop task', headline: t.title, body: `Orin will stop the background task "${t.title}". Work it has not finished is lost.`, fields: [{ label: 'Task', value: t.title }] };
    },
    handler: async (a, ctx) => {
      const t = host.getTask(ctx.owner, a.id);
      if (!t) return { ok: false, content: 'No task with that id. Check the work list or task_status.', summary: 'Not found' };
      if (t.status !== 'running' && t.status !== 'queued') return { ok: false, content: `That task is not running (it is ${t.status}).`, summary: `Already ${t.status}` };
      return host.cancelTask(ctx.owner, a.id)
        ? { content: `Stopped the task "${t.title}".`, summary: 'Task stopped' }
        : { ok: false, content: 'Could not stop that task.', summary: 'Could not stop' };
    },
  });
}
