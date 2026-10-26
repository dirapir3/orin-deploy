/**
 * How Orin gets things done, the way a capable assistant agent does: the work method (plan, act,
 * check, fix, verify, deliver), the design standards every page or app she makes starts from, and
 * the run-time checks the agent loop applies (agent/loop.ts) so a build is looked at before it is
 * called finished and a failure is never reported as success.
 *
 * The prompt text sets the defaults; the loop enforces the parts a prompt alone cannot guarantee.
 */

/** The work method, shared by chat, voice and background tasks. */
export const WORK_METHOD: string[] = [
  '## How you get things done',
  'Work like a capable assistant, not a chatbot: when the user asks for something you have tools for, the job is to finish it, not to describe it.',
  '1. Understand the goal and what "done" looks like (a live link, an APK, a file, an answer). Plan the steps in your head; do not show the plan unless asked.',
  '2. Act with your tools. Fetch what you need up front; run independent tool calls together in one turn.',
  '3. Check every result. Read errors in full, fix the cause, and run it again. If an approach fails twice the same way, change approach (another tool, another library, a simpler design) instead of repeating it.',
  '4. Verify before you claim success: open what you built (review_design for any page or app screen, sandbox_run for code and tests, check_site for a live link) and fix what it finds. Never say something works, is live, sent or saved unless a tool result in this conversation shows it.',
  '5. Deliver the result itself: the link publish_site confirmed, the file or APK sent with sandbox_save, the actual answer with names, numbers and quotes. Not "it is ready", not a list of what you did.',
  'Be relentless before asking: search, read the page, try the other plausible reading. Ask the user (ask_user) only for information only they have, and ask everything you need in one question.',
  'When something cannot be done, say plainly what failed, what you tried, and the one next step the user can take. A partial result is labelled as partial.',
  'Facts you bring in (prices, dates, specs, news) come from a tool result in this conversation, from the primary source when there is one. Never invent a link.',
  'Answer what was asked and stop. No unrequested advice, no offers stacked at the end.',
  'Keep improving yourself: when you solved something only after a failure, found a better way, or the user corrected your work or taste, save the reusable rule with learn_lesson. Your saved lessons are listed in this prompt; follow them.',
];

/** How Orin works on her own code (her source is public; deploying it stays the user's step). */
export const SELF_IMPROVEMENT: string[] = [
  '## Improving your own app and server',
  'Your own source code (the Orin app and server) is public at https://github.com/dirapir3/orin-deploy. When the user asks you to improve yourself, add a feature to Orin, or fix one of your own bugs, work on it like any other build:',
  '- On your computer: git clone --depth 1 https://github.com/dirapir3/orin-deploy (or git pull if it is already there), read the README/HANDOFF notes and the code involved, then make the change.',
  '- Server changes: in server/, npm ci, then npx tsc --noEmit and npx vitest run; add a test for what you changed and keep every test passing. App changes: build the web app or APK the usual way and review_design every changed screen.',
  '- Deliver the result: a short summary of what changed and how it was tested, plus the patch (git diff > orin-change.patch) or the zipped project sent with sandbox_save, or the APK. Going live (pushing to GitHub and deploying on Render) needs the user\'s accounts: say so, and only do it with their sign-in and their approval of each push or deploy.',
  '- Never put keys or passwords in code, patches or commits; never remove approval prompts, the vault or privacy protections.',
];

