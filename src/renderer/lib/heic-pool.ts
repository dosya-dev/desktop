// Ported from apps/web/src/lib/heic-pool.ts — keep in sync with the web copy.
/** Minimal surface of a Worker that the pool needs. Lets tests inject a fake. */
export interface PoolWorker {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: { data: unknown }) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onmessageerror: ((e: unknown) => void) | null;
}

export interface HeicPool {
  decode(url: string, maxDim: number): Promise<Blob>;
  size: number;
}

interface WorkerReply {
  id: number;
  blob?: Blob;
  error?: string;
}

interface Job {
  id: number;
  url: string;
  maxDim: number;
  resolve: (b: Blob) => void;
  reject: (e: Error) => void;
}

interface PoolEntry {
  worker: PoolWorker;
  /** The job currently posted to this worker, or null if it's idle. */
  current: Job | null;
}

/**
 * A pool of decode workers, fronting `heic.worker.ts` instances.
 *
 * A single Worker is single-threaded, so posting every decode to one shared
 * worker serializes CPU-bound work onto one core no matter how many decodes
 * the cache admits concurrently. This spreads decodes across up to `size`
 * workers so they actually run in parallel.
 *
 * Worker-free and Worker-construction-free by design (the constructor is
 * injected via `spawn`) so this stays importable — and testable — under
 * jsdom, which cannot construct a real Worker.
 */
export function createHeicPool(opts: { spawn: () => PoolWorker; size: number }): HeicPool {
  const { spawn, size } = opts;

  const workers: PoolEntry[] = [];
  const queue: Job[] = [];
  let nextId = 0;

  function bind(entry: PoolEntry): void {
    entry.worker.onmessage = (e: { data: unknown }) => {
      const { id, blob, error } = e.data as WorkerReply;
      const job = entry.current;
      // Free the worker before touching the caller's promise, so a failure
      // in resolve/reject (there shouldn't be one, but just in case) can
      // never leave the slot marked busy forever.
      entry.current = null;
      try {
        if (!job || job.id !== id) return; // stale or unrecognized reply; ignore
        if (error !== undefined || !blob) job.reject(new Error(error ?? 'HEIC decode failed'));
        else job.resolve(blob);
      } finally {
        pump();
      }
    };

    entry.worker.onerror = () => {
      fail(entry, new Error('HEIC decoder crashed'));
    };

    entry.worker.onmessageerror = () => {
      fail(entry, new Error('HEIC decoder message error'));
    };
  }

  /** The worker died. Reject whatever it was running, discard it, keep the rest of the pool alive. */
  function fail(entry: PoolEntry, err: Error): void {
    const job = entry.current;
    entry.current = null;
    try {
      job?.reject(err);
    } finally {
      entry.worker.terminate();
      const idx = workers.indexOf(entry);
      if (idx !== -1) workers.splice(idx, 1);
      // A later request must be able to spawn a fresh worker in this slot,
      // and any already-queued work should get a chance to run now.
      pump();
    }
  }

  /** Assign queued jobs to idle workers, spawning new workers (lazily, up to `size`) as needed. */
  function pump(): void {
    while (queue.length > 0) {
      let entry = workers.find((w) => w.current === null);
      if (!entry) {
        if (workers.length >= size) break; // at capacity; job stays queued
        let worker: PoolWorker;
        try {
          worker = spawn();
        } catch (err) {
          // Worker construction failed. Reject the head job rather than leaving
          // it stranded in the queue — a stranded job would poison every future
          // pump() (re-throwing here) and never settle its caller's promise.
          const job = queue.shift()!;
          job.reject(err instanceof Error ? err : new Error('HEIC worker spawn failed'));
          continue;
        }
        entry = { worker, current: null };
        bind(entry);
        workers.push(entry);
      }
      const job = queue.shift()!;
      entry.current = job;
      entry.worker.postMessage({ id: job.id, url: job.url, maxDim: job.maxDim });
    }
  }

  function decode(url: string, maxDim: number): Promise<Blob> {
    return new Promise<Blob>((resolve, reject) => {
      queue.push({ id: ++nextId, url, maxDim, resolve, reject });
      pump();
    });
  }

  return { decode, size };
}
