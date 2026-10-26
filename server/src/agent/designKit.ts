/**
 * Orin's design skill: the starter kit she builds every visual thing from (sites, web apps,
 * Capacitor/Expo screens, reports) so the result looks current and consistent by default.
 * Adapted from the page-design guidance Miles works from: lead with the point, one shared component
 * set, a real type scale and spacing rhythm, one accent colour, mobile first, scannable layout,
 * no filler and no invented details.
 *
 * The design_kit tool (tools/design.ts) writes these files into a site or sandbox folder; the
 * prompt block (DESIGN_SKILL) tells her how to use them, and review_design scores against it.
 */

export type KitKind = 'landing' | 'app' | 'report' | 'doc';
export const KIT_KINDS: KitKind[] = ['landing', 'app', 'report', 'doc'];
export type KitStyle = 'clean' | 'editorial' | 'bold';
export const KIT_STYLES: KitStyle[] = ['clean', 'editorial', 'bold'];

/** Shared stylesheet. Tokens first, then layout primitives, then components. */
export const KIT_CSS = String.raw`/* kit.css - Orin design kit. Change the brand in :root (--accent, fonts); keep the rest. */
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&family=Fraunces:opsz,wght@9..144,500;9..144,650&family=Space+Grotesk:wght@500;700&display=swap');

:root {
  --accent: #4f46e5;            /* the ONE brand colour: buttons, links, focus, highlights */
  --accent-ink: #ffffff;        /* text on the accent */
  --accent-soft: color-mix(in oklab, var(--accent) 12%, transparent);
  --bg: #fafaf9;
  --surface: #ffffff;
  --surface-2: #f4f4f2;
  --text: #18181b;
  --muted: #5f5f68;
  --line: #e7e5e4;
  --good: #15803d; --warn: #b45309; --bad: #b91c1c;
  --font: 'Inter', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  --font-display: var(--font);
  --display-weight: 750;
  --display-track: -0.025em;
  /* type scale (fluid): small 14, body 16-17, lead 19-21, h3 20, h2 26-34, h1 34-60 */
  --fs-sm: 0.875rem; --fs-body: clamp(1rem, 0.97rem + 0.15vw, 1.0625rem);
  --fs-lead: clamp(1.15rem, 1.05rem + 0.45vw, 1.3rem); --fs-h3: 1.25rem;
  --fs-h2: clamp(1.6rem, 1.3rem + 1.2vw, 2.15rem); --fs-h1: clamp(2.15rem, 1.5rem + 3vw, 3.75rem);
  /* spacing on an 8px rhythm */
  --s1: 4px; --s2: 8px; --s3: 12px; --s4: 16px; --s5: 24px; --s6: 32px; --s7: 48px; --s8: 72px; --s9: 112px;
  --radius: 14px; --radius-sm: 10px; --radius-pill: 999px;
  --shadow: 0 1px 2px rgb(0 0 0 / .04), 0 6px 24px -8px rgb(0 0 0 / .10);
  --shadow-lg: 0 2px 6px rgb(0 0 0 / .05), 0 24px 60px -20px rgb(0 0 0 / .22);
  --container: 1120px; --measure: 68ch;
  --ease: cubic-bezier(.2,.7,.2,1);
  color-scheme: light dark;
}
/* Style presets: <html data-style="editorial"> warm serif headlines; "bold" geometric, high contrast. */
[data-style="editorial"] { --font-display: 'Fraunces', Georgia, serif; --display-weight: 600; --display-track: -0.015em; --bg: #faf7f2; --surface-2: #f3eee6; --line: #e8e1d6; }
[data-style="bold"] { --font-display: 'Space Grotesk', var(--font); --display-weight: 700; --display-track: -0.035em; --radius: 18px; }

@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #0c0c0e; --surface: #16161a; --surface-2: #1d1d22; --text: #f4f4f5; --muted: #a1a1aa; --line: #2a2a31;
    --accent-soft: color-mix(in oklab, var(--accent) 22%, transparent); --shadow: 0 1px 2px rgb(0 0 0 / .4); --shadow-lg: 0 24px 60px -20px rgb(0 0 0 / .7); }
  :root[data-style="editorial"]:not([data-theme="light"]) { --bg: #12100e; --surface: #1b1815; --surface-2: #231f1b; --line: #332d27; }
}
:root[data-theme="dark"] { --bg: #0c0c0e; --surface: #16161a; --surface-2: #1d1d22; --text: #f4f4f5; --muted: #a1a1aa; --line: #2a2a31; --accent-soft: color-mix(in oklab, var(--accent) 22%, transparent); --shadow: 0 1px 2px rgb(0 0 0 / .4); }

/* ---- base */
*, *::before, *::after { box-sizing: border-box; }
html { -webkit-text-size-adjust: 100%; scroll-behavior: smooth; }
body { margin: 0; background: var(--bg); color: var(--text); font: 400 var(--fs-body)/1.6 var(--font); -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility; }
img, svg, video { display: block; max-width: 100%; height: auto; }
h1, h2, h3, h4 { margin: 0; line-height: 1.12; font-family: var(--font-display); font-weight: var(--display-weight); letter-spacing: var(--display-track); text-wrap: balance; }
h1 { font-size: var(--fs-h1); } h2 { font-size: var(--fs-h2); } h3 { font-size: var(--fs-h3); line-height: 1.3; letter-spacing: -0.01em; }
p { margin: 0; text-wrap: pretty; } p + p { margin-top: var(--s4); }
a { color: var(--accent); text-underline-offset: 3px; text-decoration-thickness: 1px; }
a:hover { text-decoration-thickness: 2px; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; border-radius: 6px; }
::selection { background: var(--accent-soft); }
small, .small { font-size: var(--fs-sm); }
.muted { color: var(--muted); }
.lede { font-size: var(--fs-lead); color: var(--muted); max-width: 46ch; line-height: 1.5; }
.eyebrow { font-size: 0.78rem; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--accent); }
.prose { max-width: var(--measure); } .prose h2 { margin: var(--s7) 0 var(--s3); } .prose h3 { margin: var(--s6) 0 var(--s2); }
.prose ul, .prose ol { padding-left: 1.2em; } .prose li + li { margin-top: var(--s2); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }

/* ---- layout primitives */
.container { width: min(100% - 2 * var(--s5), var(--container)); margin-inline: auto; }
.narrow { width: min(100% - 2 * var(--s5), 760px); margin-inline: auto; }
.section { padding-block: clamp(var(--s7), 8vw, var(--s9)); }
.section-head { display: grid; gap: var(--s3); margin-bottom: var(--s6); max-width: 640px; }
.stack { display: flex; flex-direction: column; gap: var(--gap, var(--s4)); }
.cluster { display: flex; flex-wrap: wrap; align-items: center; gap: var(--gap, var(--s3)); }
.grid { display: grid; gap: var(--gap, var(--s5)); grid-template-columns: repeat(auto-fit, minmax(min(100%, var(--min, 260px)), 1fr)); }
.split { display: grid; gap: var(--s7); align-items: center; } @media (min-width: 880px) { .split { grid-template-columns: 1.1fr 1fr; } }

/* ---- top bar */
.topbar { position: sticky; top: 0; z-index: 20; background: color-mix(in oklab, var(--bg) 82%, transparent); backdrop-filter: saturate(1.4) blur(14px); -webkit-backdrop-filter: saturate(1.4) blur(14px); border-bottom: 1px solid var(--line); }
.topbar .container { display: flex; align-items: center; justify-content: space-between; gap: var(--s4); min-height: 64px; }
.brand { display: inline-flex; align-items: center; gap: var(--s2); font-weight: 700; letter-spacing: -0.01em; color: var(--text); text-decoration: none; font-size: 1.05rem; }
.brand-mark { width: 28px; height: 28px; border-radius: 8px; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; font-size: .8rem; font-weight: 800; }
.nav-links { display: none; gap: var(--s5); } .nav-links a { color: var(--muted); text-decoration: none; font-weight: 500; font-size: .95rem; } .nav-links a:hover { color: var(--text); }
@media (min-width: 760px) { .nav-links { display: flex; } }

/* ---- buttons */
.btn { display: inline-flex; align-items: center; justify-content: center; gap: var(--s2); min-height: 46px; padding: 0 var(--s5); border-radius: var(--radius-pill); border: 1px solid transparent; font: 600 0.98rem/1 var(--font); text-decoration: none; cursor: pointer; transition: transform .15s var(--ease), background-color .2s var(--ease), box-shadow .2s var(--ease), border-color .2s; white-space: nowrap; }
.btn:active { transform: scale(.97); }
.btn-primary { background: var(--accent); color: var(--accent-ink); box-shadow: 0 1px 0 rgb(255 255 255 / .15) inset, 0 6px 18px -8px var(--accent); }
.btn-primary:hover { background: color-mix(in oklab, var(--accent) 88%, black); text-decoration: none; }
.btn-ghost { background: var(--surface); color: var(--text); border-color: var(--line); } .btn-ghost:hover { border-color: color-mix(in oklab, var(--text) 30%, var(--line)); text-decoration: none; }
.btn-quiet { background: transparent; color: var(--text); padding-inline: var(--s3); } .btn-quiet:hover { background: var(--surface-2); }
.btn-sm { min-height: 38px; padding: 0 var(--s4); font-size: .9rem; }
.btn-block { width: 100%; }
.icon-btn { width: 44px; height: 44px; display: inline-grid; place-items: center; border-radius: 12px; border: 0; background: transparent; color: var(--text); cursor: pointer; } .icon-btn:hover { background: var(--surface-2); }
.icon { width: 20px; height: 20px; flex: none; stroke: currentColor; fill: none; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

/* ---- hero */
.hero { padding-block: clamp(var(--s7), 10vw, 128px) clamp(var(--s7), 8vw, var(--s9)); }
.hero h1 { max-width: 15ch; margin-block: var(--s3) var(--s5); }
.hero .lede { margin-bottom: var(--s6); }
.hero-visual { aspect-ratio: 4 / 3.4; border-radius: calc(var(--radius) + 8px); background: radial-gradient(120% 90% at 20% 10%, color-mix(in oklab, var(--accent) 35%, var(--surface)) 0%, var(--surface-2) 60%); border: 1px solid var(--line); box-shadow: var(--shadow-lg); overflow: hidden; }
.hero-visual img { width: 100%; height: 100%; object-fit: cover; }

/* ---- cards and surfaces */
.card { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s5); box-shadow: var(--shadow); }
.card h3 { margin-bottom: var(--s2); } .card p { color: var(--muted); }
.card-icon { width: 40px; height: 40px; border-radius: 12px; display: grid; place-items: center; background: var(--accent-soft); color: var(--accent); margin-bottom: var(--s4); }
.card-link { display: block; color: inherit; text-decoration: none; transition: transform .2s var(--ease), box-shadow .2s var(--ease); } .card-link:hover { transform: translateY(-2px); box-shadow: var(--shadow-lg); }
.panel { background: var(--surface-2); border-radius: calc(var(--radius) + 6px); padding: clamp(var(--s5), 5vw, var(--s7)); }
.callout { border-left: 3px solid var(--accent); background: var(--accent-soft); padding: var(--s4) var(--s5); border-radius: 0 var(--radius-sm) var(--radius-sm) 0; }
.badge { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--radius-pill); background: var(--surface-2); border: 1px solid var(--line); font-size: .8rem; font-weight: 600; color: var(--muted); }
.badge-accent { background: var(--accent-soft); color: var(--accent); border-color: transparent; }
.badge-good { color: var(--good); } .badge-bad { color: var(--bad); }
.divider { height: 1px; background: var(--line); border: 0; margin: var(--s6) 0; }

/* ---- facts and numbers */
.facts { display: grid; gap: 0; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); overflow: hidden; }
.fact { display: flex; justify-content: space-between; gap: var(--s4); padding: var(--s4) var(--s5); border-top: 1px solid var(--line); } .fact:first-child { border-top: 0; }
.fact dt { color: var(--muted); } .fact dd { margin: 0; font-weight: 600; text-align: right; }
.stats { display: grid; gap: var(--s4); grid-template-columns: repeat(auto-fit, minmax(min(100%, 150px), 1fr)); }
.stat { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: var(--s5); }
.stat-label { font-size: var(--fs-sm); color: var(--muted); font-weight: 500; }
.stat-value { font-family: var(--font-display); font-size: clamp(1.75rem, 1.4rem + 1.4vw, 2.4rem); font-weight: var(--display-weight); letter-spacing: -0.03em; line-height: 1.1; margin-top: var(--s2); font-variant-numeric: tabular-nums; }
.stat-delta { font-size: var(--fs-sm); font-weight: 600; margin-top: var(--s1); } .up { color: var(--good); } .down { color: var(--bad); }
.bar { height: 8px; border-radius: 99px; background: var(--surface-2); overflow: hidden; } .bar > span { display: block; height: 100%; background: var(--accent); border-radius: inherit; }
.table-wrap { overflow-x: auto; border: 1px solid var(--line); border-radius: var(--radius); background: var(--surface); }
table { width: 100%; border-collapse: collapse; font-size: .95rem; font-variant-numeric: tabular-nums; }
th, td { text-align: left; padding: var(--s3) var(--s4); border-bottom: 1px solid var(--line); } th { font-size: var(--fs-sm); color: var(--muted); font-weight: 600; background: var(--surface-2); }
tr:last-child td { border-bottom: 0; } td.num, th.num { text-align: right; }

/* ---- forms */
.field { display: grid; gap: var(--s2); } .field label { font-weight: 600; font-size: .92rem; }
.input, select, textarea { width: 100%; min-height: 48px; padding: var(--s3) var(--s4); border-radius: var(--radius-sm); border: 1px solid var(--line); background: var(--surface); color: var(--text); font: inherit; transition: border-color .15s, box-shadow .15s; }
.input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 4px var(--accent-soft); }
.check { appearance: none; width: 26px; height: 26px; border-radius: 8px; border: 2px solid var(--line); display: grid; place-items: center; cursor: pointer; transition: all .15s var(--ease); flex: none; background: var(--surface); }
.check:checked { background: var(--accent); border-color: var(--accent); }
.check:checked::after { content: ''; width: 7px; height: 12px; border: solid var(--accent-ink); border-width: 0 2.5px 2.5px 0; transform: translateY(-1px) rotate(45deg); }

/* ---- app shell (phone-first web apps, Capacitor) */
.app { min-height: 100dvh; display: flex; flex-direction: column; max-width: 560px; margin-inline: auto; background: var(--bg); }
.appbar { position: sticky; top: 0; z-index: 10; padding: calc(env(safe-area-inset-top) + var(--s3)) var(--s5) var(--s3); background: color-mix(in oklab, var(--bg) 85%, transparent); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); display: flex; align-items: center; justify-content: space-between; gap: var(--s3); }
.appbar h1 { font-size: 1.75rem; letter-spacing: -0.03em; }
.app-main { flex: 1; padding: var(--s2) var(--s5) calc(env(safe-area-inset-bottom) + 112px); display: flex; flex-direction: column; gap: var(--s5); }
.list { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); overflow: hidden; }
.row { display: flex; align-items: center; gap: var(--s4); min-height: 64px; padding: var(--s3) var(--s4); border-top: 1px solid var(--line); } .row:first-child { border-top: 0; }
.row-main { flex: 1; min-width: 0; } .row-title { font-weight: 600; } .row-sub { font-size: var(--fs-sm); color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.list-label { font-size: var(--fs-sm); font-weight: 600; color: var(--muted); margin: 0 var(--s1) calc(-1 * var(--s3)); }
.tabbar { position: fixed; left: 50%; transform: translateX(-50%); bottom: 0; width: min(100%, 560px); display: flex; justify-content: space-around; padding: var(--s2) var(--s4) calc(env(safe-area-inset-bottom) + var(--s2)); background: color-mix(in oklab, var(--surface) 88%, transparent); backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px); border-top: 1px solid var(--line); z-index: 10; }
.tab { flex: 1; display: grid; justify-items: center; gap: 2px; min-height: 52px; padding-top: 6px; border: 0; background: none; color: var(--muted); font: 500 .72rem var(--font); cursor: pointer; } .tab[aria-current="page"] { color: var(--accent); }
.fab { position: fixed; right: max(var(--s5), calc(50% - 280px + var(--s5))); bottom: calc(env(safe-area-inset-bottom) + 84px); width: 58px; height: 58px; border-radius: 18px; border: 0; background: var(--accent); color: var(--accent-ink); display: grid; place-items: center; box-shadow: var(--shadow-lg); cursor: pointer; z-index: 11; transition: transform .15s var(--ease); } .fab:active { transform: scale(.94); }
.sheet-backdrop { position: fixed; inset: 0; background: rgb(0 0 0 / .35); opacity: 0; pointer-events: none; transition: opacity .2s; z-index: 30; }
.sheet { position: fixed; left: 50%; bottom: 0; width: min(100%, 560px); transform: translate(-50%, 105%); background: var(--surface); border-radius: 22px 22px 0 0; padding: var(--s3) var(--s5) calc(env(safe-area-inset-bottom) + var(--s5)); transition: transform .28s var(--ease); z-index: 31; box-shadow: var(--shadow-lg); }
.sheet::before { content: ''; display: block; width: 40px; height: 5px; border-radius: 9px; background: var(--line); margin: 0 auto var(--s4); }
.sheet-open .sheet { transform: translate(-50%, 0); } .sheet-open .sheet-backdrop { opacity: 1; pointer-events: auto; }
.empty { text-align: center; padding: var(--s8) var(--s5); display: grid; justify-items: center; gap: var(--s3); color: var(--muted); }
.empty .card-icon { width: 56px; height: 56px; border-radius: 18px; margin: 0; }
.empty h2 { font-size: 1.25rem; color: var(--text); letter-spacing: -0.01em; }
.chips { display: flex; gap: var(--s2); overflow-x: auto; scrollbar-width: none; } .chip { flex: none; height: 36px; padding: 0 14px; border-radius: 99px; border: 1px solid var(--line); background: var(--surface); color: var(--text); font: 500 .9rem var(--font); cursor: pointer; } .chip[aria-pressed="true"] { background: var(--text); color: var(--bg); border-color: var(--text); }
.toast { position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom) + 150px); transform: translate(-50%, 20px); background: var(--text); color: var(--bg); padding: var(--s3) var(--s5); border-radius: 99px; font-weight: 500; opacity: 0; transition: all .25s var(--ease); pointer-events: none; z-index: 40; } .toast.show { opacity: 1; transform: translate(-50%, 0); }

/* ---- footer */
.footer { border-top: 1px solid var(--line); padding-block: var(--s7); color: var(--muted); font-size: var(--fs-sm); }
.footer .container { display: flex; flex-wrap: wrap; justify-content: space-between; gap: var(--s4); }

/* ---- motion: gentle entrance; off for people who ask for less motion */
.reveal { animation: rise .6s var(--ease) both; } .reveal:nth-child(2) { animation-delay: .06s; } .reveal:nth-child(3) { animation-delay: .12s; }
@keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }
@media print { .topbar, .tabbar, .fab, .no-print { display: none !important; } body { background: #fff; color: #000; } .card, .stat, .table-wrap { box-shadow: none; break-inside: avoid; } }
`;

