/**
 * Deep research written up as a page (Sesame-style): the report the model wrote in Markdown,
 * turned into the Sky/Ink page body with numbered citations that jump to a sources list.
 * Only a small, safe Markdown subset is rendered and every bit of text is escaped, so a
 * source quoted in the report can never inject markup into the page.
 */

export interface ResearchSource {
  n: number;
  title: string;
  url: string;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const safeUrl = (u: string) => (/^https?:\/\//i.test(u.trim()) ? u.trim() : '');

function hostOf(u: string): string {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}

/** Inline Markdown: code, links, bold, italics and [1] / [1, 3] / [1][2] citations. Input is raw text. */
export function inline(md: string, maxSource = 0): string {
  const codes: string[] = [];
  let s = md.replace(/`([^`]+)`/g, (_m, c: string) => `\u0000${codes.push(`<code>${esc(c)}</code>`) - 1}\u0000`);
  const links: string[] = [];
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t: string, u: string) => `\u0001${links.push(`<a href="${esc(safeUrl(u))}" target="_blank" rel="noopener">${esc(t)}</a>`) - 1}\u0001`);
  s = esc(s);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/g, '$1<em>$2</em>');
  // citations: [1], [1, 3], [2-4]
  s = s.replace(/\[(\d{1,2}(?:\s*[,–-]\s*\d{1,2})*)\]/g, (m, inner: string) => {
    const nums: number[] = [];
    for (const part of inner.split(/\s*,\s*/)) {
      const r = part.split(/\s*[–-]\s*/).map(Number);
      if (r.length === 2 && r[1]! >= r[0]! && r[1]! - r[0]! < 10) for (let i = r[0]!; i <= r[1]!; i++) nums.push(i);
      else nums.push(r[0]!);
    }
    if (!nums.length || (maxSource && nums.some((x) => x < 1 || x > maxSource))) return m;
    return nums.map((x) => `<a class="cite" href="#s${x}">${x}</a>`).join('');
  });
  s = s.replace(/\u0001(\d+)\u0001/g, (_m, i: string) => links[Number(i)]!).replace(/\u0000(\d+)\u0000/g, (_m, i: string) => codes[Number(i)]!);
  return s;
}

/** Block Markdown: headings, bullet and numbered lists, quotes, code blocks, tables, paragraphs. */
export function markdownToHtml(md: string, maxSource = 0): string {
  const lines = md.replace(/\r/g, '').split('\n');
  const out: string[] = [];
  let para: string[] = [];
  let list: { tag: 'ul' | 'ol'; items: string[] } | null = null;
  const flushPara = () => {
    if (para.length) out.push(`<p>${inline(para.join(' '), maxSource)}</p>`);
    para = [];
  };
  const flushList = () => {
    if (list) out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i, maxSource)}</li>`).join('')}</${list.tag}>`);
    list = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const t = line.trim();
    if (/^```/.test(t)) {
      flushPara();
      flushList();
      const code: string[] = [];
      for (i++; i < lines.length && !/^```/.test(lines[i]!.trim()); i++) code.push(lines[i]!);
      out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    if (!t) {
      flushPara();
      flushList();
      continue;
    }
    const h = /^(#{1,4})\s+(.*)$/.exec(t);
    if (h) {
      flushPara();
      flushList();
      const lvl = Math.min(h[1]!.length + 1, 4); // the page title is the only h1
      out.push(`<h${lvl}>${inline(h[2]!.replace(/#+\s*$/, ''), maxSource)}</h${lvl}>`);
      continue;
    }
    if (/^\|.*\|$/.test(t) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1]!.trim())) {
      flushPara();
      flushList();
      const cells = (row: string) => row.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
      const head = cells(t);
      const rows: string[][] = [];
      for (i += 2; i < lines.length && /^\|.*\|$/.test(lines[i]!.trim()); i++) rows.push(cells(lines[i]!));
      i--;
      out.push(`<table><thead><tr>${head.map((c) => `<th>${inline(c, maxSource)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c, maxSource)}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const ul = /^[-*•]\s+(.*)$/.exec(t);
    const ol = /^\d+[.)]\s+(.*)$/.exec(t);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul ?? ol)![1]!);
      continue;
    }
    if (list && /^\s{2,}/.test(line)) {
      list.items[list.items.length - 1] += ` ${t}`;
      continue;
    }
    if (/^>\s?/.test(t)) {
      flushPara();
      flushList();
      out.push(`<blockquote>${inline(t.replace(/^>\s?/, ''), maxSource)}</blockquote>`);
      continue;
    }
    if (/^(-{3,}|\*{3,})$/.test(t)) {
      flushPara();
      flushList();
      continue;
    }
    flushList();
    para.push(t);
  }
  flushPara();
  flushList();
  return out.join('\n');
}

