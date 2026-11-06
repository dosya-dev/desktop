// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/reader.smoke.test.ts - keep the two in step.
//
// The real reader end to end: the committed packages/face-reader wasm, the
// vendored glue the worker imports, and the two published models, through
// the same loadReader/readPhoto the worker runs. Monorepo only: skipped when
// the wasm or the models are not on this machine (the models are kept out of
// git; see packages/face-reader/fetch-models.mjs).
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as glue from '@dosya-dev/face-reader';
import { loadReader, readPhoto, READER_FILES } from './read-core';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../..');
const wasmPath = path.join(repo, 'packages/face-reader/dist/face_reader_bg.wasm');
const photoPath = path.join(repo, 'packages/face-reader/test/fixtures/nasa-crew-public-domain.jpg');
const models = process.env.FACE_MODELS_DIR ?? path.join(homedir(), 'Desktop/Projects/dosya.dev-personas-notes/face-models');
const detectorPath = path.join(models, 'face_detection_yunet_2023mar.onnx');
const embedderPath = path.join(models, 'face_recognition_sface_2021dec_f16.onnx');
const present = [wasmPath, photoPath, detectorPath, embedderPath].every((p) => existsSync(p));

describe.skipIf(!present)('face reader smoke (real wasm and models)', () => {
  it('finds the crew: at least 4 faces, boxes inside the image, unit-length signatures', async () => {
    const reader = await loadReader(glue, {
      wasm: new Uint8Array(readFileSync(wasmPath)),
      detector: new Uint8Array(readFileSync(detectorPath)),
      embedder: new Uint8Array(readFileSync(embedderPath)),
    });
    const faces = await readPhoto(reader, new Uint8Array(readFileSync(photoPath)));
    expect(faces.length).toBeGreaterThanOrEqual(4);
    for (const f of faces) {
      for (const v of [f.box.x, f.box.y, f.box.w, f.box.h]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(f.box.w).toBeGreaterThan(0);
      expect(f.box.h).toBeGreaterThan(0);
      expect(f.box.x + f.box.w).toBeLessThanOrEqual(1.0001);
      expect(f.box.y + f.box.h).toBeLessThanOrEqual(1.0001);
      expect(f.score).toBeGreaterThanOrEqual(0.89);
      expect(f.sig.length).toBe(128);
      const norm = Math.sqrt(f.sig.reduce((s, x) => s + x * x, 0));
      expect(norm).toBeCloseTo(1, 3);
    }
  }, 120_000);

  it('the committed wasm is the pinned one', async () => {
    const { sha256Hex } = await import('./read-core');
    expect(await sha256Hex(new Uint8Array(readFileSync(wasmPath)))).toBe(READER_FILES.wasm.sha256);
  });
});
