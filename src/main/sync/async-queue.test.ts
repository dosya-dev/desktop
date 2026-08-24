import { test } from "node:test";
import assert from "node:assert/strict";
import { Backpressure } from "./async-queue.ts";

/** Resolve only if `p` settles within a macrotask, so "did not resolve" is testable. */
async function settled(p: Promise<void>): Promise<boolean> {
  let done = false;
  void p.then(() => { done = true; });
  await new Promise<void>((r) => setTimeout(r, 0));
  return done;
}

test("below the high mark the producer never waits", async () => {
  const bp = new Backpressure({ high: 10, low: 5 });
  bp.add(9);
  assert.equal(bp.paused, false);
  assert.equal(await settled(bp.waitUntilDrained()), true);
});

test("at the high mark the producer blocks until the queue drains to the low mark", async () => {
  const bp = new Backpressure({ high: 10, low: 5 });
  bp.add(10);
  assert.equal(bp.paused, true);

  const waiter = bp.waitUntilDrained();
  assert.equal(await settled(waiter), false, "released before reaching the low mark");

  bp.remove(3); // depth 7 - still above low
  assert.equal(await settled(waiter), false, "released too early");

  bp.remove(3); // depth 4 - at or below low
  assert.equal(await settled(waiter), true);
  assert.equal(bp.paused, false);
});

test("every waiter is released by the same drain", async () => {
  const bp = new Backpressure({ high: 4, low: 2 });
  bp.add(4);
  const all = Promise.all([bp.waitUntilDrained(), bp.waitUntilDrained(), bp.waitUntilDrained()]);
  bp.remove(3);
  await all; // hangs the test if any waiter is dropped
});

test("release unblocks waiters and makes later waits no-ops", async () => {
  // Pause and teardown must never leave a scanner parked on a queue that
  // nothing will drain.
  const bp = new Backpressure({ high: 2, low: 1 });
  bp.add(5);
  const waiter = bp.waitUntilDrained();
  bp.release();
  assert.equal(await settled(waiter), true);
  assert.equal(await settled(bp.waitUntilDrained()), true);
});

test("depth never goes negative, and removing more than was added is harmless", () => {
  const bp = new Backpressure({ high: 3, low: 1 });
  bp.add(1);
  bp.remove(5);
  assert.equal(bp.depth, 0);
  assert.equal(bp.paused, false);
});

test("zero and negative amounts are ignored", () => {
  const bp = new Backpressure({ high: 3, low: 1 });
  bp.add(0);
  bp.add(-2);
  assert.equal(bp.depth, 0);
  bp.add(3);
  bp.remove(0);
  assert.equal(bp.depth, 3);
});

test("a low mark at or above the high mark is clamped, so the brake still releases", async () => {
  // A misconfiguration that left low >= high would pause forever: depth can
  // never fall below high while the producer is blocked from draining it.
  const bp = new Backpressure({ high: 2, low: 9 });
  bp.add(2);
  assert.equal(bp.paused, true);
  const waiter = bp.waitUntilDrained();
  bp.remove(1);
  assert.equal(await settled(waiter), true);
});

test("it re-arms: pausing, draining and filling again works repeatedly", async () => {
  const bp = new Backpressure({ high: 4, low: 2 });
  for (let round = 0; round < 3; round++) {
    bp.add(4);
    assert.equal(bp.paused, true, `round ${round}`);
    const waiter = bp.waitUntilDrained();
    bp.remove(4);
    assert.equal(await settled(waiter), true, `round ${round}`);
  }
});
