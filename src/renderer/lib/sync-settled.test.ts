import { test } from "node:test";
import assert from "node:assert/strict";

import { syncJustSettled, type SettledStatus } from "./sync-settled.ts";

/**
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner.
 *
 * This is the trigger that refreshes the file list after the sync engine has
 * written files behind the renderer's back. Getting the edge wrong is not
 * visible in the UI: firing too often refetches the listing continuously
 * through a transfer, firing too rarely leaves synced files invisible.
 */

const status = (...pairs: Array<[string, string]>): SettledStatus => ({
  pairs: pairs.map(([pairId, s]) => ({ pairId, status: s })),
});

test("a pair finishing a sync is the trigger", () => {
  assert.equal(
    syncJustSettled(status(["p1", "syncing"]), status(["p1", "idle"])),
    true,
  );
});

test("still syncing is not", () => {
  // Progress counters tick constantly during one batch; reacting to the state
  // rather than the edge would refetch on every one of them.
  assert.equal(
    syncJustSettled(status(["p1", "syncing"]), status(["p1", "syncing"])),
    false,
  );
});

test("ending in error or paused still means files may have landed", () => {
  for (const end of ["error", "paused", "offline", "rate-limited"]) {
    assert.equal(
      syncJustSettled(status(["p1", "syncing"]), status(["p1", end])),
      true,
      `${end} should count as settled`,
    );
  }
});

test("only the pair that was syncing counts", () => {
  // p2 idles throughout - its presence must not imply a completed sync.
  assert.equal(
    syncJustSettled(
      status(["p1", "syncing"], ["p2", "idle"]),
      status(["p1", "syncing"], ["p2", "idle"]),
    ),
    false,
  );
  assert.equal(
    syncJustSettled(
      status(["p1", "syncing"], ["p2", "idle"]),
      status(["p1", "idle"], ["p2", "idle"]),
    ),
    true,
  );
});

test("nothing was syncing, so nothing settled", () => {
  assert.equal(syncJustSettled(status(["p1", "idle"]), status(["p1", "idle"])), false);
});

test("the first status of the session is not a completion", () => {
  // Without a previous status there is no transition - treating the initial
  // fetch as a completion would invalidate on every app launch.
  assert.equal(syncJustSettled(null, status(["p1", "idle"])), false);
  assert.equal(syncJustSettled(undefined, status(["p1", "syncing"])), false);
});

test("a pair that disappears mid-sync does not trigger", () => {
  // Removing a sync pair is not a sync completing.
  assert.equal(syncJustSettled(status(["p1", "syncing"]), status()), false);
});
