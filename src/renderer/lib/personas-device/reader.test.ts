// @vitest-environment node
// Ported from apps/web/src/lib/personas-device/reader.test.ts - keep the two in step.
//
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReaderUnsupportedError } from '@dosya-dev/personas-engine';
import { createWebReader, ReaderUnavailableError, readerSupported, type ReaderWorker } from './reader';
import type { WorkerReply, WorkerRequest } from './read-core';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('readerSupported', () => {
  it('needs Web Workers and WebAssembly with SIMD', () => {
    vi.stubGlobal('Worker', class {});
    expect(readerSupported()).toBe(true);
  });
  it('is false when WebAssembly.validate rejects the SIMD probe', () => {
    vi.stubGlobal('Worker', class {});
    vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    expect(readerSupported()).toBe(false);
  });
  it('is false without WebAssembly or without Worker', () => {
    vi.stubGlobal('Worker', undefined);
    expect(readerSupported()).toBe(false);
    vi.stubGlobal('Worker', class {});
    vi.stubGlobal('WebAssembly', undefined);
    expect(readerSupported()).toBe(false);
  });
});

class FakeWorker implements ReaderWorker {
  sent: WorkerRequest[] = [];
  terminated = false;
  onmessage: ((ev: MessageEvent<WorkerReply>) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  postMessage(msg: WorkerRequest) {
    this.sent.push(msg);
  }
  terminate() {
    this.terminated = true;
  }
  reply(r: WorkerReply) {
    this.onmessage?.({ data: r } as MessageEvent<WorkerReply>);
  }
}

const flush = () => new Promise((r) => setTimeout(r, 0));

function setup() {
  const workers: FakeWorker[] = [];
  const reader = createWebReader('https://api.test/api/personas/models', {
    spawn: () => {
      const w = new FakeWorker();
      workers.push(w);
      return w;
    },
  });
  return { reader, workers };
}

describe('createWebReader', () => {
  it('spawns the worker lazily and reads one photo at a time', async () => {
    const { reader, workers } = setup();
    expect(workers).toHaveLength(0);
    const a = reader.read(new Uint8Array([1]));
    const b = reader.read(new Uint8Array([2]));
    await flush();
    expect(workers).toHaveLength(1);
    const w = workers[0];
    expect(w.sent).toHaveLength(1);
    expect(w.sent[0].modelBase).toBe('https://api.test/api/personas/models');
    expect(Array.from(w.sent[0].photo)).toEqual([1]);
    const sig = new Float32Array(128);
    w.reply({ id: w.sent[0].id, ok: true, faces: [{ box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, score: 0.9, sig }] });
    const facesA = await a;
    expect(facesA).toEqual([{ box: { x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, score: 0.9, sig }]);
    await flush();
    expect(w.sent).toHaveLength(2);
    expect(Array.from(w.sent[1].photo)).toEqual([2]);
    w.reply({ id: w.sent[1].id, ok: true, faces: [] });
    expect(await b).toEqual([]);
  });

  it('maps an unsupported photo to ReaderUnsupportedError, a read failure to a plain error and a load failure to ReaderUnavailableError', async () => {
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1]));
    await flush();
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, kind: 'unsupported', message: 'not a JPEG or WebP' });
    await expect(a).rejects.toBeInstanceOf(ReaderUnsupportedError);
    const b = reader.read(new Uint8Array([2]));
    await flush();
    workers[0].reply({ id: workers[0].sent[1].id, ok: false, kind: 'failed', message: 'out of bounds' });
    const err = await b.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ReaderUnsupportedError);
    expect(workers).toHaveLength(1);
    const c = reader.read(new Uint8Array([3]));
    await flush();
    workers[0].reply({ id: workers[0].sent[2].id, ok: false, kind: 'unavailable', message: 'face reader file x: HTTP 404' });
    await expect(c).rejects.toBeInstanceOf(ReaderUnavailableError);
  });

  it('replaces the worker after a wasm trap or a crash', async () => {
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1]));
    await flush();
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, kind: 'trap', message: 'unreachable' });
    await expect(a).rejects.toThrow();
    expect(workers[0].terminated).toBe(true);
    const b = reader.read(new Uint8Array([2]));
    await flush();
    expect(workers).toHaveLength(2);
    workers[1].onerror?.({ message: 'boom' });
    // A worker that never answered may not have loaded at all: not the photo's fault.
    await expect(b).rejects.toBeInstanceOf(ReaderUnavailableError);
    expect(workers[1].terminated).toBe(true);
    const c = reader.read(new Uint8Array([3]));
    await flush();
    expect(workers).toHaveLength(3);
    workers[2].reply({ id: workers[2].sent[0].id, ok: true, faces: [] });
    expect(await c).toEqual([]);
  });

  it('lets the worker go after a minute without reads', async () => {
    vi.useFakeTimers();
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1]));
    await vi.advanceTimersByTimeAsync(0);
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, faces: [] });
    await a;
    await vi.advanceTimersByTimeAsync(59_000);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(workers[0].terminated).toBe(true);
  });

  it('a crash after the reader has loaded is the photo\'s failure', async () => {
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1]));
    await flush();
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, faces: [] });
    await a;
    const b = reader.read(new Uint8Array([2]));
    await flush();
    workers[0].onerror?.({ message: 'out of memory' });
    const err = await b.catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ReaderUnavailableError);
    expect(err).not.toBeInstanceOf(ReaderUnsupportedError);
  });

  it('a worker that cannot be started makes the reader unavailable', async () => {
    const reader = createWebReader('https://api.test/api/personas/models', { spawn: () => { throw new Error('blocked'); } });
    await expect(reader.read(new Uint8Array([1]))).rejects.toBeInstanceOf(ReaderUnavailableError);
  });

  it('a read that never answers times out: unavailable before the reader loaded (120 s), a plain error after (60 s)', async () => {
    vi.useFakeTimers();
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1])).catch((e) => e);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(workers[0].terminated).toBe(false);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await a).toBeInstanceOf(ReaderUnavailableError);
    expect(workers[0].terminated).toBe(true);

    const b = reader.read(new Uint8Array([2]));
    await vi.advanceTimersByTimeAsync(0);
    workers[1].reply({ id: workers[1].sent[0].id, ok: true, faces: [] });
    await b;
    const c = reader.read(new Uint8Array([3])).catch((e) => e);
    await vi.advanceTimersByTimeAsync(61_000);
    const err = await c;
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ReaderUnavailableError);
    expect(workers[1].terminated).toBe(true);
  });

  it('dispose() lets the worker go', async () => {
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1]));
    await flush();
    workers[0].reply({ id: workers[0].sent[0].id, ok: true, faces: [] });
    await a;
    reader.dispose();
    expect(workers[0].terminated).toBe(true);
  });

  it('reads queued behind one that found the reader unavailable fail at once, and later reads try again', async () => {
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1]));
    const b = reader.read(new Uint8Array([2]));
    const c = reader.read(new Uint8Array([3]));
    await flush();
    workers[0].reply({ id: workers[0].sent[0].id, ok: false, kind: 'unavailable', message: 'download failed' });
    expect(await a.catch((x: unknown) => x)).toBeInstanceOf(ReaderUnavailableError);
    expect(await b.catch((x: unknown) => x)).toBeInstanceOf(ReaderUnavailableError);
    expect(await c.catch((x: unknown) => x)).toBeInstanceOf(ReaderUnavailableError);
    expect(workers[0].sent).toHaveLength(1);
    const d = reader.read(new Uint8Array([4]));
    await flush();
    const w = workers[workers.length - 1];
    w.reply({ id: w.sent[w.sent.length - 1].id, ok: true, faces: [] });
    await expect(d).resolves.toEqual([]);
  });

  it('dispose() fails the reads still queued without starting a worker for them', async () => {
    const { reader, workers } = setup();
    const a = reader.read(new Uint8Array([1]));
    const b = reader.read(new Uint8Array([2]));
    await flush();
    reader.dispose();
    await a.catch(() => undefined);
    expect(await b.catch((x: unknown) => x)).toBeInstanceOf(ReaderUnavailableError);
    expect(workers).toHaveLength(1);
  });
});
