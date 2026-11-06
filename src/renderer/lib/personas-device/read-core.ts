// Ported from apps/web/src/lib/personas-device/read-core.ts - keep the two in step.
//
// The face reader's logic, free of the Worker shell so Node tests run the
// same code (reader.smoke.test.ts): fetch and check the reader wasm and both
// models, load them with the wasm-bindgen glue, and read one photo into faces
// with boxes as fractions of the image.
//
// Nothing here logs or sends anything: faces only go back to the caller.
import type { ReadFace } from '@dosya-dev/personas-engine';

export interface PinnedFile {
  /** File name under GET /api/personas/models/. */
  name: string;
  /** Lower-case hex SHA-256 of the exact bytes. */
  sha256: string;
}

/**
 * The reader wasm (packages/face-reader/dist) and the two models, with the
 * hashes apps/faces pinned for them (face-index/models.ts). Change a hash only
 * together with the published object.
 */
export const READER_FILES = {
  wasm: { name: 'face_reader_bg.wasm', sha256: '6ccea5f6c00c7e359b9c3ae765c5e6433b2e76dd31e4aa53be4d12ad096662ef' },
  // face_detection_yunet_2023mar.onnx (MIT)
  detector: { name: 'yunet-2023mar.onnx', sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4' },
  // face_recognition_sface_2021dec_f16.onnx (Apache-2.0)
  embedder: { name: 'sface-2021dec-f16.onnx', sha256: 'c810ba6f7c1a29e9d0e1434b4824fed42668f8df6266d841fe17084f18b0b123' },
} as const satisfies Record<string, PinnedFile>;

/**
 * The ONNX Runtime reader's files (lib/personas-device/ort): onnxruntime-web
 * 1.29.0's WebGPU-capable wasm (it runs the CPU backend too) and the two
 * models converted for it
 * (packages/face-reader/convert-ort-models.py). Same weights as READER_FILES.
 */
export const ORT_FILES = {
  wasm: { name: 'ort-wasm-simd-threaded-1.29.0.asyncify.wasm', sha256: '503d17cb7411b79781b9fad1cf0978f03cf06b050c7d399c730e914f473bf549' },
  detector: { name: 'yunet-2023mar-320.onnx', sha256: '43bd9174af4ff8107207bfb43bf03a2682031ecca26b3aade72ac80ef2db041b' },
  embedder: { name: 'sface-2021dec-f16-batch.onnx', sha256: '591694e8f7e1a48ecf20507aacea4199abd5fcf21410ea1fc60cb110f869aa15' },
} as const satisfies Record<string, PinnedFile>;

/** Floats per face in the reader's output: x, y, w, h, score, then the 128-float signature. */
const SIG_LEN = 128;
const FACE_STRIDE = 5 + SIG_LEN;

/** A downloaded reader file is not the pinned one. */
export class IntegrityError extends Error {
  constructor(name: string, expected: string, actual: string) {
    super(`face reader file ${name}: SHA-256 ${actual}, expected ${expected}`);
    this.name = 'IntegrityError';
  }
}

/** The photo is not a JPEG or WebP the reader can decode. */
export class PhotoUnsupportedError extends Error {
  constructor(message = 'photo cannot be decoded') {
    super(message);
    this.name = 'PhotoUnsupportedError';
  }
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as Uint8Array<ArrayBuffer>));
  let s = '';
  for (const b of d) s += b.toString(16).padStart(2, '0');
  return s;
}

export async function verifyBytes(bytes: Uint8Array, file: PinnedFile): Promise<Uint8Array> {
  const actual = await sha256Hex(bytes);
  if (actual !== file.sha256) throw new IntegrityError(file.name, file.sha256, actual);
  return bytes;
}

// ---- image size --------------------------------------------------------

const ascii = (b: Uint8Array, at: number, s: string) => [...s].every((c, i) => b[at + i] === c.charCodeAt(0));

function webpSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 30 || !ascii(b, 0, 'RIFF') || !ascii(b, 8, 'WEBP')) return null;
  if (ascii(b, 12, 'VP8 ')) {
    // Frame tag (3 bytes), start code 9d 01 2a, then 14-bit width and height.
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  if (ascii(b, 12, 'VP8L')) {
    // Signature 0x2f, then width-1 and height-1 in 14 bits each.
    if (b[20] !== 0x2f) return null;
    const bits = (b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24)) >>> 0;
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (ascii(b, 12, 'VP8X')) {
    // Flags (4 bytes), then canvas width-1 and height-1 in 24 bits each.
    return { width: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)), height: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)) };
  }
  return null;
}

function jpegSize(b: Uint8Array): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd9)) {
      i += 2; // markers without a length
      continue;
    }
    const len = (b[i + 2] << 8) | b[i + 3];
    if (len < 2) return null;
    // SOF0..SOF15 except DHT (c4), JPG (c8) and DAC (cc).
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (i + 9 > b.length) return null;
      return { height: (b[i + 5] << 8) | b[i + 6], width: (b[i + 7] << 8) | b[i + 8] };
    }
    if (m === 0xda) return null; // scan data before any frame header
    i += 2 + len;
  }
  return null;
}

/**
 * The encoded image's pixel size from its header (JPEG or WebP; null for
 * anything else). The reader reports boxes in these pixels: it does not apply
 * EXIF orientation, and neither does this.
 */
export function imageSize(b: Uint8Array): { width: number; height: number } | null {
  const s = jpegSize(b) ?? webpSize(b);
  return s && s.width > 0 && s.height > 0 ? s : null;
}

// ---- reading -----------------------------------------------------------