const PAGE_CSS = `
.eyebrow{font-size:12px;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:0 0 6px}
.meta{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 18px}
.summary{border-left:4px solid var(--sky);}
.summary h2{margin-top:0;font-size:20px}
a.cite{display:inline-block;min-width:18px;height:18px;padding:0 5px;margin:0 1px;border-radius:9px;font-size:11px;line-height:18px;text-align:center;vertical-align:super;text-decoration:none;background:color-mix(in srgb,var(--sky) 26%,transparent);color:var(--text)}
ol.sources{list-style:none;padding:0;margin:0}
ol.sources li{display:flex;gap:12px;padding:12px 0;border-bottom:1px solid var(--line);margin:0}
ol.sources li:last-child{border-bottom:0}
ol.sources .n{flex:none;width:26px;height:26px;border-radius:13px;background:var(--ink);color:#fff;font-size:13px;display:flex;align-items:center;justify-content:center}
@media (prefers-color-scheme:dark){ol.sources .n{background:var(--sky);color:var(--ink)}}
ol.sources a{font-weight:600;text-decoration:none}
ol.sources .host{display:block;font-size:13px;color:var(--muted)}
li:target,ol.sources li:target{background:color-mix(in srgb,var(--sky) 14%,transparent);border-radius:10px}
`;

/** The page body for a research report: title, meta pills, the summary as a card, the sections, then the sources. */
export function researchPageHtml(o: { question: string; report: string; sources: ResearchSource[]; date?: Date }): string {
  let md = o.report.trim();
  // the model's own "# Title" becomes the page title
  let title = '';
  const h1 = /^#\s+(.+)$/m.exec(md);
  if (h1 && md.indexOf(h1[0]) < 200) {
    title = h1[1]!.trim();
    md = md.replace(h1[0], '').trim();
  }
  if (!title) title = o.question;
  // a Sources section the model wrote anyway is replaced by the real list
  md = md.replace(/\n#{1,3}\s*(Sources|References)\s*\n[\s\S]*$/i, '').trim();
  // the Summary section goes in its own card
  let summary = '';
  const sm = /(^|\n)#{2,3}\s*(Summary|Key findings|TL;DR)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|$)/i.exec(md);
  if (sm) {
    summary = sm[3]!.trim();
    md = md.replace(sm[0], '\n').trim();
  }
  const max = o.sources.length;
  const day = (o.date ?? new Date()).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const parts = [
    `<style>${PAGE_CSS}</style>`,
    `<p class="eyebrow">Research</p>`,
    `<h1>${esc(title)}</h1>`,
    `<div class="meta"><span class="pill">${max} source${max === 1 ? '' : 's'}</span><span class="pill">${esc(day)}</span></div>`,
    title !== o.question ? `<p class="muted">${esc(o.question)}</p>` : '',
    summary ? `<section class="card summary"><h2>Summary</h2>${markdownToHtml(summary, max)}</section>` : '',
    markdownToHtml(md, max),
    max
      ? `<h2 id="sources">Sources</h2><ol class="sources">${o.sources
          .map((s) => {
            const u = safeUrl(s.url);
            return `<li id="s${s.n}"><span class="n">${s.n}</span><span><a href="${esc(u)}" target="_blank" rel="noopener">${esc(s.title || hostOf(u) || u)}</a><span class="host">${esc(hostOf(u))}</span></span></li>`;
          })
          .join('')}</ol>`
      : '',
  ];
  return parts.filter(Boolean).join('\n');
}

/** The Summary bullets of a report, for the chat line next to the page card (empty when it has none). */
export function reportSummary(report: string): string {
  const sm = /(^|\n)#{2,3}\s*(Summary|Key findings|TL;DR)[^\n]*\n([\s\S]*?)(?=\n#{1,3}\s|$)/i.exec(report);
  return sm ? sm[3]!.trim().slice(0, 1500) : '';
}
