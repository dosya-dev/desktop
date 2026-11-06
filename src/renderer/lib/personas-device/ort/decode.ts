// Ported from apps/web/src/lib/personas-device/ort/decode.ts - keep the two in step.
//
// Encoded photo to pixels for the ONNX Runtime reader, with the platform's
// own decoder (createImageBitmap + OffscreenCanvas, inside the reader worker).
//
// The result must match what the Rust reader decodes (src/decode.rs), because
// face boxes are stored as fractions of the encoded image's header size:
// - EXIF orientation is not applied. Browsers apply it, so the EXIF block is
//   cut out of the bytes before decoding (JPEG APP1 "Exif", WebP "EXIF").
// - No colour-profile conversion and no alpha premultiplication.
// - Over MAX_SIDE on the long side, the photo is resized down to it.
import { imageSize, PhotoUnsupportedError } from '../read-core';
import type { Pixels } from './pipeline';

/** Long side of the image the reader works on (decode.rs MAX_SIDE). */
export const MAX_SIDE = 1600;
/**
 * Largest photo, in pixels, handed to the platform decoder: it decodes at
 * full size before resizing, so a 100 MP original (the thumb route can
 * redirect to one) would need 400 MB in a worker. Above this the photo is
 * unsupported. 36 MP covers a 6000x6000 photo (144 MB decoded).
 */
export const MAX_DECODE_PIXELS = 36_000_000;

/** JPEG bytes without APP1 segments that carry Exif. Anything unexpected returns the bytes as they are. */
export function stripJpegExif(b: Uint8Array): Uint8Array {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return b;
  const parts: Uint8Array[] = [b.subarray(0, 2)];
  let i = 2;
  let cut = false;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return b;
    const m = b[i + 1];
    if (m === 0xda || m === 0xd9) break; // scan data (or end): copy the rest as is
    if (m === 0xff) {
      parts.push(b.subarray(i, i + 1));
      i++;
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      parts.push(b.subarray(i, i + 2));
      i += 2;
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2 || i + 2 + len > b.length) return b;
    const isExif = m === 0xe1 && len >= 8 && String.fromCharCode(...b.subarray(i + 4, i + 8)) === 'Exif';
    if (isExif) cut = true;
    else parts.push(b.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (!cut) return b;
  parts.push(b.subarray(i));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const fourcc = (b: Uint8Array, at: number) => String.fromCharCode(b[at], b[at + 1], b[at + 2], b[at + 3]);

/** WebP bytes without the EXIF chunk (and its VP8X flag). Anything unexpected returns the bytes as they are. */
export function stripWebpExif(b: Uint8Array): Uint8Array {
  if (b.length < 20 || fourcc(b, 0) !== 'RIFF' || fourcc(b, 8) !== 'WEBP' || fourcc(b, 12) !== 'VP8X') return b;
  const chunks: Uint8Array[] = [];
  let i = 12;
  let cut = false;
  while (i + 8 <= b.length) {
    const size = b[i + 4] | (b[i + 5] << 8) | (b[i + 6] << 16) | (b[i + 7] << 24);
    const end = i + 8 + size + (size & 1);
    if (size < 0 || end > b.length) return b;
    if (fourcc(b, i) === 'EXIF') cut = true;
    else chunks.push(b.subarray(i, end));
    i = end;
  }
  if (!cut) return b;
  const body = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + body);
  out.set(b.subarray(0, 12));
  const riff = 4 + body;
  out[4] = riff & 0xff;
  out[5] = (riff >> 8) & 0xff;
  out[6] = (riff >> 16) & 0xff;
  out[7] = (riff >>> 24) & 0xff;
  let o = 12;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  out[20] &= ~0x08; // VP8X flags: no EXIF any more
  return out;
}

/** Whether the bytes still hold an Exif APP1 segment (searched in the first 64 KB, where JPEG headers live). */
function hasJpegExif(b: Uint8Array): boolean {
  const end = Math.min(b.length - 8, 65536);
  for (let i = 2; i < end; i++) {
    if (b[i] === 0xff && b[i + 1] === 0xe1 && b[i + 4] === 0x45 && b[i + 5] === 0x78 && b[i + 6] === 0x69 && b[i + 7] === 0x66) return true;
  }
  return false;
}

/**
 * The photo's bytes with any EXIF block cut out, so the decoder cannot rotate
 * it. A JPEG whose Exif could not be cut out (a marker walk that gave up) is
 * refused as a failed read: decoded, its boxes could come out flipped.
 */
export function withoutExif(b: Uint8Array): Uint8Array {
  if (b[0] !== 0xff) return stripWebpExif(b);
  const out = stripJpegExif(b);
  if (out === b && hasJpegExif(b)) throw new Error('could not remove the photo\'s EXIF orientation');
  return out;
}

/** The size the reader works at: the photo's own, or MAX_SIDE on the long side. */
export function workingSize(width: number, height: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= MAX_SIDE) return { width, height };
  const s = MAX_SIDE / long;
  return { width: Math.max(1, Math.round(width * s)), height: Math.max(1, Math.round(height * s)) };
}

