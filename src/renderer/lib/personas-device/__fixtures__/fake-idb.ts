// Ported from apps/web/src/lib/personas-device/__fixtures__/fake-idb.ts - keep the two in step.
//
// A small in-memory IndexedDB for tests: the subset idb.ts uses (open with
// upgrade, one-store transactions, get/put/add/delete/getAllKeys, complete
// and error events). Values are stored by reference, as a real IDB would keep
// a non-extractable CryptoKey usable after a structured clone.
type Handler = ((ev: unknown) => void) | null;

class FakeRequest<T = unknown> {
  result: T | undefined;
  error: DOMException | null = null;
  onsuccess: Handler = null;
  onerror: Handler = null;
  onupgradeneeded: Handler = null;
  onblocked: Handler = null;
  succeed(v: T) {
    this.result = v;
    this.onsuccess?.({ target: this });
  }
  fail(name: string) {
    this.error = new DOMException(name, name);
    this.onerror?.({ target: this });
  }
}

class FakeStore {
  constructor(private readonly data: Map<string, unknown>, private readonly tx: FakeTransaction) {}
  private run<T>(fn: () => T, failName?: () => string | null): FakeRequest<T> {
    const r = new FakeRequest<T>();
    this.tx.pending++;
    queueMicrotask(() => {
      const bad = failName?.();
      if (bad) {
        r.fail(bad);
        this.tx.abort(r.error!);
      } else r.succeed(fn());
      this.tx.done();
    });
    return r;
  }
  get(key: string) {
    return this.run(() => this.data.get(key));
  }
  put(value: unknown, key: string) {
    this.tx.assertWrite();
    return this.run(() => {
      this.data.set(key, value);
      return key;
    });
  }
  add(value: unknown, key: string) {
    this.tx.assertWrite();
    return this.run(
      () => {
        this.data.set(key, value);
        return key;
      },
      () => (this.data.has(key) ? 'ConstraintError' : null),
    );
  }
  delete(key: string) {
    this.tx.assertWrite();
    return this.run(() => {
      this.data.delete(key);
      return undefined;
    });
  }
  getAllKeys() {
    return this.run(() => [...this.data.keys()]);
  }
}

class FakeTransaction {
  pending = 0;
  oncomplete: Handler = null;
  onerror: Handler = null;
  onabort: Handler = null;
  error: DOMException | null = null;
  private finished = false;
  constructor(private readonly db: FakeDb, private readonly names: string[], private readonly mode: string) {
    // A transaction with no requests completes on its own.
    queueMicrotask(() => this.done());
  }
  assertWrite() {
    if (this.mode !== 'readwrite') throw new DOMException('read-only transaction', 'ReadOnlyError');
  }
  objectStore(name: string) {
    if (!this.names.includes(name)) throw new DOMException(name, 'NotFoundError');
    return new FakeStore(this.db.store(name), this);
  }
  abort(err: DOMException) {
    if (this.finished) return;
    this.finished = true;
    this.error = err;
    this.onerror?.({ target: this });
    this.onabort?.({ target: this });
  }
  done() {
    if (this.pending > 0) this.pending--;
    if (this.pending === 0 && !this.finished) {
      queueMicrotask(() => {
        if (this.pending === 0 && !this.finished) {
          this.finished = true;
          this.oncomplete?.({ target: this });
        }
      });
    }
  }
}

class FakeDb {
  readonly stores = new Map<string, Map<string, unknown>>();
  version = 0;
  closed = false;
  get objectStoreNames() {
    const names = [...this.stores.keys()];
    return { contains: (n: string) => names.includes(n), length: names.length };
  }
  store(name: string) {
    const s = this.stores.get(name);
    if (!s) throw new DOMException(name, 'NotFoundError');
    return s;
  }
  createObjectStore(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new Map());
    return {};
  }
  transaction(names: string | string[], mode = 'readonly') {
    const list = Array.isArray(names) ? names : [names];
    for (const n of list) this.store(n);
    return new FakeTransaction(this, list, mode);
  }
  close() {
    this.closed = true;
  }
}

/** An IDBFactory stand-in; `dbs` exposes the stores for assertions. */
export class FakeIdbFactory {
  readonly dbs = new Map<string, FakeDb>();
  opens = 0;
  open(name: string, version?: number) {
    this.opens++;
    const r = new FakeRequest<FakeDb>();
    queueMicrotask(() => {
      let db = this.dbs.get(name);
      if (!db) {
        db = new FakeDb();
        this.dbs.set(name, db);
      }
      const want = version ?? Math.max(1, db.version);
      if (want < db.version) {
        r.fail('VersionError');
        return;
      }
      if (want > db.version) {
        db.version = want;
        r.result = db;
        r.onupgradeneeded?.({ target: r, oldVersion: 0, newVersion: want });
      }
      r.succeed(db);
    });
    return r;
  }
  asFactory(): IDBFactory {
    return this as unknown as IDBFactory;
  }
}
