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

// ── Truthful "All synced" (field report 2026-09-02, desktop #6) ─────────
// The summary only ever looked at pair status and active transfers, so a pair
// that ended its cycle "idle" with fifteen files parked in fileErrors still
// read "All synced". Failed files are now counted and outrank the happy path.

test("files that failed to sync are reported instead of All synced", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "idle" }], fileErrorCount: 3 })),
    "3 files not synced",
  );
});

test("a single failed file reads in the singular", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "idle" }], fileErrorCount: 1 })),
    "1 file not synced",
  );
});

test("active syncing still outranks failed files - they may be retried this cycle", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "syncing" }], activeTransfers: [{}], fileErrorCount: 3 })),
    "Syncing 1 file…",
  );
});

test("a pair-level error outranks failed files", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "error" }], fileErrorCount: 3 })),
    "1 error",
  );
});

test("failed files outrank a partial pause - the pause was deliberate, the failures were not", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "paused" }, { status: "idle" }], fileErrorCount: 2 })),
    "2 files not synced",
  );
});

test("a folder waiting on a deletion decision reads as needing attention", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "needs-confirmation" }, { status: "idle" }] })),
    "1 folder needs attention",
  );
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "needs-confirmation" }, { status: "needs-confirmation" }] })),
    "2 folders need attention",
  );
});

test("a missing fileErrorCount (older status shape) still reads All synced", () => {
  assert.equal(summarizeSyncStatus({ pairs: [{ status: "idle" }], activeTransfers: [], globalPaused: false }), "All synced");
});

// ── Re-audit: offline must not read as "All synced" ─────────────────

test("a pair that cannot reach the server reads as Offline, not All synced", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "offline" }] })),
    "Offline",
  );
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "offline" }, { status: "offline" }] })),
    "Offline",
  );
});

test("one offline folder among healthy ones is counted, not hidden", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "offline" }, { status: "idle" }] })),
    "1 offline",
  );
});

test("a real pair error still outranks offline", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "error" }, { status: "offline" }] })),
    "1 error",
  );
});

test("offline outranks files that failed to sync - the network is why they failed", () => {
  assert.equal(
    summarizeSyncStatus(status({ pairs: [{ status: "offline" }], fileErrorCount: 4 })),
    "Offline",
  );
});

// ── Platform switches: a maintenance pause outranks everything ──────

test("maintenance outranks everything", () => {
  assert.equal(
    summarizeSyncStatus(
      status({ pairs: [{ status: "error" }], activeTransfers: [1], globalPaused: false, maintenance: true }),
    ),
    "Sync paused · maintenance",
  );
});