const ICONS = {
  arrow: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6"/></svg>',
  plus: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>',
  check: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 5 5L20 7"/></svg>',
  clock: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>',
  pin: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11a7 7 0 0 1 14 0c0 4.8-7 11-7 11z"/><circle cx="12" cy="10" r="2.5"/></svg>',
  chat: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/></svg>',
  spark: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2.5 2.5M15.5 15.5 18 18M6 18l2.5-2.5M15.5 8.5 18 6"/></svg>',
  home: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 11 12 4l8 7v9a1 1 0 0 1-1 1h-5v-6h-4v6H5a1 1 0 0 1-1-1z"/></svg>',
  chart: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>',
  gear: '<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/></svg>',
};
export const KIT_ICONS = ICONS;

const head = (title: string, style: KitStyle, extra = '') =>
  `<!doctype html>
<html lang="en" data-style="${style}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <title>${title}</title>
  <meta name="description" content="REPLACE: one sentence on what this is">
  <meta name="theme-color" content="#fafaf9" media="(prefers-color-scheme: light)">
  <meta name="theme-color" content="#0c0c0e" media="(prefers-color-scheme: dark)">
  <link rel="stylesheet" href="kit.css">${extra}
</head>`;

/** Landing page: top bar, hero, what-you-get cards, details, closing call to action, footer. */
const LANDING = (style: KitStyle) => `${head('REPLACE Brand: what it is in a few words', style, '\n  <style>\n    :root { --accent: #4f46e5; } /* REPLACE with the brand colour */\n  </style>')}
<body>
  <header class="topbar">
    <div class="container">
      <a class="brand" href="#top"><span class="brand-mark">B</span>REPLACE Brand</a>
      <nav class="nav-links" aria-label="Main"><a href="#about">About</a><a href="#visit">Visit</a></nav>
      <a class="btn btn-primary btn-sm" href="REPLACE real link: https://wa.me/..., tel:, mailto: or a page">REPLACE action</a>
    </div>
  </header>
  <main id="top">
    <section class="hero">
      <div class="container split">
        <div class="reveal">
          <span class="eyebrow">REPLACE place or category</span>
          <h1>REPLACE a specific headline, 4 to 8 words</h1>
          <p class="lede">REPLACE one or two sentences: what it is, for whom, why it is different. Only facts the user gave.</p>
          <div class="cluster">
            <a class="btn btn-primary" href="REPLACE real link">REPLACE main action ${ICONS.arrow}</a>
            <a class="btn btn-ghost" href="#visit">REPLACE second action</a>
          </div>
        </div>
        <div class="hero-visual reveal" role="img" aria-label="REPLACE describe the image"><!-- REPLACE with <img src="hero.jpg" alt="..."> made by generate_image, or keep the gradient --></div>
      </div>
    </section>

    <section class="section" id="about">
      <div class="container">
        <div class="section-head"><span class="eyebrow">REPLACE</span><h2>REPLACE what people get, as a claim</h2></div>
        <div class="grid" style="--min: 240px">
          <article class="card"><div class="card-icon">${ICONS.spark}</div><h3>REPLACE real point</h3><p>REPLACE one or two sentences from the user's facts.</p></article>
          <article class="card"><div class="card-icon">${ICONS.clock}</div><h3>REPLACE real point</h3><p>REPLACE</p></article>
          <article class="card"><div class="card-icon">${ICONS.chat}</div><h3>REPLACE real point</h3><p>REPLACE</p></article>
        </div>
      </div>
    </section>

    <section class="section" id="visit">
      <div class="container split">
        <div class="stack" style="--gap: var(--s4)"><span class="eyebrow">REPLACE Visit / Details</span><h2>REPLACE</h2><p class="lede">REPLACE</p></div>
        <dl class="facts">
          <div class="fact"><dt>REPLACE Hours</dt><dd>REPLACE</dd></div>
          <div class="fact"><dt>REPLACE Where</dt><dd>REPLACE</dd></div>
          <div class="fact"><dt>REPLACE Contact</dt><dd><a href="REPLACE real link">REPLACE</a></dd></div>
        </dl>
      </div>
    </section>

    <section class="section">
      <div class="container"><div class="panel cluster" style="justify-content: space-between"><h2 style="max-width: 18ch">REPLACE closing line</h2><a class="btn btn-primary" href="REPLACE real link">REPLACE main action ${ICONS.arrow}</a></div></div>
    </section>
  </main>
  <footer class="footer"><div class="container"><span>REPLACE Brand · REPLACE place</span><span>REPLACE one real detail</span></div></footer>
</body>
</html>
`;

