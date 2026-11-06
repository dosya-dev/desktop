// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/ort/decode.test.ts - keep the two in step.
//
import { describe, expect, it, vi } from 'vitest';
import { PhotoUnsupportedError } from '../read-core';
import { decodePhoto, MAX_DECODE_PIXELS, MAX_SIDE, stripJpegExif, stripWebpExif, withoutExif, workingSize, type Decoder } from './decode';

const seg = (marker: number, body: number[]) => [0xff, marker, ((body.length + 2) >> 8) & 0xff, (body.length + 2) & 0xff, ...body];
const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
/** SOI, APP0 JFIF, APP1 Exif, SOF0 (w x h), SOS + 3 bytes of scan, EOI. */
function jpeg(w: number, h: number, exif = true): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii('JFIF'), 0, 1, 1]),
    ...(exif ? seg(0xe1, [...ascii('Exif'), 0, 0, 1, 2, 3, 4]) : []),
    ...seg(0xc0, [8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 3]),
    ...seg(0xda, [1, 2, 3]), 9, 9, 9,
    0xff, 0xd9,
  ]);
}
const le32 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff, (n >>> 24) & 0xff];
const chunk = (id: string, body: number[]) => [...ascii(id), ...le32(body.length), ...body, ...(body.length & 1 ? [0] : [])];
/** RIFF WEBP with VP8X (EXIF flag), an odd-sized EXIF chunk and a VP8L stub. */
function webp(w: number, h: number): Uint8Array {
  const vp8x = [0x08, 0, 0, 0, ...le32(w - 1).slice(0, 3), ...le32(h - 1).slice(0, 3)];
  const body = [...ascii('WEBP'), ...chunk('VP8X', vp8x), ...chunk('EXIF', [1, 2, 3]), ...chunk('VP8L', [0x2f, 0, 0, 0, 0])];
  return new Uint8Array([...ascii('RIFF'), ...le32(body.length), ...body]);
}

describe('EXIF stripping', () => {
  it('cuts the Exif APP1 segment out of a JPEG and keeps everything else', () => {
    const src = jpeg(10, 20);
    const out = stripJpegExif(src);
    expect(out).toEqual(jpeg(10, 20, false));
  });

  it('returns a JPEG without Exif, or a malformed one, as it is', () => {
    const plain = jpeg(10, 20, false);
    expect(stripJpegExif(plain)).toBe(plain);
    const broken = new Uint8Array([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03]);
    expect(stripJpegExif(broken)).toBe(broken);
  });

  it('cuts the EXIF chunk out of a WebP, fixes the RIFF size and clears the VP8X flag', () => {
    const out = stripWebpExif(webp(30, 40));
    const text = String.fromCharCode(...out);
    expect(text).not.toContain('EXIF');
    expect(text).toContain('VP8L');
    const riff = out[4] | (out[5] << 8) | (out[6] << 16) | (out[7] << 24);
    expect(riff).toBe(out.length - 8);
    expect(out[20] & 0x08).toBe(0);
  });

  it('refuses a JPEG whose Exif could not be cut out', () => {
    // A broken segment length after the Exif APP1 makes the walk give up.
    const src = jpeg(10, 20);
    const broken = new Uint8Array([...src.subarray(0, 2), ...src.subarray(2, 2 + 9), 0xff, 0xe1, 0xff, 0xff, ...Array.from('Exif', (c) => c.charCodeAt(0)), 0, 0]);
    expect(() => withoutExif(broken)).toThrow(/EXIF/);
    // Without any Exif it is passed through as it is.
    const plain = jpeg(10, 20, false);
    expect(withoutExif(plain)).toBe(plain);
  });

  it('withoutExif picks the format from the first byte', () => {
    expect(withoutExif(jpeg(1, 1))).toEqual(jpeg(1, 1, false));
    expect(String.fromCharCode(...withoutExif(webp(1, 1)))).not.toContain('EXIF');
  });
});

describe('workingSize', () => {
  it('keeps photos up to 1600 px and brings larger ones to 1600 on the long side', () => {
    expect(workingSize(1600, 1200)).toEqual({ width: 1600, height: 1200 });
    expect(workingSize(4000, 3000)).toEqual({ width: MAX_SIDE, height: 1200 });
    expect(workingSize(1000, 3200)).toEqual({ width: 500, height: MAX_SIDE });
  });
});

