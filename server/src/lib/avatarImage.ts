import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { AppError } from '../errors.js';

/**
 * Profile pictures: every upload is decoded and re-encoded here, so only a clean baseline JPEG that
 * this server made ever gets stored. Metadata (EXIF, GPS, comments) is dropped, transparency is
 * flattened, the picture is centre-cropped to a square and scaled down to at most AVATAR_SIZE.
 * Only JPEG and PNG are accepted (sniffed from the bytes, not the name or the claimed type).
 */
export const AVATAR_MAX_UPLOAD_BYTES = 2 * 1024 * 1024;
export const AVATAR_SIZE = 512;
export const AVATAR_MIN_SIDE = 32;
/** The app scales pictures to 512 px before upload; these limits keep server-side decoding small. */
export const AVATAR_MAX_SIDE = 2048;
export const AVATAR_MAX_PIXELS = 2048 * 2048;
/** Each stored picture stays under this many bytes: quality, then size, step down until it fits. */
export const AVATAR_MAX_STORED_BYTES = 120 * 1024;
const ENCODE_STEPS: { size: number; quality: number }[] = [
  { size: AVATAR_SIZE, quality: 84 },
  { size: AVATAR_SIZE, quality: 70 },
  { size: AVATAR_SIZE, quality: 55 },
  { size: 384, quality: 55 },
  { size: 256, quality: 50 },
];
/** Light cream behind transparent pixels (matches the app's light surface). */
const BG = [250, 249, 245] as const;

export type ImageKind = 'jpeg' | 'png';

export function sniffImage(buf: Buffer): ImageKind | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  return null;
}

/** Width/height (and JPEG EXIF orientation) read from the headers, before any pixel is decoded. */
export function readImageHeader(buf: Buffer, kind: ImageKind): { width: number; height: number; orientation: number } {
  if (kind === 'png') {
    if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') throw bad();
    return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20), orientation: 1 };
  }
  let orientation = 1;
  let i = 2;
  while (i + 4 <= buf.length) {
    if (buf[i] !== 0xff) throw bad();
    const marker = buf[i + 1]!;
    if (marker === 0xff) {
      i += 1;
      continue;
    }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    if (len < 2 || i + 2 + len > buf.length) throw bad();
    if (marker === 0xe1) orientation = exifOrientation(buf.subarray(i + 4, i + 2 + len)) ?? orientation;
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof) {
      if (len < 7) throw bad();
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7), orientation };
    }
    if (marker === 0xda || marker === 0xd9) break;
    i += 2 + len;
  }
  throw bad();
}

