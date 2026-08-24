import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockTrackingApplies,
  shouldAttemptDelta,
  deltaIsWorthIt,
  DELTA_MIN_BYTES,
  DELTA_MAX_BYTES,
  DELTA_MAX_CHUNKS,
} from "./delta-eligibility.ts";

const MB = 1024 * 1024;

// These limits mirror the server's: /api/sync/chunks/commit reassembles by
// streaming every chunk through the Worker, capped at 64 MB and 8192 chunks.
// Getting them wrong here means the client confidently builds a request the
// server will refuse, and the upload fails instead of falling back.

test("the tracked band matches what the server can reassemble", () => {
  assert.equal(DELTA_MIN_BYTES, 8 * MB);
  assert.equal(DELTA_MAX_BYTES, 64 * MB);
  assert.equal(DELTA_MAX_CHUNKS, 8192);
});

test("chunk lists are kept only inside the useful band", () => {
  assert.equal(blockTrackingApplies(1 * MB), false);          // too small to pay off
  assert.equal(blockTrackingApplies(8 * MB), true);           // floor is inclusive
  assert.equal(blockTrackingApplies(30 * MB), true);
  assert.equal(blockTrackingApplies(64 * MB), true);          // ceiling is inclusive
  assert.equal(blockTrackingApplies(65 * MB), false);         // server cannot reassemble
  assert.equal(blockTrackingApplies(2 * 1024 * MB), false);   // a 2 GB file: whole-file only
});

test("a small file is sent whole", () => {
  const d = shouldAttemptDelta(1 * MB, 10, 1);
  assert.equal(d.attempt, false);
  assert.match(d.reason, /small enough/);
});

test("a file past the server ceiling is sent whole, however many chunks it has", () => {
  const d = shouldAttemptDelta(2 * 1024 * MB, 500, 2000);
  assert.equal(d.attempt, false);
  assert.match(d.reason, /larger than the server can reassemble/);
});

test("with no previous chunk list there is nothing to diff against", () => {
  // Every chunk would upload AND a reassembly would be requested - strictly
  // worse than just sending the file once.
  const d = shouldAttemptDelta(30 * MB, 0, 30);
  assert.equal(d.attempt, false);
  assert.match(d.reason, /no previous chunk list/);
});

test("too many chunks for the server is refused before the request is built", () => {
  const d = shouldAttemptDelta(60 * MB, 100, DELTA_MAX_CHUNKS + 1);
  assert.equal(d.attempt, false);
  assert.match(d.reason, /more chunks than the server accepts/);
});

test("a file with a prior list, in band, is worth attempting", () => {
  const d = shouldAttemptDelta(30 * MB, 30, 30);
  assert.equal(d.attempt, true);
  assert.equal(d.reason, "");
});

test("an empty chunking result never attempts a delta", () => {
  assert.equal(shouldAttemptDelta(30 * MB, 30, 0).attempt, false);
});

test("a delta that reuses almost nothing is not worth it", () => {
  // Same bytes as a plain upload, plus a reassembly on top.
  assert.equal(deltaIsWorthIt(100, 95), false);
  assert.equal(deltaIsWorthIt(100, 81), false);
  assert.equal(deltaIsWorthIt(100, 80), true);   // the boundary is inclusive
  assert.equal(deltaIsWorthIt(100, 5), true);    // the case this exists for
  assert.equal(deltaIsWorthIt(0, 0), false);     // no division by zero
});