function fakeDecoder(decoded: { width: number; height: number }) {
  const px = new Uint8ClampedArray(decoded.width * decoded.height * 4);
  const close = vi.fn();
  const createImageBitmap = vi.fn(async () => ({ width: decoded.width, height: decoded.height, close }) as unknown as ImageBitmap);
  const drawImage = vi.fn();
  const d: Decoder = {
    createImageBitmap,
    canvas: () => ({ getContext: () => ({ drawImage, getImageData: () => ({ data: px }) }) as unknown as OffscreenCanvasRenderingContext2D }),
  };
  return { d, createImageBitmap, close };
}

describe('decodePhoto', () => {
  it('decodes without EXIF, colour conversion or premultiplication, at full size up to 1600', async () => {
    const { d, createImageBitmap, close } = fakeDecoder({ width: 10, height: 20 });
    const out = await decodePhoto(jpeg(10, 20), d);
    expect(out.pixels).toMatchObject({ width: 10, height: 20, channels: 4 });
    expect(out.toSource).toEqual([1, 1]);
    const [blob, options] = createImageBitmap.mock.calls[0] as unknown as [Blob, ImageBitmapOptions];
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(jpeg(10, 20, false));
    expect(options).toEqual({ premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    expect(close).toHaveBeenCalled();
  });

  it('resizes a photo over 1600 px and maps boxes back to its own size', async () => {
    const { d, createImageBitmap } = fakeDecoder({ width: 1600, height: 1200 });
    const out = await decodePhoto(jpeg(4000, 3000), d);
    expect(out.toSource).toEqual([2.5, 2.5]);
    const options = (createImageBitmap.mock.calls[0] as unknown as [Blob, ImageBitmapOptions])[1];
    expect(options).toMatchObject({ resizeWidth: 1600, resizeHeight: 1200, resizeQuality: 'high' });
  });

  it('refuses a decode that came out rotated or at another size', async () => {
    const { d, close } = fakeDecoder({ width: 20, height: 10 });
    await expect(decodePhoto(jpeg(10, 20), d)).rejects.toThrow(/decoded 20x10, expected 10x20/);
    expect(close).toHaveBeenCalled();
  });

  it('anything but a JPEG or WebP, or a photo over the pixel cap, is unsupported without decoding', async () => {
    const { d, createImageBitmap } = fakeDecoder({ width: 1, height: 1 });
    await expect(decodePhoto(new Uint8Array([1, 2, 3, 4]), d)).rejects.toBeInstanceOf(PhotoUnsupportedError);
    await expect(decodePhoto(jpeg(10000, 4000), d)).rejects.toBeInstanceOf(PhotoUnsupportedError);
    expect(10000 * 4000).toBeGreaterThan(MAX_DECODE_PIXELS);
    expect(createImageBitmap).not.toHaveBeenCalled();
  });

  it('asks for a resize when either side changes (800x1601 becomes 800x1600)', async () => {
    const { d, createImageBitmap } = fakeDecoder({ width: 800, height: 1600 });
    const out = await decodePhoto(jpeg(800, 1601), d);
    expect((createImageBitmap.mock.calls[0] as unknown as [Blob, ImageBitmapOptions])[1]).toMatchObject({ resizeWidth: 800, resizeHeight: 1600 });
    expect(out.toSource[1]).toBeCloseTo(1601 / 1600, 6);
  });

  it('a decoder error of any kind is a failed read, not an unreadable photo', async () => {
    const { d } = fakeDecoder({ width: 1, height: 1 });
    const broken: Decoder = { ...d, createImageBitmap: async () => { throw Object.assign(new Error('The source image could not be decoded.'), { name: 'InvalidStateError' }); } };
    const e0 = await decodePhoto(jpeg(10, 20), broken).catch((e: unknown) => e);
    expect(e0).toBeInstanceOf(Error);
    expect(e0).not.toBeInstanceOf(PhotoUnsupportedError);
    const typeError: Decoder = { ...d, createImageBitmap: async () => { throw new TypeError("The provided value 'x' is not a valid enum value"); } };
    const e1 = await decodePhoto(jpeg(10, 20), typeError).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(TypeError);
    expect(e1).not.toBeInstanceOf(PhotoUnsupportedError);
    const odd: Decoder = { ...d, createImageBitmap: async () => { throw 'out of memory'; } };
    const e2 = await decodePhoto(jpeg(10, 20), odd).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(Error);
    expect(e2).not.toBeInstanceOf(PhotoUnsupportedError);
  });
});
