import { test } from "node:test";
import assert from "node:assert/strict";
import { toFileErrorStatus, pendingFileCount, assembleSyncStatus, hasPair, FILE_ERROR_LIST_CAP } from "./status-assembly.ts";
import type { SyncFileError, SyncPairRuntimeStatus } from "./types.ts";

// Field report 2026-09-02 (desktop #6): getStatus() never exported the
// fileErrors ledger and hard-coded filesInQueue to 0, so the UI could not tell
// "everything synced" from "everything that could sync did". These helpers
// are the electron-free part of the fix; getStatus() delegates to them.

function err(o: Partial<SyncFileError> = {}): SyncFileError {
  return { filePath: "a.txt", error: "boom", retryCount: 1, lastAttemptAt: 10, permanent: false, ...o };
}

function pairStatus(o: Partial<SyncPairRuntimeStatus> = {}): SyncPairRuntimeStatus {
  return {
    pairId: "sp_1", workspaceId: "ws_1", workspaceName: "Personal", remoteFolderName: "Docs",
    localPath: "/u/Docs", syncMode: "push-safe", status: "idle", lastSyncedAt: null, errorMessage: null,
    notices: [], fileErrors: [], fileErrorCount: 0, pendingDeletion: null, filesInQueue: 0,
    totalFilesInBatch: 0, completedFilesInBatch: 0, totalBytesInBatch: 0, completedBytesInBatch: 0,
    batchStartedAt: 0, syncStartedAt: 0, phase: null, scannedFiles: 0, scannedFolders: 0, statusText: "",
    ...o,
  };
}

test("file errors are exported per Contract 9: path, message, permanent, at - newest first", () => {
  const out = toFileErrorStatus([
    err({ filePath: "old.txt", lastAttemptAt: 1 }),
    err({ filePath: "new.txt", lastAttemptAt: 9, error: "quota exceeded", permanent: true }),
  ]);
  assert.deepEqual(out, [
    { path: "new.txt", message: "quota exceeded", permanent: true, at: 9 },
    { path: "old.txt", message: "boom", permanent: false, at: 1 },
  ]);
});

test("the exported list is capped so a failing 100K-file tree cannot flood IPC", () => {
  const many = Array.from({ length: FILE_ERROR_LIST_CAP + 50 }, (_, i) => err({ filePath: `f${i}`, lastAttemptAt: i }));
  const out = toFileErrorStatus(many);
  assert.equal(out.length, FILE_ERROR_LIST_CAP);
  // The newest survive the cap, not the oldest.
  assert.equal(out[0].path, `f${FILE_ERROR_LIST_CAP + 49}`);
});

test("filesInQueue is the real pending count: queued ops when the ops table drives the pair", () => {
  assert.equal(pendingFileCount({ queuedOps: 7, totalFilesInBatch: 0, completedFilesInBatch: 0 }), 7);
});

test("filesInQueue falls back to the batch remainder for the two-way executor, which has no queue", () => {
  assert.equal(pendingFileCount({ queuedOps: 0, totalFilesInBatch: 10, completedFilesInBatch: 4 }), 6);
  // Never negative, even if completed overshoots (a counter race).
  assert.equal(pendingFileCount({ queuedOps: 0, totalFilesInBatch: 3, completedFilesInBatch: 5 }), 0);
});

test("fileErrorCount at the top level is the sum of every pair's TRUE count, not the capped lists", () => {
  const status = assembleSyncStatus({
    pairs: [
      pairStatus({ pairId: "a", fileErrors: [{ path: "x", message: "m", permanent: false, at: 1 }], fileErrorCount: 250 }),
      pairStatus({ pairId: "b", fileErrorCount: 2 }),
      pairStatus({ pairId: "c" }),
    ],
    globalPaused: false,
    activeTransfers: [],
    unresolvedConflicts: [],
    recentLogs: [],
  });
  assert.equal(status.fileErrorCount, 252);
  assert.equal(status.pairs.length, 3);
  assert.equal(status.globalPaused, false);
});

test("hasPair tells the IPC layer whether a pairId names a live pair", () => {
  // Fix round 1, minor (c): the new handlers validated that pairId is a
  // string but not that it names anything, so a stale renderer could ask the
  // engine to act on a pair that no longer exists.
  const status = assembleSyncStatus({
    pairs: [pairStatus({ pairId: "sp_1" }), pairStatus({ pairId: "sp_2" })],
    globalPaused: false, activeTransfers: [], unresolvedConflicts: [], recentLogs: [],
  });
  assert.equal(hasPair(status, "sp_1"), true);
  assert.equal(hasPair(status, "sp_9"), false);
  assert.equal(hasPair(status, ""), false);
});