/** Design defaults for anything visual Orin builds (websites, web apps, phone app screens). */
export const DESIGN_STANDARDS: string[] = [
  '## Design standards (always on; the user never has to ask for "modern" or "polished")',
  'Everything you build should look like a current, professionally designed product (think Linear, Stripe, Apple, Sesame), never like a 1990s page. These are your defaults unless the user asks for a specific style:',
  '- Structure: semantic HTML (header, main, section, nav, footer, button, label), <html lang>, <meta name="viewport" content="width=device-width, initial-scale=1">, a real <title>. No tables for layout, no <center>, <font>, bgcolor, align attributes or inline style soup.',
  '- Type: a modern font stack, e.g. font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif (load Inter from Google Fonts if you want it exact). Base 16-18px, line-height 1.5-1.7, a clear scale (e.g. 14 / 16 / 20 / 28 / 40 / 56px), headings 600-800 weight with slightly tight letter-spacing, body text max ~70 characters wide. Never the browser default Times font.',
  '- Colour: CSS custom properties (--bg, --surface, --text, --muted, --accent, --border) in :root, one confident accent colour, soft neutrals, text contrast at least 4.5:1. Support dark mode with prefers-color-scheme when it fits. No pure #0000FF links or default purple visited links.',
  '- Layout: mobile first, CSS grid/flexbox, a centred container (max-width ~1100-1200px, generous side padding), spacing on an 8px rhythm with plenty of whitespace between sections. Must work at 360px wide with no sideways scrolling, and look intentional at 1280px+.',
  '- Components: rounded corners (10-16px), subtle borders or soft shadows, cards for grouped content, buttons at least 44px tall with clear hover, active and :focus-visible states, smooth 150-250ms transitions, inputs with visible labels. Use inline SVG icons (no emoji as icons), real-looking content (no lorem ipsum unless asked), and images with alt text.',
  '- Pages people land on get a strong hero (headline, one-line value, primary action), then clear sections. Apps and tools get a clean app shell: top bar, focused main area, obvious primary action, empty and loading states, and data saved in localStorage when there is no server.',
  '- Code quality: separate style.css and app.js for anything non-trivial, no console errors, every button does something, works offline once loaded when it can.',
  '- Phone apps (Capacitor or Expo): design for a 390px screen first, safe-area padding, bottom-reachable primary actions, 44px touch targets, native-feeling motion.',
  'After building or changing anything visual, call review_design on it, fix every high and medium issue it reports, and review again (up to three rounds) before you share the link or build the APK.',
];

const FINAL_CHECK =
  'Before your final answer, check it against the goal: every part covered (each item, each detail, the number of options asked for); every fact and link from a tool result in this run; every action you report (built, published, sent, saved) backed by a successful tool result; the result itself in the answer, not a description of the work. Fix what fails first. Never send a first batch or promise more later.';

/** Short version for voice replies (the work happens in tools or tasks either way). */
const VOICE_METHOD = [
  'When asked to build or do something, do it with your tools (or start a background task for long work) rather than describing it; everything you build follows your design standards and is checked with review_design before you call it done.',
];

const BUILD_TOOLS = ['write_file', 'sandbox_write_file', 'sandbox_edit_file', 'publish_site'];

/** The craft block for the system prompt, sized to the mode and the tools available. */
export function craftLines(tools: string[], mode: 'chat' | 'voice' | 'task'): string[] {
  const canBuild = tools.some((t) => BUILD_TOOLS.includes(t));
  if (mode === 'voice') return ['', ...WORK_METHOD.slice(0, 1), ...VOICE_METHOD];
  const out = ['', ...WORK_METHOD];
  if (mode === 'task') out.push(FINAL_CHECK);
  if (tools.includes('sandbox_run')) out.push('', ...SELF_IMPROVEMENT);
  if (canBuild) out.push('', ...DESIGN_STANDARDS.filter((l) => tools.includes('review_design') || !l.includes('review_design')));
  return out;
}

// ---------------------------------------------------------------- run-time checks for the loop

const UI_FILE = /\.(html?|css|jsx|tsx|vue|svelte)$/i;
const CODE_FILE = /\.(m?js|cjs|ts|py|sh|go|rs|java|kt|rb|php)$/i;
const VERIFY_UI = new Set(['review_design']);
const LOOKUP = /^(web_search|news_search|deep_research|fetch_page|browse|recall|task_status|datetime|list_|get_|read_|search_|sandbox_read_file|sandbox_list_files|sandbox_live_view)/;
const RUNS_CODE = new Set(['sandbox_run', 'run_code', 'sandbox_job', 'review_design', 'preview_site', 'check_site', 'publish_site', 'sandbox_browser']);

function pathOf(args: unknown): string {
  if (!args || typeof args !== 'object') return '';
  const a = args as Record<string, unknown>;
  return typeof a.path === 'string' ? a.path : typeof a.file === 'string' ? a.file : '';
}

/**
 * Tracks what a run built, checked and failed, so the loop can stop it from finishing with an
 * unverified build or an unresolved failure. One instance per runAgent call.
 */
