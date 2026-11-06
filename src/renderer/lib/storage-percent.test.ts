import { test } from "node:test";
import assert from "node:assert/strict";

import { storagePercent } from "./storage-percent.ts";

/** Run with `npm run test:unit` in apps/desktop - Node's own test runner. */

const GB = 1024 ** 3;
const MB = 1024 ** 2;

test("2 MB of 5 GB reads <1%, not 0%, and the bar keeps a visible sliver", () => {
  const p = storagePercent(2 * MB, 5 * GB);
  assert.equal(p.pct, 0);
  assert.equal(p.label, "<1");
  assert.match(p.barWidth, /^max\([\d.]+%, 4px\)$/);
});

test("nothing used is a real 0 with an empty bar", () => {
  assert.deepEqual(storagePercent(0, 5 * GB), { pct: 0, label: "0", barWidth: "0%" });
});

test("no cap (still loading) is 0, never NaN or Infinity", () => {
  assert.deepEqual(storagePercent(2 * MB, 0), { pct: 0, label: "0", barWidth: "0%" });
});

test("whole percents round as before", () => {
  const p = storagePercent(1.5 * GB, 5 * GB);
  assert.equal(p.pct, 30);
  assert.equal(p.label, "30");
  assert.equal(p.barWidth, "max(30%, 4px)");
});

test("over quota caps at 100", () => {
  const p = storagePercent(6 * GB, 5 * GB);
  assert.equal(p.pct, 100);
  assert.equal(p.label, "100");
  assert.equal(p.barWidth, "max(100%, 4px)");
});
