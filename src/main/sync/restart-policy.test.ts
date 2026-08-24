import { test } from "node:test";
import assert from "node:assert/strict";
import { RestartPolicy, CRASH_WINDOW_MS, MAX_CRASHES_IN_WINDOW } from "./restart-policy.ts";

test("the first crash restarts immediately", () => {
  const p = new RestartPolicy();
  const d = p.recordCrash(1000);
  assert.equal(d.action, "restart");
  assert.equal(d.delayMs, 0);
  assert.equal(d.recentCrashes, 1);
});

test("backoff grows with each crash inside the window", () => {
  const p = new RestartPolicy();
  assert.equal(p.recordCrash(1000).delayMs, 0);
  assert.equal(p.recordCrash(2000).delayMs, 1000);
});

test("the third crash inside the window parks the engine", () => {
  const p = new RestartPolicy();
  p.recordCrash(1000);
  p.recordCrash(2000);
  const third = p.recordCrash(3000);
  assert.equal(third.action, "park");
  assert.equal(third.recentCrashes, MAX_CRASHES_IN_WINDOW);
  assert.equal(p.parked, true);
});

test("crashes that age out of the window do not count", () => {
  const p = new RestartPolicy();
  p.recordCrash(1000);
  p.recordCrash(2000);
  const later = p.recordCrash(2000 + CRASH_WINDOW_MS + 1);
  assert.equal(later.action, "restart", "two old crashes must not park a healthy engine");
  assert.equal(later.recentCrashes, 1);
  assert.equal(later.delayMs, 0);
});

test("a crash exactly at the window edge is still outside it", () => {
  const p = new RestartPolicy();
  p.recordCrash(1000);
  const edge = p.recordCrash(1000 + CRASH_WINDOW_MS);
  assert.equal(edge.recentCrashes, 1, "the boundary must not double-count");
});

test("a healthy run resets the ladder", () => {
  const p = new RestartPolicy();
  p.recordCrash(1000);
  p.recordCrash(2000);
  p.recordHealthy(3000);
  const next = p.recordCrash(4000);
  assert.equal(next.delayMs, 0);
  assert.equal(next.recentCrashes, 1);
});

test("a parked policy stays parked until reset", () => {
  const p = new RestartPolicy();
  p.recordCrash(1000);
  p.recordCrash(2000);
  p.recordCrash(3000);
  assert.equal(p.parked, true);
  assert.equal(p.recordCrash(4000).action, "park", "a parked engine must not keep forking");
  p.reset();
  assert.equal(p.parked, false);
  assert.equal(p.recordCrash(5000).action, "restart");
});

test("recordHealthy un-parks nothing on its own - only an explicit reset does", () => {
  const p = new RestartPolicy();
  p.recordCrash(1000);
  p.recordCrash(2000);
  p.recordCrash(3000);
  p.recordHealthy(4000);
  assert.equal(p.parked, true, "a parked engine never ran long enough to be healthy");
});

test("the delay ladder never exceeds its last rung", () => {
  const p = new RestartPolicy();
  // Two crashes, reset, repeated: the second crash always gets the same delay.
  for (let i = 0; i < 3; i++) {
    p.reset();
    p.recordCrash(1000);
    assert.equal(p.recordCrash(2000).delayMs, 1000);
  }
});