/** Phone-first app: app bar, filter chips, list with rows, empty state, FAB, bottom sheet form, tab bar. */
const APP = (style: KitStyle) => `${head('REPLACE App name', style, '\n  <meta name="apple-mobile-web-app-capable" content="yes">\n  <style>\n    :root { --accent: #4f46e5; } /* REPLACE */\n  </style>')}
<body>
  <div class="app">
    <header class="appbar">
      <div><div class="small muted" id="today"></div><h1>REPLACE Screen title</h1></div>
      <button class="icon-btn" aria-label="Settings">${ICONS.gear}</button>
    </header>
    <main class="app-main">
      <!-- REPLACE: a summary card for the one number that matters on this screen -->
      <section class="card" aria-label="Summary"><div class="stat-label">REPLACE label</div><div class="stat-value" id="summary">0</div><div class="bar" style="margin-top: var(--s3)"><span id="progress" style="width: 0%"></span></div></section>
      <div class="list-label">REPLACE section</div>
      <section class="list" id="list" aria-live="polite"></section>
      <section class="empty" id="empty" hidden><div class="card-icon">${ICONS.plus}</div><h2>REPLACE nothing here yet</h2><p>REPLACE one line on the first step.</p><button class="btn btn-primary" data-open-sheet>REPLACE Add the first one</button></section>
    </main>
    <button class="fab" aria-label="REPLACE Add" data-open-sheet>${ICONS.plus}</button>
    <nav class="tabbar" aria-label="Tabs">
      <button class="tab" aria-current="page">${ICONS.home}REPLACE Today</button>
      <button class="tab">${ICONS.chart}REPLACE Stats</button>
      <button class="tab">${ICONS.gear}REPLACE Settings</button>
    </nav>
    <div class="sheet-backdrop" data-close-sheet></div>
    <form class="sheet stack" id="sheet" aria-label="REPLACE Add">
      <h2 style="font-size: 1.3rem">REPLACE New item</h2>
      <div class="field"><label for="name">REPLACE Name</label><input class="input" id="name" required autocomplete="off" placeholder="REPLACE e.g. ..."></div>
      <button class="btn btn-primary btn-block" type="submit">REPLACE Save</button>
    </form>
    <div class="toast" id="toast" role="status"></div>
  </div>
  <script>
    // REPLACE: the app's real data model. Saved in localStorage so it survives a reload.
    const KEY = 'REPLACE-app-v1';
    const state = JSON.parse(localStorage.getItem(KEY) || '{"items":[]}');
    const save = () => localStorage.setItem(KEY, JSON.stringify(state));
    const $ = (s) => document.querySelector(s);
    $('#today').textContent = new Date().toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
    function toast(t) { const el = $('#toast'); el.textContent = t; el.classList.add('show'); setTimeout(() => el.classList.remove('show'), 1800); }
    function render() {
      const list = $('#list');
      list.innerHTML = '';
      $('#empty').hidden = state.items.length > 0;
      list.hidden = state.items.length === 0;
      state.items.forEach((it, i) => {
        const row = document.createElement('label');
        row.className = 'row';
        row.innerHTML = '<input type="checkbox" class="check"><div class="row-main"><div class="row-title"></div><div class="row-sub"></div></div>';
        row.querySelector('.row-title').textContent = it.name;
        row.querySelector('.row-sub').textContent = it.done ? 'Done' : 'Not yet';
        const cb = row.querySelector('input'); cb.checked = !!it.done;
        cb.addEventListener('change', () => { it.done = cb.checked; save(); render(); });
        list.appendChild(row);
      });
      const done = state.items.filter((x) => x.done).length;
      $('#summary').textContent = done + ' / ' + state.items.length;
      $('#progress').style.width = (state.items.length ? (100 * done) / state.items.length : 0) + '%';
    }
    const openSheet = () => { document.body.classList.add('sheet-open'); setTimeout(() => $('#name').focus(), 250); };
    const closeSheet = () => document.body.classList.remove('sheet-open');
    document.querySelectorAll('[data-open-sheet]').forEach((b) => b.addEventListener('click', openSheet));
    document.querySelectorAll('[data-close-sheet]').forEach((b) => b.addEventListener('click', closeSheet));
    $('#sheet').addEventListener('submit', (e) => { e.preventDefault(); const name = $('#name').value.trim(); if (!name) return; state.items.push({ name, done: false }); save(); $('#name').value = ''; closeSheet(); render(); toast('Added'); });
    render();
  </script>
</body>
</html>
`;

