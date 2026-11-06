// Ported from apps/web/src/lib/personas-device/reader.ts - keep the two in step.
//
// The web FaceReaderPort: reads photos in reader.worker.ts, one at a time.
// The worker is spawned on the first read and let go after a minute without
// reads (it holds ~106 MB of wasm memory); a crash or wasm trap replaces it.
import { ReaderUnsupportedError, type FaceReaderPort, type ReadFace } from '@dosya-dev/personas-engine';
import { PersonasUnavailableError } from './errors';
import type { WorkerReply, WorkerRequest } from './read-core';

/**
 * The reader could not load (the wasm or a model failed to download or did
 * not match its SHA-256). Not the photo's fault: engine-host aborts the read
 * so the engine journals nothing for it, and tries again later.
 */
export class ReaderUnavailableError extends PersonasUnavailableError {
  constructor(message = 'face reader unavailable') {
    super(message);
    this.name = 'ReaderUnavailableError';
  }
}

/** What reader.ts needs of a Worker (tests pass a fake). */
export interface ReaderWorker {
  postMessage(msg: WorkerRequest, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent<WorkerReply>) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export interface WebReaderOptions {
  spawn?: () => ReaderWorker;
  /** Idle time before the worker is let go. */
  idleMs?: number;
  /** Longest one read may take once the reader has loaded. */
  readTimeoutMs?: number;
  /** Longest the first read of a worker may take (it downloads and loads the reader). */
  loadTimeoutMs?: number;
}

export interface WebReader extends FaceReaderPort {
  /** Let the worker go now (sign-out); the next read starts a new one. */
  dispose(): void;
}

// The smallest module using a v128 instruction (wasm-feature-detect's SIMD probe).
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11,
]);

/** The reader needs Web Workers and WebAssembly with SIMD (the wasm is built with simd128). */
export function readerSupported(): boolean {
  try {
    return typeof Worker === 'function' && typeof WebAssembly === 'object' && WebAssembly !== null && WebAssembly.validate(SIMD_PROBE);
  } catch {
    return false;
  }
}

function defaultSpawn(): ReaderWorker {
  return new Worker(new URL('./reader.worker.ts', import.meta.url), { type: 'module', name: 'personas-reader' }) as unknown as ReaderWorker;
}

function absolute(url: string): string {
  try {
    return new URL(url, globalThis.location?.href).href;
  } catch {
    return url;
  }
}

/**
 * A FaceReaderPort reading in a Web Worker. `modelBase` is the models route,
 * `${API_BASE}/api/personas/models`; the worker fetches the reader wasm and
 * both models there and checks their SHA-256 before loading them.
 */
export function createWebReader(modelBase: string, opts: WebReaderOptions = {}): WebReader {
  const spawn = opts.spawn ?? defaultSpawn;
  const idleMs = opts.idleMs ?? 60_000;
  const readTimeoutMs = opts.readTimeoutMs ?? 60_000;
  const loadTimeoutMs = opts.loadTimeoutMs ?? 120_000;
  const base = absolute(modelBase).replace(/\/+$/, '');
  let worker: ReaderWorker | null = null;
  /** The current worker has answered at least once with its reader loaded. */
  let loaded = false;
  let idle: ReturnType<typeof setTimeout> | null = null;
  let queue: Promise<unknown> = Promise.resolve();
  let nextId = 1;
  /** Bumped when the reader proved unavailable or was let go: reads queued before fail at once. */
  let epoch = 0;

  const drop = (w: ReaderWorker) => {
    w.onmessage = null;
    w.onerror = null;
    w.terminate();
    if (worker === w) worker = null;
  };

  const readNow = (photo: Uint8Array): Promise<ReadFace[]> =>
    new Promise<ReadFace[]>((resolve, reject) => {
      if (idle) clearTimeout(idle);
      idle = null;
      if (!worker) {
        try {
          worker = spawn();
          loaded = false;
        } catch (e) {
          reject(new ReaderUnavailableError(e instanceof Error ? e.message : String(e)));
          return;
        }
      }
      const w = worker;
      const id = nextId++;
      // A worker that hangs (a photo the decoder never finishes, a download
      // that stalls) is let go: before the reader loaded it is not the
      // photo's fault, after it is.
      const timeout = setTimeout(() => {
        const wasLoaded = loaded;
        drop(w);
        reject(wasLoaded ? new Error('face reader timed out') : new ReaderUnavailableError('face reader timed out loading'));
      }, loaded ? readTimeoutMs : loadTimeoutMs);
      const settle = () => clearTimeout(timeout);
      w.onmessage = (ev) => {
        const r = ev.data;
        if (!r || r.id !== id) return;
        settle();
        if (r.ok || r.kind !== 'unavailable') loaded = true;
        if (r.ok) return resolve(r.faces);
        if (r.kind === 'trap') drop(w);
        reject(
          r.kind === 'unsupported' ? new ReaderUnsupportedError(r.message)
            : r.kind === 'unavailable' ? new ReaderUnavailableError(r.message)
              : new Error(r.message),
        );
      };
      w.onerror = () => {
        settle();
        // Before the reader ever loaded, the worker script itself may not
        // have (offline, blocked): not the photo's fault. After, the photo
        // took the worker down.
        const wasLoaded = loaded;
        drop(w);
        reject(wasLoaded ? new Error('face reader worker stopped') : new ReaderUnavailableError('face reader worker stopped'));
      };
      // The bytes move to the worker; a view into a larger buffer is copied first.
      const own = photo.byteOffset === 0 && photo.byteLength === photo.buffer.byteLength && photo.buffer instanceof ArrayBuffer ? photo : photo.slice();
      try {
        w.postMessage({ id, modelBase: base, photo: own }, [own.buffer as ArrayBuffer]);
      } catch (e) {
        settle();
        throw e;
      }
    }).finally(() => {
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        idle = null;
        if (worker) drop(worker);
      }, idleMs);
    });

  return {
    read(photo) {
      // Reads queued behind one that found the reader unavailable, or queued
      // when the reader was let go, fail at once instead of each loading it
      // again (the engine keeps several photos in flight).
      const at = epoch;
      const run = queue.then(() => {
        if (at !== epoch) throw new ReaderUnavailableError('face reader stopped');
        return readNow(photo);
      });
      queue = run.catch((e) => {
        if (e instanceof ReaderUnavailableError && at === epoch) epoch++;
      });
      return run;
    },
    dispose() {
      epoch++;
      if (idle) clearTimeout(idle);
      idle = null;
      // A read in flight then fails as the worker stopping would.
      if (worker) worker.onerror?.(new Event('error'));
      if (worker) drop(worker);
    },
  };
}
