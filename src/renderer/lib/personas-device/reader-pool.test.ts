import { describe, expect, it } from 'vitest';
import { ReaderUnsupportedError, type ReadFace } from '@dosya-dev/personas-engine';
import { ReaderUnavailableError, type WebReader } from './reader';
import { createReaderPool, READER_RETRY_MS, readAheadFor, readerPoolSize } from './reader-pool';

type Held = { photo: number; done: (f: ReadFace[]) => void; fail: (e: unknown) => void };

function fakes() {
  const made: { reader: WebReader; held: Held[]; disposed: boolean }[] = [];
  const make = () => {
    const rec = { held: [] as Held[], disposed: false, reader: null as unknown as WebReader };
    rec.reader = {
      read: (photo) => new Promise<ReadFace[]>((done, fail) => rec.held.push({ photo: photo[0], done, fail })),
      dispose: () => {
        rec.disposed = true;
      },
    };
    made.push(rec);
    return rec.reader;
  };
  return { made, make };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('readerPoolSize', () => {
  it('uses half the cores, between 1 and 4', () => {
    expect(readerPoolSize({ hardwareConcurrency: 1, deviceMemory: 8 })).toBe(1);
    expect(readerPoolSize({ hardwareConcurrency: 4, deviceMemory: 8 })).toBe(2);
    expect(readerPoolSize({ hardwareConcurrency: 8, deviceMemory: 8 })).toBe(4);
    expect(readerPoolSize({ hardwareConcurrency: 32, deviceMemory: 8 })).toBe(4);
    expect(readerPoolSize({})).toBe(1);
  });

  it('keeps two readers when the browser does not say how much memory there is', () => {
    const mac = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    expect(readerPoolSize({ hardwareConcurrency: 10, userAgent: mac, maxTouchPoints: 0 })).toBe(2);
  });

  it('keeps one reader on a phone or tablet', () => {
    const iphone = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148';
    const ipad = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15';
    const android = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36';
    expect(readerPoolSize({ hardwareConcurrency: 6, userAgent: iphone })).toBe(1);
    expect(readerPoolSize({ hardwareConcurrency: 8, userAgent: ipad, maxTouchPoints: 5 })).toBe(1);
    expect(readerPoolSize({ hardwareConcurrency: 8, deviceMemory: 8, userAgent: android })).toBe(1);
    expect(readerPoolSize({ hardwareConcurrency: 8, deviceMemory: 8, userAgentData: { mobile: true } })).toBe(1);
    const desktopSite = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
    expect(readerPoolSize({ hardwareConcurrency: 8, deviceMemory: 8, userAgent: desktopSite, maxTouchPoints: 5 })).toBe(1);
    expect(readerPoolSize({ hardwareConcurrency: 8, deviceMemory: 8, userAgent: desktopSite, maxTouchPoints: 0 })).toBe(4);
  });

  it('keeps one reader under 4 GB and two under 8 GB', () => {
    expect(readerPoolSize({ hardwareConcurrency: 16, deviceMemory: 2 })).toBe(1);
    expect(readerPoolSize({ hardwareConcurrency: 16, deviceMemory: 4 })).toBe(2);
    expect(readerPoolSize({ hardwareConcurrency: 16, deviceMemory: 8 })).toBe(4);
  });

  it('keeps two photos ahead of the readers', () => {
    expect(readAheadFor(1)).toBe(3);
    expect(readAheadFor(4)).toBe(6);
  });
});

describe('createReaderPool', () => {
  it('uses only the first reader until it has loaded, then spreads reads', async () => {
    const { made, make } = fakes();
    const pool = createReaderPool(3, make);
    const a = pool.read(new Uint8Array([1]));
    const b = pool.read(new Uint8Array([2]));
    expect(made).toHaveLength(1);
    expect(made[0].held.map((h) => h.photo)).toEqual([1, 2]);
    made[0].held[0].done([]);
    await a;
    const c = pool.read(new Uint8Array([3]));
    const d = pool.read(new Uint8Array([4]));
    expect(made).toHaveLength(3);
    expect(made[1].held.map((h) => h.photo)).toEqual([3]);
    expect(made[2].held.map((h) => h.photo)).toEqual([4]);
    for (const m of made) for (const h of m.held) h.done([]);
    await Promise.all([b, c, d]);
  });

  it('stays on the first reader while it cannot load', async () => {
    const { made, make } = fakes();
    const pool = createReaderPool(4, make);
    const a = pool.read(new Uint8Array([1]));
    made[0].held[0].fail(new ReaderUnavailableError());
    await expect(a).rejects.toBeInstanceOf(ReaderUnavailableError);
    const b = pool.read(new Uint8Array([2]));
    const c = pool.read(new Uint8Array([3]));
    expect(made).toHaveLength(1);
    made[0].held[1].done([]);
    made[0].held[2].done([]);
    await Promise.all([b, c]);
  });

  it('a photo the reader refuses still counts as loaded', async () => {
    const { made, make } = fakes();
    const pool = createReaderPool(2, make);
    const a = pool.read(new Uint8Array([1]));
    made[0].held[0].fail(new ReaderUnsupportedError());
    await expect(a).rejects.toBeInstanceOf(ReaderUnsupportedError);
    const b = pool.read(new Uint8Array([2]));
    const c = pool.read(new Uint8Array([3]));
    await tick();
    expect(made).toHaveLength(2);
    made[0].held[1].done([]);
    made[1].held[0].done([]);
    await Promise.all([b, c]);
  });

  it('sends the next read to the least busy reader', async () => {
    const { made, make } = fakes();
    const pool = createReaderPool(2, make);
    const first = pool.read(new Uint8Array([1]));
    made[0].held[0].done([]);
    await first;
    const reads = [2, 3, 4].map((p) => pool.read(new Uint8Array([p])));
    expect(made[0].held.slice(1).map((h) => h.photo)).toEqual([2, 4]);
    expect(made[1].held.map((h) => h.photo)).toEqual([3]);
    for (const m of made) for (const h of m.held) h.done([]);
    await Promise.all(reads);
  });

  it('dispose lets every reader go and starts cold again', async () => {
    const { made, make } = fakes();
    const pool = createReaderPool(2, make);
    const a = pool.read(new Uint8Array([1]));
    made[0].held[0].done([]);
    await a;
    const b = pool.read(new Uint8Array([2]));
    const c = pool.read(new Uint8Array([3]));
    pool.dispose();
    expect(made.map((m) => m.disposed)).toEqual([true, true]);
    for (const m of made) for (const h of m.held) h.done([]);
    await Promise.all([b, c]);
    void pool.read(new Uint8Array([4]));
    void pool.read(new Uint8Array([5]));
    expect(made[0].held.slice(-2).map((h) => h.photo)).toEqual([4, 5]);
  });

  it('a later reader that cannot load is dropped, and its photo is read by the first one', async () => {
    const { made, make } = fakes();
    const pool = createReaderPool(2, make);
    const first = pool.read(new Uint8Array([1]));
    made[0].held[0].done([]);
    await first;
    const b = pool.read(new Uint8Array([2]));
    const c = pool.read(new Uint8Array([3]));
    expect(made[1].held.map((h) => h.photo)).toEqual([3]);
    made[1].held[0].fail(new ReaderUnavailableError());
    await tick();
    expect(made[1].disposed).toBe(true);
    // Photo 3 went back to the first reader, behind photo 2.
    expect(made[0].held.slice(1).map((h) => h.photo)).toEqual([2, 3]);
    made[0].held[1].done([]);
    made[0].held[2].done([]);
    await Promise.all([b, c]);
    // From now on only the first reader is used.
    const d = pool.read(new Uint8Array([4]));
    const e = pool.read(new Uint8Array([5]));
    expect(made).toHaveLength(2);
    expect(made[0].held.slice(3).map((h) => h.photo)).toEqual([4, 5]);
    made[0].held[3].done([]);
    made[0].held[4].done([]);
    await Promise.all([d, e]);
  });

  it('a later reader that could not load is tried again after a while', async () => {
    const { made, make } = fakes();
    let t = 0;
    const pool = createReaderPool(2, make, () => t);
    const first = pool.read(new Uint8Array([1]));
    made[0].held[0].done([]);
    await first;
    void pool.read(new Uint8Array([2]));
    const c = pool.read(new Uint8Array([3]));
    made[1].held[0].fail(new ReaderUnavailableError());
    await tick();
    for (const h of made[0].held.slice(1)) h.done([]);
    await c;
    t += READER_RETRY_MS;
    void pool.read(new Uint8Array([4]));
    void pool.read(new Uint8Array([5]));
    expect(made).toHaveLength(3);
    expect(made[2].held.map((h) => h.photo)).toEqual([5]);
  });

  it('a photo a later reader refuses is not retried', async () => {
    const { made, make } = fakes();
    const pool = createReaderPool(2, make);
    const first = pool.read(new Uint8Array([1]));
    made[0].held[0].done([]);
    await first;
    void pool.read(new Uint8Array([2]));
    const c = pool.read(new Uint8Array([3]));
    made[1].held[0].fail(new ReaderUnsupportedError());
    await expect(c).rejects.toBeInstanceOf(ReaderUnsupportedError);
    expect(made[0].held.map((h) => h.photo)).toEqual([1, 2]);
  });
});
