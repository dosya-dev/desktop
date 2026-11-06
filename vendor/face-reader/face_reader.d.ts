/* tslint:disable */
/* eslint-disable */
/**
 * An encoded photo copied into wasm memory, not decoded yet. Copying and
 * decoding are separate calls so JS can drop its own copy in between, as
 * with ModelBytes: the decode is the photo's memory peak.
 */
export class EncodedPhoto {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * An empty photo of exactly `size` bytes to come, filled by `append`
   * chunk by chunk (a streamed R2 body), so JS never holds it whole.
   */
  static with_capacity(size: number): EncodedPhoto;
  /**
   * Bytes appended so far.
   */
  len(): number;
  constructor(bytes: Uint8Array);
  /**
   * Adds the next chunk; refuses to go past the announced size.
   */
  append(chunk: Uint8Array): void;
  is_empty(): boolean;
}
/**
 * Both models, parsed and optimised once.
 */
export class FaceReader {
  free(): void;
  [Symbol.dispose](): void;
  /**
   * `crop_jpeg` for a photo already copied into wasm, which it consumes.
   */
  crop_photo(photo: EncodedPhoto, x: number, y: number, w: number, h: number, size: number): Uint8Array;
  /**
   * `read` for a photo already copied into wasm (EncodedPhoto), which it
   * consumes: JS can release its own copy before the decode.
   */
  read_photo(photo: EncodedPhoto): Float32Array;
  /**
   * Parses and optimises both models, consuming `models`.
   */
  constructor(models: ModelBytes);
  /**
   * Decodes an encoded JPEG or WebP (downscaled to 1600 px on the long
   * side if larger) and reads it; returns FACE_STRIDE floats per face
   * (x, y, w, h, score, then the 128-float L2-normalised vector). Boxes are
   * in the ENCODED image's pixels, whatever size it was read at. Takes the
   * bytes by value so they are freed as soon as they are decoded; the
   * pixels are freed when the call returns.
   */
  read(encoded: Uint8Array): Float32Array;
  /**
   * The JPEG crop (`size` x `size`, quality 85) of the face at (x, y, w,
   * h) in the ENCODED image's pixels: a square with a 25 % margin on each
   * side, clamped to the image (src/crop.rs). Same decode path and limits
   * as `read`; the models are not used. A method on the reader so JS runs
   * it in the same one-photo-at-a-time queue, after the models' load.
   */
  crop_jpeg(encoded: Uint8Array, x: number, y: number, w: number, h: number, size: number): Uint8Array;
}
/**
 * Both model files copied into wasm memory, not parsed yet. Copying and
 * parsing are separate calls so JS can drop its own copy of the bytes in
 * between: parsing is the memory peak, and JS must not hold ~20 MB then.
 */
export class ModelBytes {
  free(): void;
  [Symbol.dispose](): void;
  constructor(detector: Uint8Array, embedder: Uint8Array);
}

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
  readonly memory: WebAssembly.Memory;
  readonly __wbg_encodedphoto_free: (a: number, b: number) => void;
  readonly __wbg_facereader_free: (a: number, b: number) => void;
  readonly __wbg_modelbytes_free: (a: number, b: number) => void;
  readonly encodedphoto_append: (a: number, b: number, c: number) => [number, number];
  readonly encodedphoto_is_empty: (a: number) => number;
  readonly encodedphoto_len: (a: number) => number;
  readonly encodedphoto_new: (a: number, b: number) => number;
  readonly encodedphoto_with_capacity: (a: number) => [number, number, number];
  readonly facereader_crop_jpeg: (a: number, b: number, c: number, d: number, e: number, f: number, g: number, h: number) => [number, number, number, number];
  readonly facereader_crop_photo: (a: number, b: number, c: number, d: number, e: number, f: number, g: number) => [number, number, number, number];
  readonly facereader_new: (a: number) => [number, number, number];
  readonly facereader_read: (a: number, b: number, c: number) => [number, number, number, number];
  readonly facereader_read_photo: (a: number, b: number) => [number, number, number, number];
  readonly modelbytes_new: (a: number, b: number, c: number, d: number) => number;
  readonly __wbindgen_exn_store_command_export: (a: number) => void;
  readonly __externref_table_alloc_command_export: () => number;
  readonly __wbindgen_export_2: WebAssembly.Table;
  readonly __externref_table_dealloc_command_export: (a: number) => void;
  readonly __wbindgen_free_command_export: (a: number, b: number, c: number) => void;
  readonly __wbindgen_malloc_command_export: (a: number, b: number) => number;
  readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;
/**
* Instantiates the given `module`, which can either be bytes or
* a precompiled `WebAssembly.Module`.
*
* @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
*
* @returns {InitOutput}
*/
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
* If `module_or_path` is {RequestInfo} or {URL}, makes a request and
* for everything else, calls `WebAssembly.instantiate` directly.
*
* @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
*
* @returns {Promise<InitOutput>}
*/
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
