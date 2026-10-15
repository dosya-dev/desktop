// Ported from apps/web/src/lib/heic-pool.ts - keep in sync with the web copy.
// Exception: idle-worker teardown (idleMs/schedule/cancel/destroy) below is a
// desktop-only addition (DSK-009) and has not been ported back to web yet.
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
  /**
   * Terminates every live worker (cancelling any pending idle timers first)
   * and rejects whatever is still queued. Call on logout: an account's
   * decode machinery - and the WASM heap high-water mark each worker is
   * holding - should go with its LRU, not linger for the next session.
   */
  destroy(): void;
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
  /** Handle for a pending idle-termination timer, or null if none is armed. */
  idleTimer: unknown | null;
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
 * injected via `spawn`) so this stays importable - and testable - under
 * jsdom, which cannot construct a real Worker.
 */
export function createHeicPool(opts: {
  spawn: () => PoolWorker;
  size: number;
  /**
   * How long an unused worker sits idle before it's terminated to release
   * its WASM heap. Each worker's linear memory only grows (WebAssembly.Memory
   * cannot shrink) to fit the largest photo it has decoded - up to ~190MB for
   * a 48MP source - so leaving it running for the rest of the session retains
   * that high-water mark for nothing. Defaults to 30s.
   */
  idleMs?: number;
  /**
   * Injected timer primitives (default: setTimeout/clearTimeout) so tests can
   * drive idle termination without a real clock - same reason `spawn` is
   * injected instead of this module constructing a real Worker.
   */
  schedule?: (fn: () => void, ms: number) => unknown;
  cancel?: (handle: unknown) => void;
}): HeicPool {
  const { spawn, size } = opts;
  const idleMs = opts.idleMs ?? 30000;
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number) => {
      const handle = setTimeout(fn, ms);
      // In a browser (the real renderer) setTimeout's return value has no
      // unref - this is a no-op there. Under Node (e.g. this module's own
      // unit tests, which don't inject a fake clock), unref keeps an idle
      // worker's timer from holding the process open for 30s after every
      // test that merely let a decode finish.
      (handle as { unref?: () => void }).unref?.();
      return handle;
    });
  const cancel = opts.cancel ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const workers: PoolEntry[] = [];
  const queue: Job[] = [];
  let nextId = 0;

  /** Worker just went idle (no job in flight) - arm its termination timer. */
  function armIdle(entry: PoolEntry): void {
    entry.idleTimer = schedule(() => {
      entry.idleTimer = null;
      entry.worker.terminate();
      const idx = workers.indexOf(entry);
      if (idx !== -1) workers.splice(idx, 1);
    }, idleMs);
  }

  /** Worker is about to do (or already doing) work - a pending idle timer no longer applies. */
  function cancelIdle(entry: PoolEntry): void {
    if (entry.idleTimer !== null) {
      cancel(entry.idleTimer);
      entry.idleTimer = null;
    }
  }

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
        // pump() may have handed this worker the next queued job already; only
        // a worker that's still idle after that is a candidate for teardown.
        if (entry.current === null && workers.includes(entry)) armIdle(entry);
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
    cancelIdle(entry); // defensive: a busy worker shouldn't have one armed, but never leak a timer
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
          // it stranded in the queue - a stranded job would poison every future
          // pump() (re-throwing here) and never settle its caller's promise.
          const job = queue.shift()!;
          job.reject(err instanceof Error ? err : new Error('HEIC worker spawn failed'));
          continue;
        }
        entry = { worker, current: null, idleTimer: null };
        bind(entry);
        workers.push(entry);
      }
      // This entry is about to get work (or was already idle-timer-armed
      // from a previous job) - either way, a pending idle timer no longer
      // applies.
      cancelIdle(entry);
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

  function destroy(): void {
    for (const entry of workers) {
      cancelIdle(entry);
      entry.worker.terminate();
      entry.current?.reject(new Error('HEIC pool destroyed'));
      entry.current = null;
    }
    workers.length = 0;
    const stranded = queue.splice(0, queue.length);
    for (const job of stranded) job.reject(new Error('HEIC pool destroyed'));
  }

  return { decode, size, destroy };
}
