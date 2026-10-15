// Run with `npm run test:unit` in apps/desktop - Node's own test runner.
//
// Ported from apps/web/src/lib/heic-pool.test.ts (which uses vitest's
// describe/it/vi) - this copy is rewritten against node:test + node:assert
// so it runs under the node:test glob this directory's other *.test.ts files
// use, rather than needing a vitest carve-out like lan-peer/live-photos/
// auth-direction did.
import { test } from "node:test";
import assert from "node:assert/strict";

import { createHeicPool, type PoolWorker } from "./heic-pool.ts";

/** A fake worker whose message flow we drive by hand from the test. */
interface FakeWorker extends PoolWorker {
  posted: Array<{ id: number; url: string; maxDim: number }>;
  terminateCalls: number;
}

function fakeWorkerFactory() {
  const workers: FakeWorker[] = [];
  const spawn = (): PoolWorker => {
    const w: FakeWorker = {
      posted: [],
      terminateCalls: 0,
      postMessage: (msg: unknown) => {
        w.posted.push(msg as { id: number; url: string; maxDim: number });
      },
      terminate: () => {
        w.terminateCalls++;
      },
      onmessage: null,
      onerror: null,
      onmessageerror: null,
    };
    workers.push(w);
    return w;
  };
  return { spawn, workers };
}

function reply(w: FakeWorker, id: number, blob: Blob) {
  w.onmessage?.({ data: { id, blob } });
}

function replyError(w: FakeWorker, id: number, error: string) {
  w.onmessage?.({ data: { id, error } });
}

/**
 * A fake clock for the pool's injected `schedule`/`cancel` seam. `schedule`
 * returns an opaque handle (never a real timer), `cancel` deletes it, and
 * `fireAll` runs every still-pending callback - so a test can assert an idle
 * timer was armed/cancelled without waiting on a real 30s timeout.
 */
function fakeClock() {
  let nextHandle = 0;
  const pending = new Map<number, () => void>();
  const scheduleCalls: Array<{ ms: number }> = [];
  let cancelCalls = 0;
  const schedule = (fn: () => void, ms: number): unknown => {
    const handle = ++nextHandle;
    pending.set(handle, fn);
    scheduleCalls.push({ ms });
    return handle;
  };
  const cancel = (handle: unknown): void => {
    cancelCalls++;
    pending.delete(handle as number);
  };
  const fireAll = (): void => {
    const fns = Array.from(pending.values());
    pending.clear();
    for (const fn of fns) fn();
  };
  return {
    schedule,
    cancel,
    fireAll,
    get scheduleCallCount() {
      return scheduleCalls.length;
    },
    get lastScheduleMs() {
      return scheduleCalls.at(-1)?.ms;
    },
    get cancelCallCount() {
      return cancelCalls;
    },
    get pendingCount() {
      return pending.size;
    },
  };
}

test("spawns no workers until the first request, and never exceeds size", async () => {
  const f = fakeWorkerFactory();
  const pool = createHeicPool({ spawn: f.spawn, size: 4 });

  assert.equal(f.workers.length, 0);

  const promises = Array.from({ length: 6 }, (_, i) => pool.decode(`u${i}`, 256));
  assert.ok(f.workers.length <= 4);
  assert.equal(f.workers.length, 4);

  const repliedCount = new Map<FakeWorker, number>();
  let totalReplied = 0;
  for (let round = 0; round < 10 && totalReplied < 6; round++) {
    for (const w of f.workers) {
      const done = repliedCount.get(w) ?? 0;
      if (w.posted.length > done) {
        reply(w, w.posted[done].id, new Blob([w.posted[done].url]));
        repliedCount.set(w, done + 1);
        totalReplied++;
      }
    }
  }
  assert.equal(totalReplied, 6);
  await Promise.all(promises);
});

test("queues a request when all workers are busy, then dispatches it once one frees", async () => {
  const f = fakeWorkerFactory();
  const pool = createHeicPool({ spawn: f.spawn, size: 2 });

  const p1 = pool.decode("u1", 256);
  const p2 = pool.decode("u2", 256);
  assert.equal(f.workers.length, 2);

  const p3 = pool.decode("u3", 256);
  assert.equal(f.workers.length, 2);
  assert.equal(f.workers[0].posted.length, 1);
  assert.equal(f.workers[1].posted.length, 1);

  reply(f.workers[0], f.workers[0].posted[0].id, new Blob(["b1"]));
  await p1;
  assert.equal(f.workers[0].posted.length, 2);
  assert.equal(f.workers[0].posted[1].url, "u3");

  reply(f.workers[0], f.workers[0].posted[1].id, new Blob(["b3"]));
  reply(f.workers[1], f.workers[1].posted[0].id, new Blob(["b2"]));
  await Promise.all([p2, p3]);
});

test("on worker onerror, rejects its in-flight request, terminates it, and keeps serving new requests", async () => {
  const f = fakeWorkerFactory();
  const pool = createHeicPool({ spawn: f.spawn, size: 1 });

  const p1 = pool.decode("u1", 256);
  assert.equal(f.workers.length, 1);
  const dead = f.workers[0];

  dead.onerror?.(new Error("error"));

  await assert.rejects(p1);
  assert.equal(dead.terminateCalls, 1);

  const p2 = pool.decode("u2", 256);
  assert.equal(f.workers.length, 2);
  const fresh = f.workers[1];
  assert.notEqual(fresh, dead);
  reply(fresh, fresh.posted[0].id, new Blob(["ok"]));
  assert.ok((await p2) instanceof Blob);
});

