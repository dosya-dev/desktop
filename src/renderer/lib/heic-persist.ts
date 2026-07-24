// Ported from apps/web/src/lib/heic-persist.ts — keep in sync with the web copy.
/**
 * Persistent store for decoded HEIC thumbnails, backed by the Cache API.
 *
 * The in-memory LRU in `heic-cache.ts` is wiped on every page reload, so without
 * this a refresh re-downloads each ~5MB original and re-runs the ~1s WASM decode
 * for every visible 24MP photo. The Cache API survives reloads, so a
 * previously-decoded thumbnail is served instantly with no network and no decode.
 *
 * Everything here degrades gracefully: if the Cache API is unavailable (private
 * mode, disabled storage, quota errors), reads return null and writes are no-ops,
 * so the pipeline simply falls back to decoding — never throws.
 */

const CACHE_NAME = 'heic-thumbs-v1';
/** Cap the number of stored thumbnails so the cache can't grow without bound. */
const MAX_ENTRIES = 400;

/** A synthetic same-origin request URL for a cache key (Cache API keys are Requests). */
function keyToRequest(key: string): string {
  return `https://heic-thumb.local/${encodeURIComponent(key)}`;
}

async function openCache(): Promise<Cache | null> {
  try {
    if (typeof caches === 'undefined') return null;
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

/** Returns the persisted thumbnail blob for `key`, or null on miss / any failure. */
export async function persistGet(key: string): Promise<Blob | null> {
  try {
    const cache = await openCache();
    if (!cache) return null;
    const res = await cache.match(keyToRequest(key));
    if (!res) return null;
    return await res.blob();
  } catch {
    return null;
  }
}

/**
 * Stores `blob` under `key`. Fire-and-forget: kicks off async work and swallows
 * every error so it can never delay or break the preview it just decoded.
 */
export function persistPut(key: string, blob: Blob): void {
  void (async () => {
    try {
      const cache = await openCache();
      if (!cache) return;
      await cache.put(keyToRequest(key), new Response(blob));
      await pruneToCap(cache);
    } catch {
      // ignore — persistence is best-effort
    }
  })();
}

/**
 * Bounds the cache size. Cache API `keys()` returns entries in insertion order,
 * so the oldest-written are at the front — delete from there until under the cap.
 */
async function pruneToCap(cache: Cache): Promise<void> {
  try {
    const keys = await cache.keys();
    const over = keys.length - MAX_ENTRIES;
    for (let i = 0; i < over; i++) {
      await cache.delete(keys[i]);
    }
  } catch {
    // ignore
  }
}