function exifOrientation(seg: Buffer): number | null {
  try {
    if (seg.length < 14 || seg.toString('ascii', 0, 4) !== 'Exif') return null;
    const t = seg.subarray(6);
    const le = t.toString('ascii', 0, 2) === 'II';
    const u16 = (o: number) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o: number) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const ifd = u32(4);
    const count = u16(ifd);
    for (let k = 0; k < count && k < 64; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

function bad() {
  return new AppError('unsupported_file', 'This picture could not be read. Try a different JPEG or PNG photo.');
}

interface Rgba {
  width: number;
  height: number;
  data: Uint8Array;
}

function decode(buf: Buffer, kind: ImageKind): Rgba {
  try {
    if (kind === 'jpeg') {
      const out = jpeg.decode(buf, { useTArray: true, formatAsRGBA: true, tolerantDecoding: false, maxResolutionInMP: 4.2, maxMemoryUsageInMB: 100 });
      return { width: out.width, height: out.height, data: out.data };
    }
    const png = PNG.sync.read(buf);
    return { width: png.width, height: png.height, data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length) };
  } catch {
    throw bad();
  }
}

/** Square, upright, flattened RGB(A) at most `size` pixels per side, using an area-average filter. */
function cropScale(src: Rgba, orientation: number, size: number): Rgba {
  // Oriented dimensions (EXIF 5-8 swap width and height).
  const swap = orientation >= 5;
  const ow = swap ? src.height : src.width;
  const oh = swap ? src.width : src.height;
  const side = Math.min(ow, oh);
  const ox = Math.floor((ow - side) / 2);
  const oy = Math.floor((oh - side) / 2);
  const out = Math.min(size, side);
  const dst = new Uint8Array(out * out * 4);
  const scale = side / out;
  const W = src.width;
  const H = src.height;
  // Map an oriented (x, y) to the stored pixel index.
  const at = (x: number, y: number): number => {
    let sx: number, sy: number;
    switch (orientation) {
      case 2: sx = W - 1 - x; sy = y; break;
      case 3: sx = W - 1 - x; sy = H - 1 - y; break;
      case 4: sx = x; sy = H - 1 - y; break;
      case 5: sx = y; sy = x; break;
      case 6: sx = y; sy = H - 1 - x; break;
      case 7: sx = W - 1 - y; sy = H - 1 - x; break;
      case 8: sx = W - 1 - y; sy = x; break;
      default: sx = x; sy = y;
    }
    return (sy * W + sx) * 4;
  };
  const d = src.data;
  for (let ty = 0; ty < out; ty++) {
    const y0 = oy + Math.floor(ty * scale);
    const y1 = Math.max(y0 + 1, oy + Math.floor((ty + 1) * scale));
    for (let tx = 0; tx < out; tx++) {
      const x0 = ox + Math.floor(tx * scale);
      const x1 = Math.max(x0 + 1, ox + Math.floor((tx + 1) * scale));
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const p = at(x, y);
          const a = d[p + 3]! / 255;
          r += d[p]! * a + BG[0] * (1 - a);
          g += d[p + 1]! * a + BG[1] * (1 - a);
          b += d[p + 2]! * a + BG[2] * (1 - a);
          n++;
        }
      }
      const q = (ty * out + tx) * 4;
      dst[q] = Math.round(r / n);
      dst[q + 1] = Math.round(g / n);
      dst[q + 2] = Math.round(b / n);
      dst[q + 3] = 255;
    }
  }
  return { width: out, height: out, data: dst };
}

export interface ProcessedAvatar {
  jpeg: Buffer;
  width: number;
  height: number;
}

/** Validates and re-encodes an uploaded picture. Throws AppError with a user-readable message. */
export function processAvatar(buf: Buffer): ProcessedAvatar {
  if (!buf || buf.length === 0) throw new AppError('validation_error', 'No picture was received.');
  if (buf.length > AVATAR_MAX_UPLOAD_BYTES) throw new AppError('file_too_large', 'Profile pictures can be up to 2 MB.');
  const kind = sniffImage(buf);
  if (!kind) throw new AppError('unsupported_file', 'Please choose a JPEG or PNG picture.');
  const head = readImageHeader(buf, kind);
  if (head.width < AVATAR_MIN_SIDE || head.height < AVATAR_MIN_SIDE) {
    throw new AppError('validation_error', `That picture is too small. Use one at least ${AVATAR_MIN_SIDE} pixels wide and tall.`);
  }
  if (head.width > AVATAR_MAX_SIDE || head.height > AVATAR_MAX_SIDE || head.width * head.height > AVATAR_MAX_PIXELS) {
    throw new AppError('file_too_large', 'That picture is too large. Use one up to 2048 pixels on each side.');
  }
  const img = decode(buf, kind);
  if (img.width !== head.width || img.height !== head.height || img.data.length < img.width * img.height * 4) throw bad();
  let sq = cropScale(img, head.orientation, AVATAR_SIZE);
  let out: Buffer = Buffer.alloc(0);
  for (const step of ENCODE_STEPS) {
    if (step.size < sq.width) sq = cropScale(sq, 1, step.size);
    out = jpeg.encode({ width: sq.width, height: sq.height, data: sq.data }, step.quality).data;
    if (out.length <= AVATAR_MAX_STORED_BYTES) break;
  }
  return { jpeg: out, width: sq.width, height: sq.height };
}
