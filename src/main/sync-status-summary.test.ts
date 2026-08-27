import { test } from "node:test";
import assert from "node:assert/strict";

import { summarizeSyncStatus } from "./sync-status-summary.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * The bug this covers: the tray tooltip only ever checked activeTransfers.length,
 * so a pair sitting in "error" (e.g. an expired session) with no transfer in
 * flight still showed "dosya - All synced" - the opposite of the truth. The
 * context menu already computed the right priority (paused > errors > syncing
 * > partial-paused > all synced); this extracts that same logic so the
 * tooltip can't drift from it again.
 */

const status = (overrides: Partial<Parameters<typeof summarizeSyncStatus>[0]> = {}) => ({
  pairs: [],
  activeTransfers: [],
  globalPaused: false,
  ...overrides,
});

test("reports errors even with zero active transfers", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "error" }, { status: "idle" }] })),
    "1 error",
  );
});

test("pluralizes multiple errors", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "error" }, { status: "error" }] })),
    "2 errors",
  );
});

test("global pause wins over everything else", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "error" }], globalPaused: true })),
    "Paused",
  );
});

test("all pairs paused reads as Paused, not as a partial count", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "paused" }, { status: "paused" }] })),
    "Paused",
  );
});

test("errors outrank an in-progress transfer count", () => {
  assert.equal(
    summarizeSyncStatus(
      status({ pairs: [{ status: "error" }, { status: "syncing" }], activeTransfers: [{}] }),
    ),
    "1 error",
  );
});

test("shows active transfer count while syncing", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "syncing" }], activeTransfers: [{}, {}] })),
    "Syncing 2 files…",
  );
});

test("a partial pause with nothing else going on reports the paused count", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "paused" }, { status: "idle" }] })),
    "1 paused",
  );
});

test("everything idle reports All synced", () => {
  assert.equal(summarizeSyncStatus(status({ pairs: [{ status: "idle" }] })), "All synced");
});

test("no pairs at all also reports All synced", () => {
  assert.equal(summarizeSyncStatus(status()), "All synced");
});