test("a rejected decode frees its worker so subsequent requests don't hang", async () => {
  const f = fakeWorkerFactory();
  const size = 3;
  const pool = createHeicPool({ spawn: f.spawn, size });

  const promises = Array.from({ length: size + 1 }, (_, i) => pool.decode(`u${i}`, 256));
  assert.equal(f.workers.length, size);

  replyError(f.workers[0], f.workers[0].posted[0].id, "boom");
  assert.equal(f.workers[0].posted.length, 2);

  reply(f.workers[0], f.workers[0].posted[1].id, new Blob(["last"]));
  reply(f.workers[1], f.workers[1].posted[0].id, new Blob(["b1"]));
  reply(f.workers[2], f.workers[2].posted[0].id, new Blob(["b2"]));

  await assert.rejects(promises[0], /boom/);
  assert.equal((await Promise.all(promises.slice(1))).length, size);
});

test("exposes the configured size", () => {
  const f = fakeWorkerFactory();
  const pool = createHeicPool({ spawn: f.spawn, size: 4 });
  assert.equal(pool.size, 4);
});

// --- Idle worker teardown (DSK-009) ---------------------------------------
//
// Each worker holds an instantiated libheif WASM module whose linear memory
// only grows (WebAssembly.Memory cannot shrink) to fit the largest photo it
// has decoded - up to ~190MB for a 48MP source. Left running for the rest of
// the session, that's a retained high-water mark per worker after a single
// large decode. These tests pin: an unused worker is terminated after
// `idleMs` and removed from the pool; a worker with a job in flight is never
// a candidate for that timer; a later decode respawns a fresh worker; and
// picking up new work before the timer fires cancels it.

test("terminates an idle worker after idleMs and removes it from the pool", async () => {
  const f = fakeWorkerFactory();
  const clock = fakeClock();
  const pool = createHeicPool({
    spawn: f.spawn,
    size: 1,
    idleMs: 30000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  const p1 = pool.decode("u1", 256);
  const w1 = f.workers[0];
  reply(w1, w1.posted[0].id, new Blob(["b1"]));
  await p1;

  // The worker just went idle (no queued work) - an idle timer must be armed.
  assert.equal(clock.scheduleCallCount, 1);
  assert.equal(clock.lastScheduleMs, 30000);
  assert.equal(w1.terminateCalls, 0);

  clock.fireAll();

  assert.equal(w1.terminateCalls, 1);
});

test("a worker with a job in flight is never terminated", async () => {
  const f = fakeWorkerFactory();
  const clock = fakeClock();
  const pool = createHeicPool({
    spawn: f.spawn,
    size: 1,
    idleMs: 30000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  const p1 = pool.decode("u1", 256);
  const w1 = f.workers[0];

  // No idle timer should exist for a worker that is still doing a job -
  // firing every currently-pending timer must be a no-op for it.
  clock.fireAll();
  assert.equal(w1.terminateCalls, 0);
  assert.equal(clock.scheduleCallCount, 0);

  reply(w1, w1.posted[0].id, new Blob(["b1"]));
  await p1;
});

test("a decode issued after idle-termination spawns a fresh worker", async () => {
  const f = fakeWorkerFactory();
  const clock = fakeClock();
  const pool = createHeicPool({
    spawn: f.spawn,
    size: 1,
    idleMs: 30000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  const p1 = pool.decode("u1", 256);
  const w1 = f.workers[0];
  reply(w1, w1.posted[0].id, new Blob(["b1"]));
  await p1;

  clock.fireAll(); // idle timer fires -> w1 terminated and dropped
  assert.equal(w1.terminateCalls, 1);

  const p2 = pool.decode("u2", 256);
  assert.equal(f.workers.length, 2);
  const w2 = f.workers[1];
  assert.notEqual(w2, w1);
  reply(w2, w2.posted[0].id, new Blob(["b2"]));
  assert.ok((await p2) instanceof Blob);
});

test("a queued job that lands on the idle worker cancels its pending idle timer", async () => {
  const f = fakeWorkerFactory();
  const clock = fakeClock();
  const pool = createHeicPool({
    spawn: f.spawn,
    size: 1,
    idleMs: 30000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  const p1 = pool.decode("u1", 256);
  const w1 = f.workers[0];
  reply(w1, w1.posted[0].id, new Blob(["b1"]));
  await p1;

  // Idle timer armed; before it fires, a second decode arrives and must
  // reuse the same worker (size 1) and cancel that timer.
  assert.equal(clock.scheduleCallCount, 1);
  assert.equal(clock.pendingCount, 1);

  const p2 = pool.decode("u2", 256);
  assert.equal(f.workers.length, 1);
  assert.equal(clock.cancelCallCount, 1);
  assert.equal(clock.pendingCount, 0);

  // Firing whatever remains pending (nothing, now) must not terminate w1.
  clock.fireAll();
  assert.equal(w1.terminateCalls, 0);

  reply(w1, w1.posted[1].id, new Blob(["b2"]));
  assert.ok((await p2) instanceof Blob);
});

test("destroy() terminates every worker, cancels idle timers, and rejects queued jobs", async () => {
  const f = fakeWorkerFactory();
  const clock = fakeClock();
  const pool = createHeicPool({
    spawn: f.spawn,
    size: 1,
    idleMs: 30000,
    schedule: clock.schedule,
    cancel: clock.cancel,
  });

  const p1 = pool.decode("u1", 256);
  const w1 = f.workers[0];
  const p2 = pool.decode("u2", 256); // queues - size is 1 and w1 is busy

  pool.destroy();

  assert.equal(w1.terminateCalls, 1);
  await assert.rejects(p1);
  await assert.rejects(p2);
});
