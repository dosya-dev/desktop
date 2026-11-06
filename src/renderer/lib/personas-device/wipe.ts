// Ported from apps/web/src/lib/personas-device/wipe.ts, plus pending-wipe
// ordering (see afterPendingWipe).
//
// Sign-out and Vault destroy: remove the user's cached personas key and sealed
// snapshots from this window's IndexedDB. Kept apart from engine-host so the
// session reset loads the ports (and so the engine package) only when it runs.
// The per-browser wrapping key stays: it protects nothing without a record.
import type { KeyStore, LocalCache } from '@dosya-dev/personas-engine';
import type { IdbFactoryLike } from './idb';

const WIPE_TIMEOUT_MS = 2000;

export interface WipeOptions {
  idb?: IdbFactoryLike;
  /** Tests: stores to clear instead of the IndexedDB ones. */
  stores?: { keys: KeyStore; cache: LocalCache };
}

/** The unfinished wipe of each user, so a quick sign-in cannot have its fresh key deleted by it. */
const pending = new Map<string, Promise<void>>();

function capped(p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, WIPE_TIMEOUT_MS);
  });
  return Promise.race([p, limit]).finally(() => clearTimeout(timer));
}

/**
 * Best effort and never throws: storage that is missing, blocked or slow must
 * not stop a sign-out. Gives up waiting after two seconds.
 */
export async function wipePersonasDevice(userId: string | null, opts: WipeOptions = {}): Promise<void> {
  if (!userId) return;
  const work = (async () => {
    let s = opts.stores;
    if (!s) {
      const { webKeyStore, webLocalCache } = await import('./ports');
      s = { keys: webKeyStore(opts.idb), cache: webLocalCache(opts.idb) };
    }
    await Promise.allSettled([s.keys.clear(userId), s.cache.clear(userId)]);
  })().catch(() => undefined);
  pending.set(userId, work);
  void work.then(() => {
    if (pending.get(userId) === work) pending.delete(userId);
  });
  await capped(work);
}

/**
 * The key store with every get and set held back until that user's pending
 * wipe has finished: sign out then straight back in as the same user must not
 * end with the new session's cached key deleted by the old session's wipe.
 */
export function afterPendingWipe(keys: KeyStore): KeyStore {
  const settle = (userId: string) => {
    const p = pending.get(userId);
    return p ? capped(p) : undefined;
  };
  return {
    async get(userId) {
      await settle(userId);
      return keys.get(userId);
    },
    async set(userId, key) {
      await settle(userId);
      return keys.set(userId, key);
    },
    clear: (userId) => keys.clear(userId),
  };
}

/**
 * "Turn off and delete" just succeeded in one workspace: if this device holds
 * no snapshot for any other workspace of the user, remove the cached key too
 * (the server key stays; the next turn-on asks for the Vault once). Never throws.
 */
export async function clearKeyIfLastWorkspace(userId: string | null, idb?: IdbFactoryLike): Promise<void> {
  if (!userId) return;
  try {
    const { hasSnapshots, webKeyStore } = await import('./ports');
    if (!(await hasSnapshots(userId, idb))) await webKeyStore(idb).clear(userId);
  } catch {
    // best effort
  }
}