export class WorkTracker {
  private uiDirty = false;
  private codeDirty = false;
  /** last outcome per tool name, and the error text of failures */
  private lastFail = new Map<string, string>();
  private repeatFails = new Map<string, number>();
  private streak = 0;
  private gates = 0;
  /** a tool that failed and then succeeded: something was learned */
  private recovered = '';
  private failedOnce = new Set<string>();
  private learned = false;
  private askedToLearn = false;
  private readonly canLearn: boolean;
  private readonly canReview: boolean;
  private readonly canRun: boolean;

  constructor(toolNames: string[], private readonly maxGates = 2) {
    this.canReview = toolNames.includes('review_design');
    this.canRun = toolNames.some((t) => t === 'sandbox_run' || t === 'run_code');
    this.canLearn = toolNames.includes('learn_lesson');
  }

  /** Record one finished tool call. Returns a recovery note for the model when it is going in circles. */
  record(name: string, args: unknown, ok: boolean, content: string): string | null {
    const p = pathOf(args);
    if (ok && ['write_file', 'sandbox_write_file', 'sandbox_edit_file'].includes(name)) {
      if (UI_FILE.test(p)) this.uiDirty = true;
      else if (CODE_FILE.test(p)) {
        this.codeDirty = true;
        // a script or component that renders the page counts as UI work too
        if (/\.(jsx|tsx)$|(^|\/)(app|main|script|index)\.m?js$/i.test(p)) this.uiDirty = true;
      }
    }
    if (ok && VERIFY_UI.has(name)) this.uiDirty = false;
    if (ok && RUNS_CODE.has(name)) this.codeDirty = false;
    if (ok && name === 'learn_lesson') this.learned = true;
    if (ok && this.failedOnce.has(name) && !LOOKUP.test(name)) this.recovered = name;
    if (ok) {
      this.lastFail.delete(name);
      this.streak = 0;
      return null;
    }
    this.streak++;
    this.failedOnce.add(name);
    const key = `${name}:${JSON.stringify(args ?? {})}`;
    const n = (this.repeatFails.get(key) ?? 0) + 1;
    this.repeatFails.set(key, n);
    if (!LOOKUP.test(name)) this.lastFail.set(name, content.slice(0, 300)); // a failed lookup with a fallback is normal; a failed action is not
    if (/did NOT run|declined|did not approve|did not answer/i.test(content)) return null; // the user's decision, not a bug to work around
    if (n === 2) return `${name} failed twice with exactly the same arguments. Do not call it the same way again: read the error, change the input or use a different approach.`;
    if (this.streak === 3) return 'Three tool calls in a row have failed. Step back: re-read the errors, find the real cause, and pick a different route (another tool, a simpler approach, or a smaller step). If it truly cannot be done, stop and tell the user plainly what failed and what you tried.';
    return null;
  }

  /**
   * Called when the model wants to finish (no tool calls). Returns a note sending it back to work
   * when the build was not checked or a failure is unresolved, or null to let it finish.
   */
  gate(reply: string): string | null {
    if (this.gates >= this.maxGates) return null;
    let note: string | null = null;
    if (this.uiDirty && this.canReview) {
      note = 'Before you finish: you changed the files of a page or app screen and have not looked at the result. Call review_design on it now, fix every high or medium issue it reports, then give your final answer.';
      this.uiDirty = false;
    } else if (this.codeDirty && this.canRun) {
      note = 'Before you finish: you wrote or changed code and have not run it since. Run it (or its tests or build) with sandbox_run, fix any error, then give your final answer.';
      this.codeDirty = false;
    } else if (this.lastFail.size) {
      const [name, err] = [...this.lastFail.entries()].pop()!;
      const claimsSuccess = /\b(done|ready|live|finished|built|published|sent|saved|deployed|installed|fixed|works now)\b/i.test(reply) && !/\b(not|couldn'?t|could not|failed|didn'?t|unable|isn'?t|wasn'?t)\b/i.test(reply);
      if (claimsSuccess) note = `Before you finish: ${name} failed ("${err.replace(/\s+/g, ' ').slice(0, 160)}") and has not succeeded since. Either fix it and verify, or say plainly in your answer which part is not done and why. Do not report it as working.`;
      this.lastFail.clear();
    }
    if (!note && this.recovered && this.canLearn && !this.learned && !this.askedToLearn) {
      // self-improvement: a problem was hit and solved, so keep the fix for next time
      this.askedToLearn = true;
      note = `Before you finish: ${this.recovered} failed at first and then worked. If what fixed it is reusable, save it with learn_lesson as one short rule so you don't hit it again (skip it if it was a one-off), then give the same final answer.`;
    }
    if (note) this.gates++;
    return note;
  }
}