/** One-page report: title, date, the verdict first, key numbers, short sections, a table, sources. */
const REPORT = (style: KitStyle) => `${head('REPLACE Report title', style, '\n  <style>\n    :root { --accent: #0f766e; } /* REPLACE */\n  </style>')}
<body>
  <main class="narrow" style="padding-block: clamp(32px, 7vw, 88px)">
    <header class="stack" style="--gap: var(--s3); margin-bottom: var(--s7)">
      <span class="eyebrow">REPLACE Organisation · Period</span>
      <h1 style="font-size: clamp(2rem, 1.5rem + 2.4vw, 3rem)">REPLACE the headline finding as a sentence</h1>
      <p class="lede" style="max-width: 60ch">REPLACE two sentences: the answer first, then the one thing to watch. Use only the numbers given.</p>
      <div class="cluster small muted"><span>REPLACE Prepared date</span><span aria-hidden="true">·</span><span>REPLACE Source of the numbers</span></div>
    </header>

    <section class="stats" aria-label="Key numbers" style="margin-bottom: var(--s7)">
      <div class="stat"><div class="stat-label">REPLACE</div><div class="stat-value">REPLACE</div><div class="stat-delta up">REPLACE +x% vs last period</div></div>
      <div class="stat"><div class="stat-label">REPLACE</div><div class="stat-value">REPLACE</div></div>
      <div class="stat"><div class="stat-label">REPLACE</div><div class="stat-value">REPLACE</div></div>
      <div class="stat"><div class="stat-label">REPLACE</div><div class="stat-value">REPLACE</div><div class="stat-delta down">REPLACE</div></div>
    </section>

    <article class="prose">
      <h2>REPLACE what went well (a claim, not a label)</h2>
      <p>REPLACE short paragraph with the numbers that prove it.</p>
      <h2>REPLACE what to watch</h2>
      <div class="callout"><p>REPLACE the risk in one or two sentences.</p></div>
    </article>

    <section style="margin-top: var(--s7)">
      <h2 style="font-size: 1.35rem; margin-bottom: var(--s4)">REPLACE Comparison</h2>
      <div class="table-wrap"><table>
        <thead><tr><th>REPLACE Metric</th><th class="num">REPLACE Before</th><th class="num">REPLACE Now</th><th class="num">Change</th></tr></thead>
        <tbody><tr><td>REPLACE</td><td class="num">REPLACE</td><td class="num">REPLACE</td><td class="num up">REPLACE</td></tr></tbody>
      </table></div>
    </section>

    <footer class="small muted" style="margin-top: var(--s8); border-top: 1px solid var(--line); padding-top: var(--s5)">REPLACE Sources and notes: where each number came from. Leave out what you do not have.</footer>
  </main>
</body>
</html>
`;

