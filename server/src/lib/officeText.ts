import { inflateRawSync } from 'node:zlib';

/**
 * Text from Office documents (DOCX, PPTX, XLSX) and OpenDocument (ODT, ODS, ODP), which are zip
 * files of XML. A small zip reader (stored + deflate entries) keeps this dependency-free.
 */
export function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  // End of central directory record: search backwards for its signature.
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    p += 46 + nameLen + extraLen + commentLen;
    if (buf.readUInt32LE(local) !== 0x04034b50) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    try {
      if (method === 0) out.set(name, Buffer.from(data));
      else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: 50 * 1024 * 1024 }));
    } catch {
      // skip a damaged entry
    }
  }
  return out;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e] ?? m;
  });
}

/** Paragraph-aware text from WordprocessingML / DrawingML / OpenDocument XML. */
export function xmlText(xml: string): string {
  return decodeXml(
    xml
      .replace(/<w:tab\/>|<text:tab\/>/g, '\t')
      .replace(/<w:br[^>]*\/>|<text:line-break\/>/g, '\n')
      .replace(/<\/w:p>|<\/a:p>|<\/text:p>|<\/text:h>/g, '\n')
      .replace(/<\/w:tc>|<\/table:table-cell>/g, '\t')
      .replace(/<[^>]+>/g, ''),
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const num = (s: string) => Number(/(\d+)\.xml$/.exec(s)?.[1] ?? 0);

export type OfficeKind = 'docx' | 'pptx' | 'xlsx' | 'odf';

export function officeKind(name: string, mime: string): OfficeKind | null {
  const n = name.toLowerCase();
  if (n.endsWith('.docx') || mime.includes('wordprocessingml')) return 'docx';
  if (n.endsWith('.pptx') || mime.includes('presentationml')) return 'pptx';
  if (n.endsWith('.xlsx') || mime.includes('spreadsheetml')) return 'xlsx';
  if (/\.(odt|ods|odp)$/.test(n) || mime.includes('opendocument')) return 'odf';
  return null;
}

export function extractOfficeText(buf: Buffer, kind: OfficeKind): { text: string; pages?: number } {
  const zip = readZip(buf);
  const get = (k: string) => zip.get(k)?.toString('utf8') ?? '';
  if (kind === 'docx') {
    const parts = ['word/document.xml', ...[...zip.keys()].filter((k) => /^word\/(footnotes|endnotes)\.xml$/.test(k))];
    return { text: parts.map((k) => xmlText(get(k))).filter(Boolean).join('\n\n') };
  }
  if (kind === 'pptx') {
    const slides = [...zip.keys()].filter((k) => /^ppt\/slides\/slide\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
    return { text: slides.map((k, i) => `Slide ${i + 1}\n${xmlText(get(k))}`).join('\n\n'), pages: slides.length };
  }
  if (kind === 'xlsx') {
    const shared = [...get('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]!));
    const sheets = [...zip.keys()].filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort((a, b) => num(a) - num(b));
    const text = sheets
      .map((k, i) => {
        const rows = [...get(k).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) =>
          [...r[1]!.matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)]
            .map((c) => {
              const attrs = c[1] ?? '';
              const inner = c[2] ?? '';
              const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
              if (/t="s"/.test(attrs) && v != null) return shared[Number(v)] ?? '';
              if (/t="inlineStr"/.test(attrs)) return xmlText(inner);
              return v != null ? decodeXml(v) : '';
            })
            .join('\t'),
        );
        return `Sheet ${i + 1}\n${rows.join('\n')}`;
      })
      .join('\n\n');
    return { text, pages: sheets.length };
  }
  return { text: xmlText(get('content.xml')) };
}
