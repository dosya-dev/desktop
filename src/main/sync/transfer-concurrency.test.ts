import { test } from "node:test";
import assert from "node:assert/strict";
import {
  directConcurrencyFor,
  TRANSFER_CONCURRENCY_CAP,
  TINY_FILE_MAX_BYTES,
  TINY_TRANSFER_CONCURRENCY_CAP,
} from "./transfer-concurrency.ts";

test("the default setting (3) gives 6 standard workers, not 18", () => {
  // The old base*6 formula turned "max 3 transfers" into 18-36 unpaced PUTs,
  // which saturated a residential uplink and took the whole network down
  // (2026-08-20 stress test). base*2 keeps the setting honest.
  assert.equal(directConcurrencyFor(3, 5 * 1024 * 1024), 6);
  assert.equal(directConcurrencyFor(3, Number.POSITIVE_INFINITY), 6);
});

test("tiny-file chunks run twice as deep as standard", () => {
  assert.equal(directConcurrencyFor(3, TINY_FILE_MAX_BYTES), 12);
  assert.equal(directConcurrencyFor(3, 1), 12);
});

test("the tiny boundary is inclusive", () => {
  assert.equal(directConcurrencyFor(3, TINY_FILE_MAX_BYTES + 1), 6);
});

test("caps hold for high settings", () => {
  assert.equal(directConcurrencyFor(100, 5 * 1024 * 1024), TRANSFER_CONCURRENCY_CAP);
  assert.equal(directConcurrencyFor(100, 1), TINY_TRANSFER_CONCURRENCY_CAP);
  assert.equal(TRANSFER_CONCURRENCY_CAP, 12);
  assert.equal(TINY_TRANSFER_CONCURRENCY_CAP, 16);
});

test("a 1-transfer setting stays close to 1: 2 std, 4 tiny", () => {
  assert.equal(directConcurrencyFor(1, 5 * 1024 * 1024), 2);
  assert.equal(directConcurrencyFor(1, 1), 4);
});

test("bogus base values degrade to the minimum, not NaN", () => {
  assert.equal(directConcurrencyFor(0, 1024), 4); // tiny path: std 2 * 2
  assert.equal(directConcurrencyFor(0, 5 * 1024 * 1024), 2);
  assert.equal(directConcurrencyFor(NaN as unknown as number, 5 * 1024 * 1024), 2);
});

test("an empty chunk (max 0 bytes) counts as tiny and stays harmless", () => {
  // reduce(..., 0) over zero uploads yields 0; the worker count is then
  // clamped by Math.min(workers, uploads.length) at the call site anyway.
  assert.equal(directConcurrencyFor(3, 0), 12);
});