/** A document or article page (notes, guides, plans): readable column, headings that say something. */
const DOC = (style: KitStyle) => `${head('REPLACE Document title', style)}
<body>
  <main class="narrow" style="padding-block: clamp(32px, 7vw, 88px)">
    <header class="stack" style="--gap: var(--s3); margin-bottom: var(--s6)">
      <span class="eyebrow">REPLACE Type of document</span>
      <h1 style="font-size: clamp(2rem, 1.5rem + 2.2vw, 2.8rem)">REPLACE Title that says what it is</h1>
      <p class="lede" style="max-width: 62ch">REPLACE the answer or the point of the document, in one or two sentences.</p>
    </header>
    <article class="prose">
      <h2>REPLACE section heading that makes a point</h2>
      <p>REPLACE short paragraphs, three to five sentences each.</p>
      <ul><li>REPLACE bullets only for three or more parallel items</li></ul>
    </article>
    <footer class="small muted" style="margin-top: var(--s8); border-top: 1px solid var(--line); padding-top: var(--s5)">REPLACE Sources: real links only.</footer>
  </main>
</body>
</html>
`;

/** The same tokens for Expo / React Native screens (theme.ts). */
export const RN_THEME = `// theme.ts - Orin design kit tokens for React Native / Expo. Use these instead of ad-hoc values.
import { useColorScheme } from 'react-native';
const light = { bg: '#fafaf9', surface: '#ffffff', surface2: '#f4f4f2', text: '#18181b', muted: '#5f5f68', line: '#e7e5e4', accent: '#4f46e5', accentInk: '#ffffff', accentSoft: 'rgba(79,70,229,0.12)', good: '#15803d', bad: '#b91c1c' };
const dark = { ...light, bg: '#0c0c0e', surface: '#16161a', surface2: '#1d1d22', text: '#f4f4f5', muted: '#a1a1aa', line: '#2a2a31', accentSoft: 'rgba(79,70,229,0.22)' };
export const space = { s1: 4, s2: 8, s3: 12, s4: 16, s5: 24, s6: 32, s7: 48, s8: 72 };
export const radius = { sm: 10, md: 14, lg: 22, pill: 999 };
export const type = {
  h1: { fontSize: 32, lineHeight: 36, fontWeight: '800' as const, letterSpacing: -0.8 },
  h2: { fontSize: 24, lineHeight: 29, fontWeight: '700' as const, letterSpacing: -0.4 },
  h3: { fontSize: 18, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 16, lineHeight: 24 },
  small: { fontSize: 13, lineHeight: 18 },
  label: { fontSize: 12, lineHeight: 16, fontWeight: '600' as const, letterSpacing: 0.8, textTransform: 'uppercase' as const },
};
export const shadow = { shadowColor: '#000', shadowOpacity: 0.08, shadowRadius: 18, shadowOffset: { width: 0, height: 6 }, elevation: 3 };
export const touch = 44; // minimum touch target
export function useTheme() { const c = useColorScheme() === 'dark' ? dark : light; return { c, space, radius, type, shadow, touch }; }
`;

