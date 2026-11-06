// Ported from apps/web/src/lib/personas-device/ort/models.ts - keep the two in step.
//
// YuNet and SFace on ONNX Runtime Web (vendored onnxruntime-web 1.29.0,
// the WebGPU build, which also runs the CPU backend). The caller hands over
// every file's bytes, already checked against their pinned SHA-256: ONNX
// Runtime fetches nothing itself (env.wasm.wasmBinary).
//
// Backends, from measurements on an Apple M-series Mac in Chrome:
// - YuNet always on the CPU (wasm): 7 ms, faster than WebGPU's 10 ms.
// - SFace on WebGPU when the device has an adapter: 3.6 ms per face in a
//   batch of 8, against 35 ms per face on the CPU. A WebGPU session that
//   cannot be created, or a run that fails (the GPU was lost), moves SFace to
//   the CPU for the rest of the reader's life.
//
// ONNX Runtime keeps one wasm instance per JS realm, so a reader worker loads
// this once; after a wasm trap the worker is replaced, as with the tract reader.
import * as ort from '@dosya-dev/onnxruntime-web';
import { DETECT_SIZE, EMBED_SIZE, type FaceModels, type YunetOutputs } from './pipeline';

export interface OrtBytes {
  /** onnxruntime-web's WebGPU-capable wasm. */
  wasm: Uint8Array;
  /** yunet-2023mar-320.onnx */
  detector: Uint8Array;
  /** sface-2021dec-f16-batch.onnx */
  embedder: Uint8Array;
}

export type Backend = 'webgpu' | 'wasm';

export interface OrtModels extends FaceModels {
  /** Where SFace runs now. */
  embedBackend(): Backend;
}

const YUNET_OUTPUTS = ['cls_8', 'cls_16', 'cls_32', 'obj_8', 'obj_16', 'obj_32', 'bbox_8', 'bbox_16', 'bbox_32', 'kps_8', 'kps_16', 'kps_32'];

const options = (ep: Backend): ort.InferenceSession.SessionOptions => ({ executionProviders: [ep], graphOptimizationLevel: 'all' });

/** Whether this realm has a WebGPU adapter; never waits more than 5 s for it. */
export async function hasWebGpu(): Promise<boolean> {
  const gpu = (globalThis.navigator as { gpu?: { requestAdapter(): Promise<unknown> } } | undefined)?.gpu;
  if (!gpu || typeof gpu.requestAdapter !== 'function') return false;
  try {
    const adapter = await Promise.race([gpu.requestAdapter(), new Promise<null>((r) => setTimeout(() => r(null), 5000))]);
    return adapter != null;
  } catch {
    return false;
  }
}

let configured = false;

/** Load both models. Call once per realm. `gpu: false` keeps SFace on the CPU. */
export async function loadOrtModels(bytes: OrtBytes, opts: { gpu?: boolean } = {}): Promise<OrtModels> {
  if (!configured) {
    ort.env.logLevel = 'error';
    // One thread, no proxy worker: the reader pool runs readers side by side,
    // and threads would need cross-origin isolation.
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.proxy = false;
    ort.env.wasm.wasmBinary = bytes.wasm;
    configured = true;
  }
  const detector = await ort.InferenceSession.create(bytes.detector, options('wasm'));
  // The wasm is compiled now; do not keep its 25.7 MB in JS for the realm's life.
  ort.env.wasm.wasmBinary = undefined;

  let backend: Backend = 'wasm';
  let embedder: ort.InferenceSession | null = null;
  try {
    const missing = YUNET_OUTPUTS.filter((n) => !detector.outputNames.includes(n));
    if (missing.length) throw new Error(`unexpected YuNet outputs, missing ${missing.join(', ')}`);
    if (opts.gpu !== false && (await hasWebGpu())) {
      try {
        embedder = await ort.InferenceSession.create(bytes.embedder, options('webgpu'));
        backend = 'webgpu';
      } catch {
        embedder = null;
      }
    }
    embedder ??= await ort.InferenceSession.create(bytes.embedder, options('wasm'));
  } catch (e) {
    // The worker falls back to tract: do not leave this session's memory behind.
    void detector.release().catch(() => undefined);
    throw e;
  }
  // Kept only while SFace is on WebGPU, to fall back to the CPU.
  let embedderBytes: Uint8Array | null = backend === 'webgpu' ? bytes.embedder : null;

  const runEmbed = async (s: ort.InferenceSession, input: Float32Array, n: number) => {
    const t = new ort.Tensor('float32', input, [n, 3, EMBED_SIZE, EMBED_SIZE]);
    const r = await s.run({ [s.inputNames[0]]: t });
    return r[s.outputNames[0]].data;
  };

  /** The move to the CPU, shared by every run that finds the GPU gone. */
  let toCpu: Promise<void> | null = null;
  const moveToCpu = (): Promise<void> =>
    (toCpu ??= (async () => {
      const cpu = await ort.InferenceSession.create(embedderBytes!, options('wasm'));
      const gpu = embedder!;
      embedder = cpu;
      backend = 'wasm';
      embedderBytes = null;
      void gpu.release().catch(() => undefined);
    })().catch((e) => {
      toCpu = null; // a failed move (out of memory, say) is tried again on the next run
      throw e;
    }));

  return {
    embedBackend: () => backend,
    async detect(input) {
      const t = new ort.Tensor('float32', input, [1, 3, DETECT_SIZE, DETECT_SIZE]);
      const r = await detector.run({ [detector.inputNames[0]]: t });
      const outs: YunetOutputs = {};
      for (const n of YUNET_OUTPUTS) outs[n] = r[n].data;
      return outs;
    },
    async embed(input, n) {
      const session = embedder!;
      try {
        return await runEmbed(session, input, n);
      } catch (e) {
        if (!toCpu && (backend !== 'webgpu' || !embedderBytes)) throw e;
        // The GPU failed us: the CPU from now on.
        await moveToCpu();
        return runEmbed(embedder!, input, n);
      }
    },
  };
}
