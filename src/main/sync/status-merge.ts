import type { SyncPair, SyncPairRuntimeStatus } from "./types";

/**
 * The Sync tab renders getStatus(), the duplicate-folder check reads the
 * persisted config - two sources of truth. After the 2026-08-20 crash the
 * config still held the pair but no runtime had started (pausedGlobally was
 * wedged on), so the tab showed "No sync folders yet" while re-adding the
 * folder said "already being synced". These helpers close that gap: every
 * configured pair appears in the status, runtime or not.
 *
 * Electron-free so node --test can load it.
 */

export function synthesizePairStatus(pair: SyncPair, pausedGlobally: boolean): SyncPairRuntimeStatus {
  const paused = pausedGlobally || !pair.enabled;
  return {
    pairId: pair.id,
    workspaceId: pair.workspaceId,
    workspaceName: pair.workspaceName,
    remoteFolderName: pair.remoteFolderName,
    localPath: pair.localPath,
    syncMode: pair.syncMode || "push-safe",
    status: paused ? "paused" : "error",
    lastSyncedAt: null,
    errorMessage: paused
      ? null
      : 'This folder is set up but not syncing right now. Click "Sync now" or restart the app.',
    notices: [],
    filesInQueue: 0,
    totalFilesInBatch: 0,
    completedFilesInBatch: 0,
    totalBytesInBatch: 0,
    completedBytesInBatch: 0,
    batchStartedAt: 0,
    syncStartedAt: 0,
    phase: null,
    scannedFiles: 0,
    scannedFolders: 0,
    statusText: "",
  };
}

/** Runtime entries first (live data wins), then a placeholder for every
 *  configured pair that has no runtime. */
export function mergeStatusPairs(
  runtimePairs: SyncPairRuntimeStatus[],
  configPairs: SyncPair[],
  pausedGlobally: boolean,
): SyncPairRuntimeStatus[] {
  const seen = new Set(runtimePairs.map((p) => p.pairId));
  const merged = [...runtimePairs];
  for (const pair of configPairs) {
    if (!seen.has(pair.id)) merged.push(synthesizePairStatus(pair, pausedGlobally));
  }
  return merged;
}
