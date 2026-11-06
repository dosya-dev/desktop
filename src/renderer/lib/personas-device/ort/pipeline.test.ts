// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/ort/pipeline.test.ts - keep the two in step.
//
import { describe, expect, it } from 'vitest';
import { decodeCell, decodeYunet, DETECT_SIZE, FACE_STRIDE, l2Normalize, letterbox, readFaces, similarity, type FaceModels } from './pipeline';

describe('face pipeline (ported from packages/face-reader/src/lib.rs)', () => {
  it('similarity recovers a known transform', () => {
    const [a, b, tx, ty] = [0.5, 0.2, 3, -4];
    const src: [number, number][] = [[10, 20], [50, 22], [30, 40], [15, 60], [45, 61]];
    const dst = src.map(([x, y]) => [a * x - b * y + tx, b * x + a * y + ty] as [number, number]);
    const m = similarity(src, dst);
    [a, b, tx, ty].forEach((want, i) => expect(Math.abs(m[i] - want)).toBeLessThan(1e-3));
  });

  it('drops non-finite and low-score candidates', () => {
    const kps = new Array(10).fill(0);
    expect(decodeCell(1, 1, [0, 0, 1, 1], kps, 1, 1, 8)).not.toBeNull();
    expect(decodeCell(1, 1, [0, 0, 1000, 1], kps, 1, 1, 8)).toBeNull();
    expect(decodeCell(Number.NaN, 1, [0, 0, 1, 1], kps, 1, 1, 8)).toBeNull();
    const bad = kps.slice();
    bad[3] = Number.NaN;
    expect(decodeCell(1, 1, [0, 0, 1, 1], bad, 1, 1, 8)).toBeNull();
    expect(decodeCell(0.5, 0.5, [0, 0, 1, 1], kps, 1, 1, 8)).toBeNull();
  });

  it('letterboxes the long side to 320 as BGR planes, the rest zero', () => {
    // 640x320, left half pure red, right half pure blue.
    const w = 640;
    const h = 320;
    const px = new Uint8Array(w * h * 3);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) px.set(x < 320 ? [255, 0, 0] : [0, 0, 255], (y * w + x) * 3);
    const { input, scale } = letterbox({ px, width: w, height: h, channels: 3 });
    expect(scale).toBe(0.5);
    const s = DETECT_SIZE;
    const plane = s * s;
    // Top-left pixel is red: B=0, G=0, R=255.
    expect([input[0], input[plane], input[2 * plane]]).toEqual([0, 0, 255]);
    // Top-right of the image area is blue.
    expect([input[319], input[plane + 319], input[2 * plane + 319]]).toEqual([255, 0, 0]);
    // Below the image (rows 160+) is zero.
    expect(input[200 * s + 10]).toBe(0);
  });

  it('decodes YuNet outputs into one face per peak, mapped back to the source and NMS-filtered', () => {
    const outs: Record<string, Float32Array> = {};
    for (const st of [8, 16, 32]) {
      const cells = (DETECT_SIZE / st) ** 2;
      outs[`cls_${st}`] = new Float32Array(cells);
      outs[`obj_${st}`] = new Float32Array(cells);
      outs[`bbox_${st}`] = new Float32Array(cells * 4);
      outs[`kps_${st}`] = new Float32Array(cells * 10);
    }
    // Two overlapping candidates at stride 32 (cells 0 and 1 of row 2), one stronger.
    const put = (idx: number, score: number) => {
      outs.cls_32[idx] = score;
      outs.obj_32[idx] = score;
      outs.bbox_32.set([0.5, 0.5, Math.log(2), Math.log(2)], idx * 4);
    };
    put(20, 0.95);
    put(21, 0.92);
    const faces = decodeYunet(outs, 0.5, 640, 640);
    expect(faces).toHaveLength(1);
    expect(faces[0].score).toBeCloseTo(0.95, 5);
    // Cell (row 2, col 0) at stride 32: centre (16, 80), size 64 in detector px, so
    // x -16..48 (clamped at 0) and y 48..112; divided by the 0.5 scale for the source.
    const { x, y, w, h } = faces[0];
    [x, y, w, h].forEach((v, i) => expect(v).toBeCloseTo([0, 96, 96, 128][i], 4));
  });

  it('readFaces writes x, y, w, h, score and a unit signature per face, boxes scaled to the source', async () => {
    const models: FaceModels = {
      async detect() {
        const outs: Record<string, Float32Array> = {};
        for (const st of [8, 16, 32]) {
          const cells = (DETECT_SIZE / st) ** 2;
          outs[`cls_${st}`] = new Float32Array(cells);
          outs[`obj_${st}`] = new Float32Array(cells);
          outs[`bbox_${st}`] = new Float32Array(cells * 4);
          outs[`kps_${st}`] = new Float32Array(cells * 10);
        }
        outs.cls_32[45] = 0.9;
        outs.obj_32[45] = 0.9;
        outs.bbox_32.set([0.5, 0.5, Math.log(3), Math.log(3)], 45 * 4);
        return outs;
      },
      async embed(_input, n) {
        return Float32Array.from({ length: 128 * n }, (_, i) => (i % 128) + 1);
      },
    };
    const px = new Uint8Array(320 * 320 * 4);
    const out = await readFaces({ px, width: 320, height: 320, channels: 4 }, models, [2, 2]);
    expect(out.length).toBe(FACE_STRIDE);
    expect(Array.from(out.slice(0, 4))).toEqual([2 * (5.5 * 32 - 48), 2 * (4.5 * 32 - 48), 2 * 96, 2 * 96]);
    const sig = out.slice(5);
    expect(Math.hypot(...sig)).toBeCloseTo(1, 5);
  });

  it('l2Normalize refuses a feature of the wrong length', () => {
    expect(() => l2Normalize(new Float32Array(127))).toThrow(/127/);
  });

  it('sends a crowd through SFace in runs of 16, in order', async () => {
    const calls: number[] = [];
    const cells = (st: number) => (DETECT_SIZE / st) ** 2;
    const models: FaceModels = {
      async detect() {
        const outs: Record<string, Float32Array> = {};
        for (const st of [8, 16, 32]) {
          outs[`cls_${st}`] = new Float32Array(cells(st));
          outs[`obj_${st}`] = new Float32Array(cells(st));
          outs[`bbox_${st}`] = new Float32Array(cells(st) * 4);
          outs[`kps_${st}`] = new Float32Array(cells(st) * 10);
        }
        // 20 separate faces on the stride-16 grid (every other cell, rows 1, 4, 7, ...).
        let k = 0;
        for (let row = 1; row < 20 && k < 20; row += 3) {
          for (let col = 1; col < 19 && k < 20; col += 3, k++) {
            const idx = row * 20 + col;
            outs.cls_16[idx] = 0.95 - k * 0.001;
            outs.obj_16[idx] = 0.95 - k * 0.001;
            outs.bbox_16.set([0.5, 0.5, Math.log(3), Math.log(3)], idx * 4);
          }
        }
        return outs;
      },
      async embed(_input, n) {
        calls.push(n);
        const base = calls.length * 1000;
        return Float32Array.from({ length: 128 * n }, (_, i) => base + Math.floor(i / 128) + 1);
      },
    };
    const out = await readFaces({ px: new Uint8Array(320 * 320 * 3), width: 320, height: 320, channels: 3 }, models);
    expect(calls).toEqual([16, 4]);
    expect(out.length).toBe(20 * FACE_STRIDE);
  });

  it('refuses an SFace answer of the wrong size', async () => {
    const models: FaceModels = {
      async detect() {
        const outs: Record<string, Float32Array> = {};
        for (const st of [8, 16, 32]) {
          const c = (DETECT_SIZE / st) ** 2;
          outs[`cls_${st}`] = new Float32Array(c);
          outs[`obj_${st}`] = new Float32Array(c);
          outs[`bbox_${st}`] = new Float32Array(c * 4);
          outs[`kps_${st}`] = new Float32Array(c * 10);
        }
        outs.cls_32[45] = 0.9;
        outs.obj_32[45] = 0.9;
        outs.bbox_32.set([0.5, 0.5, Math.log(3), Math.log(3)], 45 * 4);
        return outs;
      },
      async embed() {
        return new Float32Array(127);
      },
    };
    await expect(readFaces({ px: new Uint8Array(320 * 320 * 3), width: 320, height: 320, channels: 3 }, models)).rejects.toThrow(/127 floats for 1 faces/);
  });
});
