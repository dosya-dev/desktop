// Ported from apps/web/src/lib/heic-cache.ts — keep in sync with the web copy.
import { fileRawUrl, type FileRef } from '@/lib/file-url';

export interface HeicRequest extends FileRef {
  /** Longest edge of the decoded output, in px. Thumbs want ~256, the lightbox ~2048. */
  maxDim: number;
}

/** Fetches `url` and returns a decoded, downscaled raster blob. Injected so this module stays testable. */
export type HeicDecoder = (url: string, maxDim: number) => Promise<Blob>;

export function heicCacheKey({ fileId, version, maxDim }: HeicRequest): string {
  return `${fileId}:${version ?? 0}:${maxDim}`;
}

interface HeicCacheOptions {
  decoder: HeicDecoder;
  maxEntries?: number;
  concurrency?: number;
  createUrl?: (blob: Blob) => string;
  revokeUrl?: (url: string) => void;
  /**
   * Optional persistent store (e.g. Cache API) that survives a page reload.
   * Injected so this module stays free of browser-only globals and testable.
   * `persistGet` must never reject (return null on any failure); `persistPut`
   * is fire-and-forget and must swallow its own errors.
   */
  persistGet?: (key: string) => Promise<Blob | null>;
  persistPut?: (key: string, blob: Blob) => void;
}

/**
 * Caches decoded HEIC previews as object URLs.
 *
 * Decoding a 12MP iPhone photo costs ~0.3-1.5s of WASM, and a folder can hold
 * dozens of them, so this does the three things that keep that survivable:
 * dedupes concurrent requests for the same photo, caps how many decode at once,
 * and bounds memory with an LRU that revokes the URLs it drops.
 */
export function createHeicCache(opts: HeicCacheOptions) {
  const maxEntries = opts.maxEntries ?? 60;
  const concurrency = opts.concurrency ?? 3;
  const createUrl = opts.createUrl ?? ((b: Blob) => URL.createObjectURL(b));
  const revokeUrl = opts.revokeUrl ?? ((u: string) => URL.revokeObjectURL(u));

  // Map preserves insertion order, so the first key is the least-recently-used.
  const entries = new Map<string, string>();
  const inflight = new Map<string, Promise<string>>();

  let active = 0;
  // Queued starters, not queued promises: each entry *starts* the decode (and
  // therefore calls the decoder) the moment a slot frees up. This must happen
  // synchronously with `release()` — an `await`-based gate here would delay
  // the decoder call by a microtask tick, which breaks callers (like the
  // controllable-decoder tests) that inspect "how many decodes started" or
  // resolve pending decodes before yielding back to the event loop.
  const waiting: Array<() => void> = [];

  function touch(key: string): string | undefined {
    const url = entries.get(key);
    if (url === undefined) return undefined;
    entries.delete(key);
    entries.set(key, url); // re-insert as most-recently-used
    return url;
  }

  function insert(key: string, url: string): void {
    entries.set(key, url);
    while (entries.size > maxEntries) {
      const lru = entries.keys().next().value as string;
      const dead = entries.get(lru)!;
      entries.delete(lru);
      revokeUrl(dead);
    }
  }

  async function decode(req: HeicRequest, key: string): Promise<string> {
    try {
      // Persistent hit (Cache API) survives a page reload: skip the ~5MB
      // original download AND the ~1s WASM decode entirely.
      let blob = opts.persistGet ? await opts.persistGet(key) : null;
      if (!blob) {
        blob = await opts.decoder(fileRawUrl(req), req.maxDim);
        // Fire-and-forget: persisting must not delay the preview.
        opts.persistPut?.(key, blob);
      }
      const url = createUrl(blob);
      insert(key, url);
      return url;
    } finally {
      // Both must run even when the decode throws, or the slot leaks and the
      // whole cache wedges after `concurrency` failures.
      active--;
      inflight.delete(key);
      // Start the next queued decode synchronously, in the same tick as this
      // one finishing, so a freed slot is claimed immediately rather than a
      // tick later.
      waiting.shift()?.();
    }
  }

  function start(req: HeicRequest, key: string): Promise<string> {
    if (active < concurrency) {
      active++;
      return decode(req, key);
    }
    return new Promise<string>((resolve, reject) => {
      waiting.push(() => {
        active++;
        decode(req, key).then(resolve, reject);
      });
    });
  }

  function get(req: HeicRequest): Promise<string> {
    const key = heicCacheKey(req);

    const cached = touch(key);
    if (cached !== undefined) return Promise.resolve(cached);

    const pending = inflight.get(key);
    if (pending) return pending;

    const promise = start(req, key);
    inflight.set(key, promise);
    return promise;
  }

  return {
    get,
    size: () => entries.size,
    clear(): void {
      for (const url of entries.values()) revokeUrl(url);
      entries.clear();
    },
  };
}
