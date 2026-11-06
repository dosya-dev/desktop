// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/read-core.test.ts - keep the two in step.
//
import { describe, expect, it } from 'vitest';
import { facesFromFlat, fetchReaderBytes, imageSize, IntegrityError, PhotoUnsupportedError, readPhoto, sha256Hex, verifyBytes, READER_FILES } from './read-core';

function jpeg(width: number, height: number, sof = 0xc0): Uint8Array {
  return new Uint8Array([
    0xff, 0xd8,
    // APP0, length 16
    0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
    // SOFn, length 17: precision, height, width, 3 components
    0xff, sof, 0x00, 0x11, 0x08, height >> 8, height & 0xff, width >> 8, width & 0xff, 0x03,
    0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);
}

function webpVp8x(width: number, height: number): Uint8Array {
  const b = new Uint8Array(40);
  b.set([...'RIFF'].map((c) => c.charCodeAt(0)), 0);
  b.set([...'WEBP'].map((c) => c.charCodeAt(0)), 8);
  b.set([...'VP8X'].map((c) => c.charCodeAt(0)), 12);
  const w = width - 1;
  const h = height - 1;
  b.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 24);
  return b;
}

describe('imageSize', () => {
  it('reads a baseline and a progressive JPEG', () => {
    expect(imageSize(jpeg(1600, 1067))).toEqual({ width: 1600, height: 1067 });
    expect(imageSize(jpeg(640, 480, 0xc2))).toEqual({ width: 640, height: 480 });
  });
  it('reads an extended WebP', () => {
    expect(imageSize(webpVp8x(1600, 900))).toEqual({ width: 1600, height: 900 });
  });
  it('is null for anything else, a truncated header or a zero size', () => {
    expect(imageSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))).toBeNull();
    expect(imageSize(jpeg(1600, 1067).slice(0, 24))).toBeNull();
    expect(imageSize(jpeg(0, 10))).toBeNull();
    expect(imageSize(new Uint8Array())).toBeNull();
  });
});

describe('facesFromFlat', () => {
  it('turns pixel boxes into fractions of the image and keeps the 128-float signature', () => {
    const flat = new Float32Array(2 * 133);
    flat.set([100, 50, 200, 100, 0.95], 0);
    flat[5] = 1;
    flat.set([0, 0, 1000, 500, 0.9], 133);
    flat[133 + 6] = 1;
    const faces = facesFromFlat(flat, 1000, 500);
    expect(faces).toHaveLength(2);
    expect(faces[0].box).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 });
    expect(faces[0].score).toBeCloseTo(0.95, 5);
    expect(faces[0].sig).toBeInstanceOf(Float32Array);
    expect(faces[0].sig.length).toBe(128);
    expect(faces[0].sig[0]).toBe(1);
    expect(faces[1].box).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(faces[1].sig[1]).toBe(1);
  });
  it('ignores a trailing partial face', () => {
    expect(facesFromFlat(new Float32Array(133 + 10), 10, 10)).toHaveLength(1);
  });
});

describe('integrity', () => {
  it('pins the reader wasm and both models', () => {
    expect(READER_FILES.wasm).toEqual({ name: 'face_reader_bg.wasm', sha256: '6ccea5f6c00c7e359b9c3ae765c5e6433b2e76dd31e4aa53be4d12ad096662ef' });
    expect(READER_FILES.detector).toEqual({ name: 'yunet-2023mar.onnx', sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' });
    expect(READER_FILES.embedder).toEqual({ name: 'sface-2021dec-f16.onnx', sha256: 'c810ba6f7c1a29e9d0e1434b4824fed42668f8df6266d841fe17084f18b0b123' });
  });
  it('hashes and refuses bytes that are not the pinned ones', async () => {
    const abc = new TextEncoder().encode('abc');
    expect(await sha256Hex(abc)).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await expect(verifyBytes(abc, { name: 'x', sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad' })).resolves.toBe(abc);
    await expect(verifyBytes(abc, { name: 'x', sha256: '00'.repeat(32) })).rejects.toBeInstanceOf(IntegrityError);
  });
});

describe('readPhoto', () => {
  const reader = { read: () => new Float32Array(133).fill(0.5) };
  it('refuses a photo that is not a JPEG or WebP before the reader sees it', async () => {
    let called = false;
    await expect(readPhoto({ read: () => { called = true; return new Float32Array(); } }, new Uint8Array([1, 2, 3]))).rejects.toThrow(PhotoUnsupportedError);
    expect(called).toBe(false);
  });
  it('maps a decode error to unsupported and passes a wasm trap through', async () => {
    await expect(readPhoto({ read: () => { throw new Error('decode failed'); } }, jpeg(10, 10))).rejects.toThrow(PhotoUnsupportedError);
    const trap = new WebAssembly.RuntimeError('unreachable');
    await expect(readPhoto({ read: () => { throw trap; } }, jpeg(10, 10))).rejects.toBe(trap);
  });
  it('for the ONNX Runtime reader, only its own PhotoUnsupportedError is the photo\'s; other errors are a failed read', async () => {
    const opts = { errorsAreThePhotos: false };
    const err = new Error('OrtRun failed');
    await expect(readPhoto({ read: async () => { throw err; } }, jpeg(10, 10), opts)).rejects.toBe(err);
    await expect(readPhoto({ read: async () => { throw new PhotoUnsupportedError('bad'); } }, jpeg(10, 10), opts)).rejects.toThrow(PhotoUnsupportedError);
    const trap = new WebAssembly.RuntimeError('unreachable');
    await expect(readPhoto({ read: async () => { throw trap; } }, jpeg(10, 10), opts)).rejects.toBe(trap);
  });
  it('reads with the header size, from a sync or an async reader', async () => {
    const faces = await readPhoto(reader, jpeg(2, 4));
    expect(faces[0].box).toEqual({ x: 0.25, y: 0.125, w: 0.25, h: 0.125 });
    const later = await readPhoto({ read: async () => new Float32Array(133).fill(0.5) }, jpeg(2, 4));
    expect(later[0].box).toEqual(faces[0].box);
  });
});

describe('fetchReaderBytes', () => {
  it('fetches each file under a URL naming its hash (an immutable cache never serves old bytes) and checks it', async () => {
    const urls: string[] = [];
    const fetchFn = (async (url: string) => {
      urls.push(url);
      return new Response(new TextEncoder().encode('abc'));
    }) as unknown as typeof fetch;
    const err = await fetchReaderBytes('https://api.test/api/personas/models', fetchFn).catch((e) => e);
    expect(err).toBeInstanceOf(IntegrityError);
    expect(urls).toEqual([`https://api.test/api/personas/models/face_reader_bg.wasm?v=${READER_FILES.wasm.sha256.slice(0, 16)}`]);
  });

  it('a failed download is an error, never a reader', async () => {
    const fetchFn = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    await expect(fetchReaderBytes('https://api.test/m', fetchFn)).rejects.toThrow(/404/);
  });
});

