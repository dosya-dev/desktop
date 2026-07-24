// Ported from apps/web/src/lib/heic.ts — keep in sync with the web copy.
import { createHeicCache, type HeicRequest } from '@/lib/heic-cache';
import { createHeicPool, type PoolWorker } from '@/lib/heic-pool';
import { persistGet, persistPut } from '@/lib/heic-persist';

// Decoding is CPU-bound and a single Worker is single-threaded, so one shared
// worker would serialize every decode onto one core no matter how many the
// cache admits at once. A pool of workers spreads decodes across cores instead.
//
// Sized off `hardwareConcurrency`, floored at 2 (still worth parallelizing on
// a dual-core machine) and capped at 4: each worker can hold a full-size
// decoded RGBA bitmap (tens of MB for a 12MP photo) while it works, so more
// workers also means more peak memory, not just more CPU.
const poolSize = Math.max(2, Math.min(4, (navigator.hardwareConcurrency ?? 4) - 1));

// Workers are spawned lazily by the pool itself, so a session that never
// opens a HEIC never spawns one.
const pool = createHeicPool({
  // `PoolWorker` is deliberately narrower than DOM's `Worker` (so tests can inject a
  // fake without ever constructing a real one); a real Worker satisfies it at
  // runtime (postMessage/terminate/onmessage/onerror/onmessageerror all exist with
  // compatible behavior), but its `on*` handler types are more specific
  // (`MessageEvent`/`ErrorEvent`, not `PoolWorker`'s minimal `{ data: unknown }`/
  // `unknown`), so the assignment needs an explicit cast.
  spawn: () =>
    new Worker(new URL('./heic.worker.ts', import.meta.url), { type: 'module' }) as unknown as PoolWorker,
  size: poolSize,
});

// The cache's concurrency cap must match the pool size: if it admitted fewer
// decodes than there are workers, some workers would always sit idle; if it
// admitted more, the extra decodes would just queue inside the pool anyway.
//
// `persistGet`/`persistPut` back the in-memory LRU with the Cache API, so a
// decoded thumbnail survives a page reload — a refresh serves it without
// re-downloading the original or re-running the WASM decode.
const cache = createHeicCache({
  decoder: (url, maxDim) => pool.decode(url, maxDim),
  concurrency: pool.size,
  persistGet,
  persistPut,
});

/** Resolves to an object URL for a decoded, downscaled preview of a HEIC file. */
export function getHeicPreviewUrl(req: HeicRequest): Promise<string> {
  return cache.get(req);
}