export interface DecodedPhoto {
  pixels: Pixels;
  /** Multipliers from the pixels to the encoded image's pixels. */
  toSource: [number, number];
}

/** What decodePhoto needs of the platform (the worker's globals; tests pass fakes). */
export interface Decoder {
  createImageBitmap(blob: Blob, options: ImageBitmapOptions): Promise<ImageBitmap>;
  canvas(width: number, height: number): { getContext(id: '2d', o: { willReadFrequently: boolean }): OffscreenCanvasRenderingContext2D | null };
}

export function platformDecoder(): Decoder | null {
  const g = globalThis as { createImageBitmap?: unknown; OffscreenCanvas?: unknown };
  if (typeof g.createImageBitmap !== 'function' || typeof g.OffscreenCanvas !== 'function') return null;
  try {
    if (!new OffscreenCanvas(1, 1).getContext('2d')) return null;
  } catch {
    return null;
  }
  return {
    createImageBitmap: (blob, options) => createImageBitmap(blob, options),
    canvas: (w, h) => new OffscreenCanvas(w, h) as unknown as ReturnType<Decoder['canvas']>,
  };
}

/** Decode a JPEG or WebP into RGBA pixels at the working size. */
export async function decodePhoto(photo: Uint8Array, d: Decoder): Promise<DecodedPhoto> {
  const size = imageSize(photo);
  if (!size) throw new PhotoUnsupportedError('not a JPEG or WebP');
  if (size.width * size.height > MAX_DECODE_PIXELS) throw new PhotoUnsupportedError(`photo too large to read (${size.width}x${size.height})`);
  const { width, height } = workingSize(size.width, size.height);
  const resize = width !== size.width || height !== size.height;
  const bytes = withoutExif(photo);
  let bmp: ImageBitmap;
  try {
    // No imageOrientation: its values differ between engines (an unknown one
    // is a TypeError) and the EXIF block is already cut out above.
    bmp = await d.createImageBitmap(new Blob([bytes as Uint8Array<ArrayBuffer>]), {
      premultiplyAlpha: 'none',
      colorSpaceConversion: 'none',
      ...(resize ? { resizeWidth: width, resizeHeight: height, resizeQuality: 'high' as const } : {}),
    });
  } catch (e) {
    // A failed read, tried again later, not an unreadable photo: engines
    // reject a decode under memory pressure or with a full disk the same way
    // as broken bytes (InvalidStateError), and options an engine does not
    // know are a TypeError. A photo that fails twice is journaled as failed.
    throw e instanceof Error ? e : new Error(String(e));
  }
  try {
    // A decoder that still rotated it, or ignored the resize, would put
    // every box in the wrong place: refuse rather than guess.
    if (bmp.width !== width || bmp.height !== height) {
      throw new Error(`decoded ${bmp.width}x${bmp.height}, expected ${width}x${height}`);
    }
    const ctx = d.canvas(width, height).getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no 2D canvas');
    ctx.drawImage(bmp, 0, 0);
    const px = ctx.getImageData(0, 0, width, height).data;
    return { pixels: { px, width, height, channels: 4 }, toSource: [size.width / width, size.height / height] };
  } finally {
    bmp.close();
  }
}
