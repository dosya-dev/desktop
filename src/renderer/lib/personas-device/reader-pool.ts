// Ported from apps/web/src/lib/personas-device/reader-pool.ts - keep the two in step.
//
// Several face readers (reader.ts, one Web Worker each) behind one
// FaceReaderPort, so a computer with spare cores reads photos side by side.
// The engine keeps several photos in flight (EngineDeps.readAhead); the pool
// hands each to the least busy reader.
//
// Only the first reader loads until it has answered once: a cold cache would
// otherwise download the 35 MB of reader files once per worker. After that
// every new worker loads them from the HTTP cache (the models route is
// immutable).
import type { ReadFace } from '@dosya-dev/personas-engine';
import { ReaderUnavailableError, type WebReader } from './reader';

/** Each reader holds ~106 MB of wasm memory. */
export const READER_POOL_MAX = 4;

export interface PoolHints {
  hardwareConcurrency?: number;
  /** GB, rounded down by the browser (Chromium only); absent elsewhere. */
  deviceMemory?: number;
  userAgent?: string;
  maxTouchPoints?: number;
  userAgentData?: { mobile?: boolean };
}

/** A phone or tablet browser: tabs there are killed far below 4 readers' memory. */
function isMobile(h: PoolHints): boolean {
  if (h.userAgentData?.mobile === true) return true;
  const ua = h.userAgent ?? '';
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(ua)) return true;
  const touch = (h.maxTouchPoints ?? 0) > 1;
  // iPadOS asks for the desktop site: a Mac user agent with a touch screen.
  // So does Android's "Desktop site": a Linux one (Chromebooks excepted).
  return touch && (/Macintosh/.test(ua) || (/Linux/.test(ua) && !/CrOS/.test(ua)));
}

/**
 * How many readers this device should run: half its cores, at most 4; 1 on a
 * phone or tablet or under 4 GB of memory; 2 under 8 GB, or when the browser
 * does not say how much memory there is.
 */
export function readerPoolSize(hints: PoolHints = globalThis.navigator ?? {}): number {
  const cores = Number.isFinite(hints.hardwareConcurrency) && (hints.hardwareConcurrency as number) > 0 ? (hints.hardwareConcurrency as number) : 2;
  let n = Math.max(1, Math.min(READER_POOL_MAX, Math.floor(cores / 2)));
  if (isMobile(hints)) return 1;
  const mem = hints.deviceMemory;
  if (typeof mem === 'number' && Number.isFinite(mem)) {
    if (mem < 4) n = 1;
    else if (mem < 8) n = Math.min(n, 2);
  } else n = Math.min(n, 2);
  return n;
}

/** Photos the engine should keep in flight for a pool of `size`: one queued per reader plus downloads ahead. */
export function readAheadFor(size: number): number {
  return size + 2;
}

/** How long a later reader that could not load is left out before it is tried again. */
export const READER_RETRY_MS = 5 * 60_000;

export function createReaderPool(size: number, make: () => WebReader, now: () => number = Date.now): WebReader {
  const n = Math.max(1, Math.floor(size) || 1);
  const readers: (WebReader | null)[] = Array.from({ length: n }, () => null);
  const busy = new Array<number>(n).fill(0);
  /** Until when each reader after the first is left out, after it could not load. */
  const restUntil = new Array<number>(n).fill(0);
  /** The first reader has loaded (answered anything but unavailable). */
  let warm = false;
  /** Bumped by dispose: a read started before it does not change the pool. */
  let gen = 0;

  const pick = (): number => {
    if (!warm) return 0;
    let best = 0;
    for (let i = 1; i < n; i++) if (restUntil[i] <= now() && busy[i] < busy[best]) best = i;
    return best;
  };

  const readOn = async (i: number, photo: Uint8Array, at: number): Promise<ReadFace[]> => {
    const r = (readers[i] ??= make());
    busy[i]++;
    try {
      const faces = await r.read(photo);
      if (i === 0 && at === gen) warm = true;
      return faces;
    } catch (e) {
      if (i === 0 && at === gen && !(e instanceof ReaderUnavailableError)) warm = true;
      throw e;
    } finally {
      busy[i]--;
    }
  };

  return {
    async read(photo) {
      const i = pick();
      const at = gen;
      if (i === 0) return readOn(0, photo, at);
      // The reader takes the bytes (they move to its worker): keep the
      // original in case this reader cannot load and the first one must read it.
      try {
        return await readOn(i, photo.slice(), at);
      } catch (e) {
        if (!(e instanceof ReaderUnavailableError) || at !== gen) throw e;
        // This one cannot load (too little memory for another reader, a
        // network blip): read with fewer for a while, and do not hold the
        // photo against the device.
        restUntil[i] = now() + READER_RETRY_MS;
        readers[i]?.dispose();
        readers[i] = null;
        return readOn(0, photo, at);
      }
    },
    dispose() {
      warm = false;
      gen++;
      restUntil.fill(0);
      for (const r of readers) r?.dispose();
    },
  };
}
