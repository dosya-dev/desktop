import { test } from "node:test";
import assert from "node:assert/strict";
import {
  directConcurrencyFor,
  TRANSFER_CONCURRENCY_CAP,
  TINY_FILE_MAX_BYTES,
  TINY_TRANSFER_CONCURRENCY_CAP,
} from "./transfer-concurrency.ts";

test("mixed/large chunks keep the standard formula", () => {
  // Default setting (3): 18 workers regardless of how large the files are.
  assert.equal(directConcurrencyFor(3, 5 * 1024 * 1024), 18);
  assert.equal(directConcurrencyFor(3, Number.POSITIVE_INFINITY), 18);
});

test("tiny-file chunks run twice as deep", () => {
  assert.equal(directConcurrencyFor(3, TINY_FILE_MAX_BYTES), 36);
  assert.equal(directConcurrencyFor(3, 1), 36);
});

test("the tiny boundary is inclusive", () => {
  assert.equal(directConcurrencyFor(3, TINY_FILE_MAX_BYTES + 1), 18);
});

test("both paths respect their caps for high settings", () => {
  assert.equal(directConcurrencyFor(100, 5 * 1024 * 1024), TRANSFER_CONCURRENCY_CAP);
  assert.equal(directConcurrencyFor(100, 1), TINY_TRANSFER_CONCURRENCY_CAP);
});

test("the floor of 6 (12 for tiny) holds for a 1-transfer setting", () => {
  assert.equal(directConcurrencyFor(1, 5 * 1024 * 1024), 6);
  assert.equal(directConcurrencyFor(1, 1), 12);
});

test("an empty chunk (max 0 bytes) counts as tiny and stays harmless", () => {
  // reduce(..., 0) over zero uploads yields 0; the worker count is then
  // clamped by Math.min(workers, uploads.length) at the call site anyway.
  assert.equal(directConcurrencyFor(3, 0), 36);
});
