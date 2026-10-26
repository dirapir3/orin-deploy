import { z } from 'zod';
import { defineTool } from './types.js';
import { listFiles, workspaceDir, writeWsFile } from '../workspace.js';
import { KIT_CSS, RN_THEME, kitTemplate, type KitKind, type KitStyle } from '../designKit.js';
import { withSandbox } from './sandbox.js';
import { sandboxPath } from '../sandbox/index.js';

/**
 * design_kit: Orin's starter component set (agent/designKit.ts). Writes kit.css and a starter
 * index.html (landing page, phone app, one-page report or document) into a workspace site folder
 * or a sandbox folder, or theme.ts for Expo/React Native, so every build starts from the same
 * polished tokens and components instead of a blank file.
 */
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'site';

export const designKitTool = defineTool({
  name: 'design_kit',
  writes: true,
  description:
    'Start any visual build from your design kit (always the first step for a website, web app, phone app screen, report page or document page). Writes kit.css (colour and type tokens, spacing, buttons, cards, facts list, stat cards, tables, forms, app shell with app bar, list rows, tab bar, floating button, bottom sheet, toast, light and dark mode) and a starter index.html for the kind you pick, full of REPLACE markers. ' +
    'Then fill in the starter with write_file (workspace) or sandbox_write_file/sandbox_edit_file (computer): replace every REPLACE with real content, delete sections you have nothing real for, set --accent to the brand colour, keep kit.css as it is and put small extras in style.css. ' +
    'kind: landing (business, product or personal page), app (phone-first web app or Capacitor app), report (one-page report or dashboard), doc (article, guide, plan), rn-theme (theme.ts for Expo/React Native). style: clean (neutral product), editorial (warm, serif headlines: food, craft, culture), bold (geometric, high contrast: tech, fitness, events). ' +
    'target workspace writes to sites/<folder>/ (for preview_site and publish_site); target computer writes to a folder on your computer (for Vite or Capacitor builds, e.g. app/www or app/public).',
  schema: z.object({
    kind: z.enum(['landing', 'app', 'report', 'doc', 'rn-theme']),
    folder: z.string().min(1).max(120).describe('Site name for the workspace (e.g. "ember-oak" -> sites/ember-oak/), or a folder path on your computer'),
    style: z.enum(['clean', 'editorial', 'bold']).optional(),
    target: z.enum(['workspace', 'computer']).optional().describe('Default workspace'),
    overwrite: z.boolean().optional().describe('Replace an existing index.html (default false: only kit.css is refreshed)'),
  }),
  label: () => 'Setting up the design',
  handler: async (a, ctx) => {
    const style = (a.style ?? 'clean') as KitStyle;
    const target = a.target ?? 'workspace';
    const files: Array<[string, string]> =
      a.kind === 'rn-theme' ? [['theme.ts', RN_THEME]] : [['kit.css', KIT_CSS], ['index.html', kitTemplate(a.kind as KitKind, style)]];
    const written: string[] = [];
    const kept: string[] = [];
    if (target === 'workspace') {
      const root = workspaceDir(ctx.services, ctx.owner);
      const folder = a.folder.startsWith('sites/') ? a.folder.replace(/\/+$/, '') : `sites/${slug(a.folder)}`;
      const existing = new Set(listFiles(root).map((f) => f.path));
      for (const [name, body] of files) {
        const p = `${folder}/${name}`;
        if (name !== 'kit.css' && existing.has(p) && !a.overwrite) {
          kept.push(p);
          continue;
        }
        writeWsFile(root, p, body);
        written.push(p);
      }
      return {
        content: [
          `Design kit ready in ${folder}/: wrote ${written.join(', ') || 'nothing'}${kept.length ? `; kept your existing ${kept.join(', ')} (overwrite=true to replace)` : ''}.`,
          a.kind === 'rn-theme' ? '' : `Next: read_file ${folder}/index.html, then write_file it back with every REPLACE filled from the user's real details (remove sections you cannot fill truthfully), set --accent, add style.css only for page-specific touches, then preview_site and review_design (pass = 8/10).`,
        ].filter(Boolean).join('\n'),
        summary: 'Design kit ready',
      };
    }
    const dir = sandboxPath(a.folder.replace(/\/+$/, ''));
    await withSandbox(ctx, async (s) => {
      for (const [name, body] of files) {
        const p = `${dir}/${name}`;
        if (name !== 'kit.css' && !a.overwrite) {
          const had = await s.readFile(p).catch(() => null);
          if (had) {
            kept.push(p);
            continue;
          }
        }
        await s.writeFile(p, body);
        written.push(p);
      }
    });
    return {
      content: `Design kit ready on your computer in ${dir}/: wrote ${written.join(', ') || 'nothing'}${kept.length ? `; kept existing ${kept.join(', ')}` : ''}. Fill in every REPLACE, keep kit.css, then check it with review_design before building or sharing.`,
      summary: 'Design kit ready',
    };
  },
});
