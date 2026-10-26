/**
 * What the user sees while Orin works: plain progress lines ("Building the Android app") instead of
 * raw commands, file paths and exit codes. The model still gets the full tool output, and approval
 * cards still show the exact command, so nothing the user must judge is hidden; this only changes
 * the step labels and step summaries streamed to the chat and saved on the reply and in task logs.
 */

/** Tools whose work is coding plumbing: their labels and success summaries are rewritten. */
const CODING = new Set([
  'run_code',
  'sandbox_run',
  'sandbox_job',
  'sandbox_write_file',
  'sandbox_edit_file',
  'sandbox_read_file',
  'sandbox_list_files',
  'sandbox_save',
  'sandbox_preview',
  'sandbox_close',
  'sandbox_browser',
  'sandbox_live_view',
  'write_file',
  'read_file',
  'list_files',
  'open_site',
  'preview_site',
  'check_site',
  'design_kit',
  'study_reference',
  'compare_to_reference',
]);

export function isCodingTool(name: string): boolean {
  return CODING.has(name);
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const base = (p: string) => p.replace(/\/+$/, '').split('/').pop() ?? p;
const host = (u: string) => {
  try {
    return new URL(/^https?:/i.test(u) ? u : `https://${u}`).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

/** A plain description of what a shell command is for. */
export function describeCommand(cmd: string): string {
  const c = cmd.trim();
  if (!c) return 'Working on the computer';
  if (/orin-capacitor-build|\bcap(acitor)?\s+(add|sync|copy|run|build)\b|@capacitor\/cli/i.test(c)) return 'Packaging the Android app';
  if (/orin-android-build|gradlew?|assemble(Release|Debug)|expo\s+prebuild|eas\s+build|bundletool|apksigner|zipalign/i.test(c)) return 'Building the Android app';
  if (/\b(create-vite|create-react-app|create-expo-app|create-next-app|npm\s+(init|create)|pnpm\s+create|yarn\s+create|npx\s+(create-|degit|@capacitor\/cli\s+init|cap\s+init))/i.test(c)) return 'Setting up the project';
  if (/\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add)\b|\bpip3?\s+install\b|\bapt(-get)?\s+install\b|\buv\s+(pip|add)\b/i.test(c)) return 'Installing what it needs';
  if (/\b(vitest|jest|pytest|playwright\s+test|npm\s+(run\s+)?test|pnpm\s+test|yarn\s+test)\b/i.test(c)) return 'Testing it';
  if (/\b(npm|pnpm|yarn|bun)\s+run\s+build\b|\bvite\s+build\b|\bnext\s+build\b|\btsc\b|\bwebpack\b|\besbuild\b/i.test(c)) return 'Building the app';
  if (/\b(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|preview|serve)\b|\bhttp\.server\b|\bnpx\s+(serve|http-server|vite)\b|\buvicorn\b|\bflask\s+run\b/i.test(c)) return 'Starting the app';
  if (/\b(curl|wget)\b.*\b(localhost|127\.0\.0\.1|0\.0\.0\.0)\b/i.test(c)) return 'Checking that it works';
  if (/\b(curl|wget)\b/i.test(c)) return 'Fetching from the web';
  if (/\bgit\s+(clone)\b/i.test(c)) return 'Getting the code';
  if (/\bgit\b/i.test(c)) return 'Saving code changes';
  if (/\b(zip|unzip|tar)\b/i.test(c)) return 'Packing files';
  if (/\b(ffmpeg|convert|magick|libreoffice|soffice|pandoc|pdftotext|pdftoppm)\b/i.test(c)) return 'Converting files';
  if (/^(cd\s+\S+\s*&&\s*)?(ls|cat|head|tail|find|du|df|tree|pwd|wc|grep|rg|stat|file)\b/i.test(c)) return 'Looking through the files';
  if (/^(cd\s+\S+\s*&&\s*)?(mkdir|cp|mv|rm|touch|chmod|ln)\b/i.test(c)) return 'Organising files';
  if (/\b(python3?|node|deno|bun|ruby|php|go\s+run|java)\b/i.test(c)) return 'Running the code';
  return 'Working on the computer';
}

function describeFile(path: string, verb: 'write' | 'edit'): string {
  const p = path.toLowerCase();
  if (/\.(html?|css|scss|svg)$/.test(p)) return verb === 'edit' ? 'Polishing the design' : 'Designing the page';
  if (/\.(js|mjs|cjs|jsx|ts|tsx|py|java|kt|swift|go|rs|rb|php|c|cpp|h|sh|vue|svelte)$/.test(p)) return verb === 'edit' ? 'Improving the code' : 'Writing the code';
  if (/(package\.json|tsconfig[^/]*\.json|capacitor\.config\.[jt]s(on)?|vite\.config\.[jt]s|app\.json|\.gradle|\.xml|\.ya?ml|\.toml|\.env[^/]*|\.ini)$/.test(p)) return 'Setting up the project';
  if (/\.(json|csv|tsv)$/.test(p)) return 'Preparing the data';
  return `${verb === 'edit' ? 'Updating' : 'Writing'} ${base(path)}`.slice(0, 60);
}

/** The progress line shown while a tool runs. Non-coding tools keep their own (already plain) label. */
export function friendlyLabel(name: string, args: unknown, label: string): string {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  switch (name) {
    case 'run_code':
      return 'Running the code';
    case 'sandbox_run':
      return describeCommand(str(a.command));
    case 'sandbox_job': {
      const act = str(a.action);
      if (act === 'start') return describeCommand(str(a.command));
      if (act === 'stop') return 'Stopping the background work';
      return 'Checking on progress';
    }
    case 'sandbox_write_file':
    case 'write_file':
      return describeFile(str(a.path), 'write');
    case 'sandbox_edit_file':
      return describeFile(str(a.path), 'edit');
    case 'sandbox_read_file':
    case 'read_file':
      return 'Checking the files';
    case 'sandbox_list_files':
    case 'list_files':
      return 'Looking through the files';
    case 'sandbox_save':
      return /\.(apk|aab)$/i.test(str(a.path)) ? 'Getting the app file ready' : 'Saving to your files';
    case 'sandbox_preview':
      return 'Opening a preview';
    case 'sandbox_close':
      return 'Shutting the computer down';
    case 'sandbox_live_view':
      return 'Opening the live view';
    case 'sandbox_browser': {
      const act = str(a.action);
      if (act === 'open' && host(str(a.url))) return `Opening ${host(str(a.url))}`;
      if (act === 'type' && a.login) return 'Signing in';
      return 'Using the browser';
    }
    case 'open_site':
      return `Opening ${str(a.name) || 'the site'}`.slice(0, 60);
    case 'preview_site':
      return 'Previewing the site';
    default:
      return label.trim() || 'Working on it';
  }
}

/**
 * The line under a finished step. Coding steps that worked show nothing extra (no file names or
 * exit codes); a coding step that failed says so plainly. Non-coding summaries are already plain.
 */
export function friendlySummary(name: string, ok: boolean, summary: string): string {
  if (!isCodingTool(name)) return summary;
  if (ok) {
    if (name === 'sandbox_preview' && /ready/i.test(summary)) return 'Preview ready';
    if (name === 'sandbox_save' && /saved/i.test(summary)) return 'Saved to your files';
    return '';
  }
  // Keep the outcome the user would care about, never the raw command or exit code.
  if (/declined|not approved|changes requested|needs approval|needs confirm/i.test(summary)) return summary;
  if (/no such job/i.test(summary)) return 'That work had stopped';
  if (/not answering/i.test(summary)) return "The preview didn't respond";
  if (/nothing saved/i.test(summary)) return 'Nothing was saved';
  return 'Ran into an error';
}
