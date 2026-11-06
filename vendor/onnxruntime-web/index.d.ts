// The part of onnxruntime-web 1.29.0's API the Personas reader uses
// (lib/personas-device/ort). The bundle next to this file is vendored
// unchanged; see LICENSE.
export declare class Tensor {
  constructor(type: 'float32', data: Float32Array, dims: readonly number[]);
  readonly data: Float32Array;
  readonly dims: readonly number[];
  dispose(): void;
}

export declare namespace InferenceSession {
  interface SessionOptions {
    executionProviders?: readonly ('wasm' | 'webgpu')[];
    graphOptimizationLevel?: 'disabled' | 'basic' | 'extended' | 'all';
    enableCpuMemArena?: boolean;
    enableMemPattern?: boolean;
  }
}

export declare class InferenceSession {
  static create(model: Uint8Array, options?: InferenceSession.SessionOptions): Promise<InferenceSession>;
  readonly inputNames: readonly string[];
  readonly outputNames: readonly string[];
  run(feeds: Record<string, Tensor>): Promise<Record<string, Tensor>>;
  release(): Promise<void>;
}

export declare const env: {
  logLevel?: 'verbose' | 'info' | 'warning' | 'error' | 'fatal';
  wasm: {
    numThreads?: number;
    proxy?: boolean;
    simd?: boolean;
    /** The wasm bytes; when set, ONNX Runtime fetches nothing. */
    wasmBinary?: ArrayBufferLike | Uint8Array | undefined;
    wasmPaths?: string | { wasm?: string; mjs?: string };
  };
};
