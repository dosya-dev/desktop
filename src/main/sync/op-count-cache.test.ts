import { test } from "node:test";
import assert from "node:assert/strict";
import { createOpCountCache } from "./op-count-cache.ts";

test("computes once per pair per TTL window and then again", () => {
  let t = 0; let calls = 0;
  const c = createOpCountCache(2000, () => t);
  assert.equal(c.get("a", () => { calls++; return 7; }), 7);
  assert.equal(c.get("a", () => { calls++; return 9; }), 7, "served from the window");
  assert.equal(calls, 1);
  t = 2000;
  assert.equal(c.get("a", () => { calls++; return 9; }), 9);
  assert.equal(calls, 2);
});

test("pairs do not share an entry, and drop() forgets one", () => {
  let t = 0; const c = createOpCountCache(1000, () => t);
  c.get("a", () => 1); c.get("b", () => 2);
  assert.equal(c.get("b", () => 99), 2);
  c.drop("b");
  assert.equal(c.get("b", () => 99), 99);
  assert.equal(c.get("a", () => 99), 1);
});

test("a removed pair's count is never served after drop (Review Focus #3)", () => {
  let t = 0; const c = createOpCountCache(10_000, () => t);
  c.get("gone", () => 500);
  c.drop("gone");
  let recomputed = false;
  c.get("gone", () => { recomputed = true; return 0; });
  assert.equal(recomputed, true);
});

test("clear() forgets every pair", () => {
  let t = 0; const c = createOpCountCache(10_000, () => t);
  c.get("a", () => 1);
  c.get("b", () => 2);
  c.clear();
  let recomputedA = false;
  let recomputedB = false;
  assert.equal(c.get("a", () => { recomputedA = true; return 11; }), 11);
  assert.equal(c.get("b", () => { recomputedB = true; return 22; }), 22);
  assert.equal(recomputedA, true);
  assert.equal(recomputedB, true);
});