// ---------------------------------------------------------------- static design lint (review_design)

export interface DesignIssue {
  severity: 'high' | 'medium' | 'low';
  issue: string;
  fix: string;
}

/** Checks HTML + CSS source for the marks of an old-fashioned or broken page. Pure; no network. */
export function lintDesign(html: string, css: string): DesignIssue[] {
  const out: DesignIssue[] = [];
  const add = (severity: DesignIssue['severity'], issue: string, fix: string) => out.push({ severity, issue, fix });
  const inlineCss = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join('\n');
  const allCss = `${css}\n${inlineCss}`;
  const tw = /tailwind|cdn\.tailwindcss|bootstrap|bulma|pico\.css|daisyui/i.test(html);

  if (!/<meta[^>]+name=["']viewport["']/i.test(html)) add('high', 'No viewport meta tag: on a phone the page renders as a shrunken desktop page.', 'Add <meta name="viewport" content="width=device-width, initial-scale=1"> in <head>.');
  if (!/<title>[^<]{2,}<\/title>/i.test(html)) add('low', 'Missing or empty <title>.', 'Give the page a real title.');
  if (!/<html[^>]+lang=/i.test(html)) add('low', 'No lang attribute on <html>.', 'Use <html lang="en"> (or the right language).');
  const legacy = [
    [/<center\b/i, '<center>'],
    [/<font\b/i, '<font>'],
    [/<marquee\b|<blink\b/i, '<marquee>/<blink>'],
    [/\sbgcolor=/i, 'bgcolor='],
    [/<(?:td|table|div|p|img)[^>]+\salign=/i, 'align='],
    [/<table[^>]+(?:border|cellpadding|cellspacing)=/i, 'table border/cellpadding'],
  ] as const;
  const found = legacy.filter(([re]) => re.test(html)).map(([, n]) => n);
  if (found.length) add('high', `Old-fashioned HTML (${found.join(', ')}): this is what makes a page look like the 1990s.`, 'Remove it; do layout with flexbox/grid and styling in CSS.');
  const tables = (html.match(/<table\b/gi) ?? []).length;
  if (tables && (/<table[\s\S]*<table/i.test(html) || /<table[\s\S]{0,4000}?<(nav|form|header)\b/i.test(html) || !/<th\b/i.test(html))) add('high', 'Tables used for page layout.', 'Use CSS grid or flexbox for layout; keep <table> for real tabular data with <th> headers.');
  const rules = (allCss.match(/\{/g) ?? []).length;
  if (!tw && rules < 12) add('high', `Almost no styling (${rules} CSS rule${rules === 1 ? '' : 's'}): the browser defaults show through.`, 'Write a full stylesheet: variables, typography, layout, components, states.');
  if (!tw && rules >= 1 && !/font-family\s*:/i.test(allCss)) add('high', 'No font-family set: the page falls back to the browser default (Times).', 'Set a modern stack on body, e.g. Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif.');
  else if (/font-family\s*:\s*["']?(times|georgia|serif\b|comic sans|arial black|courier)/i.test(allCss) && !/font-family\s*:\s*[^;]*(inter|system-ui|sans-serif)/i.test(allCss)) add('medium', 'Dated font choice for body text.', 'Use a modern sans-serif stack (Inter, system-ui, ...), or a deliberate serif pairing only for headings.');
  if (!tw && rules >= 12) {
    if (!/@media/i.test(allCss) && !/display\s*:\s*(grid|flex)/i.test(allCss)) add('high', 'No responsive layout: no media queries and no flexbox/grid.', 'Build the layout with grid/flexbox, mobile first, with breakpoints for wider screens.');
    if (!/max-width\s*:/i.test(allCss) && !/min\(|clamp\(/i.test(allCss)) add('medium', 'Content is not held in a container: lines run the full width on big screens.', 'Wrap content in a centred container (max-width ~1100-1200px, margin-inline auto, side padding).');
    if (!/--[\w-]+\s*:/.test(allCss)) add('low', 'No CSS variables: colours and spacing are scattered and hard to keep consistent.', 'Define --bg, --surface, --text, --muted, --accent, --border, --radius in :root.');
    if (!/:hover|:focus/i.test(allCss)) add('medium', 'No hover or focus states: buttons and links feel dead and keyboard users get lost.', 'Add :hover, :active and :focus-visible styles to every interactive element.');
    if (!/border-radius/i.test(allCss)) add('low', 'Square, unstyled components.', 'Round corners (10-16px) on cards, buttons and inputs.');
    if (/(^|[^-])color\s*:\s*(#00f\b|#0000ff|blue\b)/i.test(allCss)) add('medium', 'Pure blue (#0000FF) text/links look like an unstyled page.', 'Use the accent colour variable.');
  }
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map((m) => m[0]);
  const noAlt = imgs.filter((t) => !/\salt=/i.test(t)).length;
  if (noAlt) add('medium', `${noAlt} image${noAlt === 1 ? '' : 's'} without alt text.`, 'Add a short alt to each meaningful image (alt="" for decoration).');
  if (/lorem ipsum/i.test(html)) add('medium', 'Placeholder lorem ipsum text.', 'Write real, specific copy for this product or person.');
  const inlineStyles = (html.match(/\sstyle="/gi) ?? []).length;
  if (inlineStyles > 25) add('low', `${inlineStyles} inline style attributes.`, 'Move styling into the stylesheet with classes.');
  if (/<button\b[^>]*>\s*<\/button>/i.test(html)) add('medium', 'An empty button (no text or label).', 'Give every button visible text or an aria-label.');
  return out;
}

const ORDER = { high: 0, medium: 1, low: 2 } as const;
export function sortIssues(list: DesignIssue[]): DesignIssue[] {
  const seen = new Set<string>();
  return list.filter((i) => (seen.has(i.issue) ? false : (seen.add(i.issue), true))).sort((a, b) => ORDER[a.severity] - ORDER[b.severity]);
}

/** The rubric the vision model scores screenshots with. */
export const REVIEW_RUBRIC =
  'You are a senior product designer reviewing screenshots of a page an AI assistant just built (first image: phone 390px wide, second: desktop 1280px wide, when present). ' +
  'Judge it against a current professional standard (Linear, Stripe, Apple, Vercel): visual hierarchy, typography, spacing and alignment, colour and contrast, consistency, responsiveness, polish, and whether it looks dated, cramped, broken or unfinished. ' +
  'Be strict: a plain page with default fonts, no spacing system or unstyled controls scores 4 or lower; 8+ means you would ship it. ' +
  'Reply with ONLY JSON: {"score": <1-10>, "verdict": "<one sentence>", "issues": [{"severity": "high|medium|low", "issue": "<what is wrong, where>", "fix": "<specific CSS/HTML change>"}]} with at most 6 issues, most important first.';

/** Parses the vision model's JSON reply, tolerating fences and stray text. */
export function parseReview(raw: string): { score: number | null; verdict: string; issues: DesignIssue[] } {
  try {
    const j = JSON.parse(/\{[\s\S]*\}/.exec(raw)?.[0] ?? '{}') as { score?: unknown; verdict?: unknown; issues?: unknown };
    const score = typeof j.score === 'number' && j.score >= 1 && j.score <= 10 ? Math.round(j.score) : null;
    const issues = Array.isArray(j.issues)
      ? j.issues
          .filter((i): i is Record<string, unknown> => !!i && typeof i === 'object' && typeof (i as Record<string, unknown>).issue === 'string')
          .slice(0, 6)
          .map((i) => ({ severity: (['high', 'medium', 'low'].includes(String(i.severity)) ? i.severity : 'medium') as DesignIssue['severity'], issue: String(i.issue).slice(0, 300), fix: String(i.fix ?? '').slice(0, 300) }))
      : [];
    return { score, verdict: typeof j.verdict === 'string' ? j.verdict.slice(0, 300) : '', issues };
  } catch {
    return { score: null, verdict: '', issues: [] };
  }
}
