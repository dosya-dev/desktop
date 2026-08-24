import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeStatusPairs, synthesizePairStatus } from "./status-merge.ts";
import type { SyncPair, SyncPairRuntimeStatus } from "./types.ts";

// The 2026-08-20 stress test: after a crash the Sync tab rendered EMPTY while
// "add folder" still said "already being synced". The duplicate check reads
// the persisted config; the tab rendered only started runtimes. getStatus()
// now merges both so a configured pair can never silently vanish from the UI.

function pair(overrides: Partial<SyncPair> = {}): SyncPair {
  return {
    id: "sp_1",
    workspaceId: "ws_1",
    workspaceName: "Personal",
    remoteFolderId: "fo_1",
    remoteFolderName: "Downloads",
    localPath: "/Users/u/Downloads",
    selectiveFolders: [],
    excludedPatterns: [],
    region: "auto",
    pollIntervalMs: 30000,
    syncMode: "push-safe",
    conflictStrategy: "last-write-wins",
    enabled: true,
    createdAt: 1,
    ...overrides,
  };
}

function runtimeStatus(pairId: string): SyncPairRuntimeStatus {
  return {
    pairId,
    workspaceId: "ws_1",
    workspaceName: "Personal",
    remoteFolderName: "Downloads",
    localPath: "/Users/u/Downloads",
    syncMode: "push-safe",
    status: "syncing",
    lastSyncedAt: 123,
    errorMessage: null,
    notices: [],
    filesInQueue: 0,
    totalFilesInBatch: 10,
    completedFilesInBatch: 5,
    totalBytesInBatch: 100,
    completedBytesInBatch: 50,
    batchStartedAt: 1,
    syncStartedAt: 1,
    phase: "transferring",
    scannedFiles: 10,
    scannedFolders: 2,
    statusText: "Uploading...",
  };
}

test("a configured pair with no runtime shows as paused when globally paused", () => {
  const merged = mergeStatusPairs([], [pair()], true);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].pairId, "sp_1");
  assert.equal(merged[0].status, "paused");
  assert.equal(merged[0].errorMessage, null);
  assert.equal(merged[0].localPath, "/Users/u/Downloads");
});

test("a configured, enabled pair with no runtime and no global pause shows as error", () => {
  const merged = mergeStatusPairs([], [pair()], false);
  assert.equal(merged[0].status, "error");
  assert.match(merged[0].errorMessage ?? "", /not syncing right now/);
});

test("a disabled pair with no runtime shows as paused", () => {
  const merged = mergeStatusPairs([], [pair({ enabled: false })], false);
  assert.equal(merged[0].status, "paused");
});

test("runtime entries pass through untouched and are not duplicated", () => {
  const rt = runtimeStatus("sp_1");
  const merged = mergeStatusPairs([rt], [pair(), pair({ id: "sp_2", localPath: "/Users/u/Docs" })], false);
  assert.equal(merged.length, 2);
  assert.equal(merged[0], rt); // same object, untouched
  assert.equal(merged[1].pairId, "sp_2");
  assert.equal(merged[1].status, "error");
});

test("empty config and empty runtimes merge to an empty list", () => {
  assert.deepEqual(mergeStatusPairs([], [], false), []);
});

test("synthesized entries carry every SyncPairRuntimeStatus field", () => {
  const s = synthesizePairStatus(pair(), true);
  // A missing field here crashes the renderer's progress math - keep the
  // placeholder shape complete.
  assert.equal(s.totalFilesInBatch, 0);
  assert.equal(s.completedBytesInBatch, 0);
  assert.equal(s.phase, null);
  assert.equal(s.lastSyncedAt, null);
  assert.deepEqual(s.notices, []);
  assert.equal(s.syncMode, "push-safe");
  assert.equal(s.statusText, "");
});
