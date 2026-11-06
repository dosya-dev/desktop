// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/ort/pipeline.parity.test.ts - keep the two in step.
//
// The ONNX Runtime reader against the Rust (tract) reader on the same pixels:
// faces read by either must land in the same index. Each test photo is decoded
// once and given to both - to tract as a lossless WebP, so any difference is
// the readers', not the decoders'. Monorepo only: skipped without the models,
// the ORT wasm or sharp on this machine (FACE_MODELS_DIR, see
// packages/face-reader/convert-ort-models.py).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import * as glue from '@dosya-dev/face-reader';
import { FACE_STRIDE, readFaces } from './pipeline';
import { loadOrtModels } from './models';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../../..');
const models = process.env.FACE_MODELS_DIR ?? path.join(homedir(), 'Desktop/Projects/dosya.dev-personas-notes/face-models');
const files = {
  tractWasm: path.join(repo, 'packages/face-reader/dist/face_reader_bg.wasm'),
  yunet: path.join(models, 'face_detection_yunet_2023mar.onnx'),
  sface: path.join(models, 'face_recognition_sface_2021dec_f16.onnx'),
  ortWasm: path.join(models, 'ort-wasm-simd-threaded-1.29.0.asyncify.wasm'),
  yunet320: path.join(models, 'yunet-2023mar-320.onnx'),
  sfaceOrt: path.join(models, 'sface-2021dec-f16-batch.onnx'),
};
const fixtures = path.join(repo, 'packages/face-reader/test/fixtures');

type Sharp = (b: Buffer) => {
  resize(o: { width: number; height: number; fit: 'inside' }): ReturnType<Sharp>;
  png(): { toBuffer(): Promise<Buffer> };
  raw(): { toBuffer(o: { resolveWithObject: true }): Promise<{ data: Buffer; info: { width: number; height: number; channels: number } }> };
  webp(o: { lossless: true }): { toBuffer(): Promise<Buffer> };
};
let sharp: Sharp | null = null;
try {
  sharp = createRequire(import.meta.url)('sharp') as Sharp;
} catch {
  sharp = null;
}
const present = sharp !== null && Object.values(files).every((p) => existsSync(p)) && existsSync(fixtures);

describe.skipIf(!present)('ONNX Runtime reader matches the Rust reader', () => {
  it('same faces, same boxes, same signatures on the test photos', async () => {
    glue.initSync({ module: await WebAssembly.compile(readFileSync(files.tractWasm)) });
    const tract = new glue.FaceReader(new glue.ModelBytes(readFileSync(files.yunet), readFileSync(files.sface)));
    const ortModels = await loadOrtModels({
      wasm: new Uint8Array(readFileSync(files.ortWasm)),
      detector: new Uint8Array(readFileSync(files.yunet320)),
      embedder: new Uint8Array(readFileSync(files.sfaceOrt)),
    });
    let faces = 0;
    for (const name of readdirSync(fixtures).filter((n) => n.endsWith('.jpg'))) {
      // Renditions are at most 1600 px; the Rust reader shrinks anything larger itself.
      const jpg = await sharp!(readFileSync(path.join(fixtures, name))).resize({ width: 1600, height: 1600, fit: 'inside' }).png().toBuffer();
      const { data, info } = await sharp!(jpg).raw().toBuffer({ resolveWithObject: true });
      const webp = await sharp!(jpg).webp({ lossless: true }).toBuffer();
      const a = await readFaces({ px: data, width: info.width, height: info.height, channels: info.channels as 3 | 4 }, ortModels);
      const b = tract.read(new Uint8Array(webp));
      expect(a.length, name).toBe(b.length);
      for (let i = 0; i < a.length / FACE_STRIDE; i++) {
        const o = i * FACE_STRIDE;
        for (let k = 0; k < 5; k++) expect(Math.abs(a[o + k] - b[o + k]), `${name} face ${i} field ${k}`).toBeLessThan(0.01);
        let dot = 0;
        for (let k = 0; k < 128; k++) dot += a[o + 5 + k] * b[o + 5 + k];
        expect(dot, `${name} face ${i}`).toBeGreaterThan(0.9999);
        faces++;
      }
    }
    expect(faces).toBeGreaterThanOrEqual(15);
  }, 120_000);
});
