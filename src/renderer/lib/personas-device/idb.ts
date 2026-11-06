// Ported from apps/web/src/lib/personas-device/idb.ts - keep the two in step.
//
// The IndexedDB database behind the Personas key store and snapshot cache:
// `dosya-personas`, stores `keys` and `snapshots`. The factory is injected
// so tests can pass an in-memory one.
export const DB_NAME = 'dosya-personas';
export const KEYS_STORE = 'keys';
export const SNAPSHOTS_STORE = 'snapshots';
const VERSION = 1;

export type IdbFactoryLike = Pick<IDBFactory, 'open'>;

export function defaultIdb(): IdbFactoryLike {
  if (typeof indexedDB === 'undefined') throw new Error('IndexedDB is not available');
  return indexedDB;
}

export function request<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error ?? new Error('IndexedDB request failed'));
  });
}

/** Resolves when the transaction commits (so a write is durable), rejects if it aborts. */
export function committed(tx: IDBTransaction): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB transaction failed'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** One open connection per factory, shared by the key store and the cache. */
const opened = new WeakMap<object, Promise<IDBDatabase>>();

export function openPersonasDb(factory: IdbFactoryLike): Promise<IDBDatabase> {
  let db = opened.get(factory);
  if (!db) {
    db = new Promise<IDBDatabase>((resolve, reject) => {
      const r = factory.open(DB_NAME, VERSION);
      r.onupgradeneeded = () => {
        const d = r.result;
        if (!d.objectStoreNames.contains(KEYS_STORE)) d.createObjectStore(KEYS_STORE);
        if (!d.objectStoreNames.contains(SNAPSHOTS_STORE)) d.createObjectStore(SNAPSHOTS_STORE);
      };
      r.onsuccess = () => {
        const d = r.result;
        // Another tab upgrading the database: let it, and reopen next time.
        d.onversionchange = () => {
          d.close();
          opened.delete(factory);
        };
        resolve(d);
      };
      r.onerror = () => reject(r.error ?? new Error('IndexedDB open failed'));
      r.onblocked = () => reject(new Error('IndexedDB open blocked'));
    }).catch((e) => {
      opened.delete(factory);
      throw e;
    });
    opened.set(factory, db);
  }
  return db;
}