/** The reader's flat output (FACE_STRIDE floats per face, pixel boxes) as faces with boxes in fractions of width x height. */
export function facesFromFlat(flat: Float32Array, width: number, height: number): ReadFace[] {
  const faces: ReadFace[] = [];
  for (let o = 0; o + FACE_STRIDE <= flat.length; o += FACE_STRIDE) {
    faces.push({
      box: { x: flat[o] / width, y: flat[o + 1] / height, w: flat[o + 2] / width, h: flat[o + 3] / height },
      score: flat[o + 4],
      sig: flat.slice(o + 5, o + FACE_STRIDE),
    });
  }
  return faces;
}

/** What readPhoto needs of a reader: the tract FaceReader (sync) or the ONNX Runtime one (async). */
export interface PhotoReader {
  read(encoded: Uint8Array): Float32Array | Promise<Float32Array>;
}

/**
 * Read one encoded photo. Anything but a JPEG or WebP with a readable header,
 * or a photo the reader refuses to decode, is PhotoUnsupportedError; a wasm
 * trap (WebAssembly.RuntimeError) is passed through, since the reader's
 * memory may be broken after it.
 */
export async function readPhoto(reader: PhotoReader, photo: Uint8Array, opts: { errorsAreThePhotos?: boolean } = {}): Promise<ReadFace[]> {
  const size = imageSize(photo);
  if (!size) throw new PhotoUnsupportedError('not a JPEG or WebP');
  const theirs = opts.errorsAreThePhotos ?? true;
  let flat: Float32Array;
  try {
    flat = await reader.read(photo);
  } catch (e) {
    if (e instanceof WebAssembly.RuntimeError || e instanceof PhotoUnsupportedError) throw e;
    // The tract reader only fails on a photo it cannot decode; the ONNX
    // Runtime reader decodes first (PhotoUnsupportedError), so its other
    // errors are a failed read, tried again.
    if (!theirs) throw e;
    throw new PhotoUnsupportedError(e instanceof Error ? e.message : String(e));
  }
  return facesFromFlat(flat, size.width, size.height);
}

/** The parts of the wasm-bindgen glue (@dosya-dev/face-reader) the loader uses. */
export interface ReaderGlue {
  initSync(module: { module: WebAssembly.Module }): unknown;
  ModelBytes: new (detector: Uint8Array, embedder: Uint8Array) => unknown;
  FaceReader: new (models: never) => PhotoReader;
}

export interface ReaderBytes {
  wasm: Uint8Array;
  detector: Uint8Array;
  embedder: Uint8Array;
}

/**
 * Instantiate the reader wasm and parse both models (~0.3 s, ~106 MB of wasm
 * memory). The caller has verified the bytes. The glue holds one instance
 * per JS realm: after a trap, start a new realm (a new Worker).
 */
export async function loadReader(glue: ReaderGlue, bytes: ReaderBytes): Promise<PhotoReader> {
  const module = await WebAssembly.compile(bytes.wasm as Uint8Array<ArrayBuffer>);
  glue.initSync({ module });
  const models = new glue.ModelBytes(bytes.detector, bytes.embedder);
  return new glue.FaceReader(models as never);
}

/**
 * Fetch the three reader files from `${modelBase}/<name>`, each checked
 * against its pinned SHA-256 before use. The URL carries the hash (the route
 * ignores the query): the route answers immutable for a year, and a file
 * replaced under the same name must not be served from an old cache entry.
 */
/** One reader file from the models route, checked against its pinned SHA-256. */
export async function fetchPinned(modelBase: string, f: PinnedFile, fetchFn: typeof fetch = fetch): Promise<Uint8Array> {
  let bytes: Uint8Array;
  try {
    const res = await fetchFn(`${modelBase}/${f.name}?v=${f.sha256.slice(0, 16)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    bytes = new Uint8Array(await res.arrayBuffer());
  } catch (e) {
    // Offline, a dropped connection, a body cut short: all "face reader file".
    throw new Error(`face reader file ${f.name}: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  return verifyBytes(bytes, f);
}

export async function fetchReaderBytes(modelBase: string, fetchFn: typeof fetch = fetch): Promise<ReaderBytes> {
  const get = (f: PinnedFile) => fetchPinned(modelBase, f, fetchFn);
  // One after the other: the embedder alone is ~19 MB.
  const wasm = await get(READER_FILES.wasm);
  const detector = await get(READER_FILES.detector);
  const embedder = await get(READER_FILES.embedder);
  return { wasm, detector, embedder };
}

// ---- worker protocol ---------------------------------------------------

export interface WorkerRequest {
  id: number;
  /** Absolute URL of GET /api/personas/models. */
  modelBase: string;
  photo: Uint8Array;
}

/**
 * unsupported: the photo cannot be decoded (journaled as such).
 * trap: wasm trapped on this photo; the worker must be replaced.
 * failed: reading this photo failed otherwise (retried, then journaled as failed).
 * unavailable: the reader itself could not load (download or SHA-256 check
 * failed); says nothing about the photo and must never be journaled.
 */
export type WorkerFailure = 'unsupported' | 'trap' | 'failed' | 'unavailable';

export type WorkerReply =
  | { id: number; ok: true; faces: ReadFace[] }
  | { id: number; ok: false; kind: WorkerFailure; message: string };

export function failureKind(e: unknown): WorkerFailure {
  if (e instanceof PhotoUnsupportedError) return 'unsupported';
  if (typeof WebAssembly !== 'undefined' && e instanceof WebAssembly.RuntimeError) return 'trap';
  return 'failed';
}
