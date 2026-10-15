import { test } from "node:test";
import assert from "node:assert/strict";

import { syncPairCards, syncPairCardsKey, type SyncPairCard } from "./sync-summary.ts";

/**
 * The dashboard's Sync card, which the sidebar's DSK-002 fix did not reach.
 *
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner.
 *
 * In its own file rather than appended to sync-summary.test.ts because it
 * pins a different component's contract: the sidebar collapses pairs to
 * per-workspace FLAGS, the card renders four per-pair FIELDS in order, and
 * the two keys are deliberately different shapes (sorted vs ordered).
 */
function card(pairId: string, folder: string, ws: string, status: string): SyncPairCard {
  return { pairId, remoteFolderName: folder, workspaceName: ws, status };
}

/**
 * The property that matters, and the reason this exists: a status tick whose
 * four DISPLAYED fields are unchanged must produce the same key, even though
 * every other field of the pair advanced. The engine's payload carries
 * `filesInQueue`, byte counters and timestamps that move constantly, and the
 * card shows none of them - so none of them may cause a re-render.
 */
test("syncPairCardsKey is stable across ticks that change nothing displayed", () => {
  const a = syncPairCardsKey([card("sp_1", "Photos", "Test Workspace", "syncing")]);
  const b = syncPairCardsKey([card("sp_1", "Photos", "Test Workspace", "syncing")]);
  assert.equal(a, b);
});

test("syncPairCardsKey changes when any displayed field changes", () => {
  const base = syncPairCardsKey([card("sp_1", "Photos", "Test Workspace", "syncing")]);
  assert.notEqual(base, syncPairCardsKey([card("sp_2", "Photos", "Test Workspace", "syncing")]));
  assert.notEqual(base, syncPairCardsKey([card("sp_1", "Docs", "Test Workspace", "syncing")]));
  assert.notEqual(base, syncPairCardsKey([card("sp_1", "Photos", "Second Workspace", "syncing")]));
  assert.notEqual(base, syncPairCardsKey([card("sp_1", "Photos", "Test Workspace", "idle")]));
});

test("syncPairCardsKey is order-sensitive, because the card renders in order", () => {
  const one = syncPairCardsKey([card("sp_1", "A", "W", "idle"), card("sp_2", "B", "W", "idle")]);
  const two = syncPairCardsKey([card("sp_2", "B", "W", "idle"), card("sp_1", "A", "W", "idle")]);
  assert.notEqual(one, two);
});

test("a separator inside a folder name cannot collide two different lists", () => {
  // A folder genuinely called "a|b" must not key the same as two fields "a"
  // and "b". That is what the length prefix is for.
  const sneaky = syncPairCardsKey([card("sp_1", "a|b", "W", "idle")]);
  const plain = syncPairCardsKey([card("sp_1", "a", "b", "idle")]);
  assert.notEqual(sneaky, plain);

  // Same for the record separator: one pair whose name contains a newline
  // against two pairs.
  const newlined = syncPairCardsKey([card("sp_1", "x\ny", "W", "idle")]);
  const twoRows = syncPairCardsKey([card("sp_1", "x", "W", "idle"), card("y", "W", "idle", "z")]);
  assert.notEqual(newlined, twoRows);
});

test("syncPairCardsKey handles an empty list", () => {
  assert.equal(syncPairCardsKey([]), "");
});

test("syncPairCards copies only the rendered fields", () => {
  const rows = syncPairCards([card("sp_1", "Photos", "Test Workspace", "syncing")]);
  assert.deepEqual(rows, [
    { pairId: "sp_1", remoteFolderName: "Photos", workspaceName: "Test Workspace", status: "syncing" },
  ]);
});
