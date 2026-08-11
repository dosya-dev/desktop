/**
 * Peak cache. Decoding is the expensive step and its result is small and
 * immutable for a given file version, so reopening a track should never pay
 * for it twice.
 *
 * Keyed by file id + version: a new upload creates a new version, so a stale
 * wave can never be shown against fresh audio.
 */

const DB_NAME = "dosya-audio";
const STORE = "peaks";
const DB_VERSION = 1;

export function peaksCacheKey(fileId: string, version: number | undefined): string {
  return `${fileId}:${version ?? "current"}`;
}

function openDb(): Promise<IDBDatabase | null> {
  return new Promise((resolve) => {
    if (typeof indexedDB === "undefined") return resolve(null);
    let req: IDBOpenDBRequest;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Private browsing modes can refuse to open a database at all.
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(null);
  });
}

/** Cache miss and cache failure are the same thing to a caller: decode it. */
export async function getCachedPeaks(key: string): Promise<Float32Array | null> {
  const db = await openDb();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => {
        const v = req.result as ArrayBuffer | undefined;
        resolve(v ? new Float32Array(v) : null);
        db.close();
      };
      req.onerror = () => { resolve(null); db.close(); };
    } catch {
      resolve(null);
      db.close();
    }
  });
}

/** Best effort. A failed write costs one re-decode, never a broken player. */
export async function putCachedPeaks(key: string, peaks: Float32Array): Promise<void> {
  const db = await openDb();
  if (!db) return;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(peaks.buffer, key);
      tx.oncomplete = () => { resolve(); db.close(); };
      tx.onerror = () => { resolve(); db.close(); };
    } catch {
      resolve();
      db.close();
    }
  });
}