export function kitTemplate(kind: KitKind, style: KitStyle = 'clean'): string {
  return kind === 'landing' ? LANDING(style) : kind === 'app' ? APP(style) : kind === 'report' ? REPORT(style) : DOC(style);
}

/** The design skill, as prompt lines. Replaces the older generic design standards. */
export const DESIGN_SKILL: string[] = [
  '## Design skill (always on: the user never has to ask for "modern" or "polished")',
  'Everything visual you make (website, web app, phone app screen, report, document page) should look like a current product from a top studio (Linear, Stripe, Apple, Sesame): calm, confident, spacious, easy to scan on a phone. Never a template-looking or 2010s page.',
  'Start from your kit, every time: call design_kit first with the closest kind (landing, app, report, doc) and a style (clean = neutral product look; editorial = warm, serif headlines, for food, craft, culture, writing; bold = geometric, high contrast, for tech, fitness, events). It writes kit.css (tokens, type scale, spacing, buttons, cards, lists, stats, tables, app shell, tab bar, sheet, dark mode) and a starter index.html. Fill in the starter: replace every REPLACE, delete sections you have no real content for, set --accent to one brand colour, and add only small page-specific CSS in style.css. Do not write a design system from scratch. For Expo/React Native use design_kit kind "rn-theme" and build every screen from theme.ts.',
  'The principles behind the kit:',
  '- Lead with the point. A landing page opens with what it is and the main action; an app screen with the one thing the user came to do; a report with the finding as a sentence and the key numbers. Nothing important below a wall of decoration.',
  '- Hierarchy by type and space, not boxes and colours: one h1, a lede in the muted colour, headings that make a claim ("Roasted in small batches every morning", not "About Us"), generous space between sections, body text 16-17px at 1.6 line height, lines under ~70 characters.',
  '- One accent colour, used sparingly: primary buttons, links, focus, one highlight. Neutrals for everything else. Light and dark both work (the kit does it; check both). No rainbow gradients, no glow, no more than two font families.',
  '- Shared components only: kit classes (.btn-primary, .btn-ghost, .card, .facts, .stats, .list/.row, .tabbar, .fab, .sheet, .badge, .callout, .table-wrap). Same radius, spacing and shadow everywhere. Icons are inline SVG line icons (the kit has some); never emoji as icons or bullets.',
  '- Mobile first: design at 390px, then make sure 1280px looks intentional. Touch targets at least 44px, primary actions within thumb reach in apps, no sideways scrolling.',
  '- Scannable: short sections, one idea each; cards only for groups of parallel things (3-6); key facts (hours, place, price, contact) as a facts list, not buried in paragraphs; numbers in stat cards or a table.',
  '- No filler and no invented details: no lorem ipsum, fake testimonials, made-up stats, prices, menus, team members, addresses or awards. Use what the user gave; leave out sections you have nothing real for, and ask for missing details in one short line in your reply. Every link and button goes somewhere real (WhatsApp wa.me link, tel:, mailto:, a real page or an in-app action); no href="#" dead ends and no forms that submit nowhere.',
  '- Images: generate one with generate_image when a picture really helps (hero, product), or use the kit\'s gradient visual. Never hotlink stock photo URLs or placeholder image services; they break.',
  '- Apps feel finished: empty state with one action, data saved in localStorage, a toast or visible change after every action, a bottom sheet for forms, a tab bar only when there are real sections.',
  '- Reports and document pages: title that states the finding, a two-sentence lede, 3-4 stat cards, short sections, one table if comparing, sources at the bottom. Notes and markdown files follow the same rule: answer first, headings that say something, short paragraphs, bullets only for 3+ parallel items.',
  'Reference sites: when the user names a site, app or brand to look like ("like stripe.com", "same theme as Airbnb", a link), do not ask them to describe it. Call study_reference with the name or address (it finds the site, opens it, screenshots and measures it), build from the brief with design_kit and the reference\'s tokens, fonts, section order and components, using the user\'s own content, then compare_to_reference and fix the differences until it scores 8/10 (up to three rounds) before review_design. Copy the design, never their logo, photos, illustrations or wording unless it is the user\'s own site; say so in one line if they asked for that. In your reply, name the reference and say how close it got.',
  'Then check it like a designer: review_design on every page or screen you built or changed. It scores against this skill and passes at 8/10. Fix every high and medium issue, review again (up to three rounds), and only then share the link or build the APK. If the user gives a style, a brand or a reference, follow it over these defaults and save it with learn_lesson.',
];
