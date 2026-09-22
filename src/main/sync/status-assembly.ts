import type {
  SyncFileError,
  SyncFileErrorStatus,
  SyncPairRuntimeStatus,
  SyncStatus,
} from "./types";

/**
 * The electron-free half of getStatus().
 *
 * Field report 2026-09-02 (desktop #6): the engine kept a per-file error
 * ledger but never exported it, hard-coded filesInQueue to 0, and dropped a
 * pair back to "idle" at the end of every cycle regardless of what failed -
 * so the Sync page and the tray could only ever say "All synced". These
 * helpers shape the ledger for the UI (Contract 9) and compute the real
 * pending count; the engine's getStatus() delegates to them so the logic is
 * testable under plain `node --test`, which cannot load the engine itself.
 *
 * Type-only sibling imports on purpose - see index-db.ts for why a module a
 * test loads directly has to be a leaf.
 */

/**
 * How many failed files a single status message carries per pair. The TRUE
 * count travels separately (fileErrorCount); this only bounds the list so a
 * tree where 100K files hit EACCES does not push 100K rows through IPC on
 * every 500 ms status tick.
 */
export const FILE_ERROR_LIST_CAP = 200;

/** Ledger rows → Contract 9 shape, newest attempt first, capped. */
export function toFileErrorStatus(errors: Iterable<SyncFileError>): SyncFileErrorStatus[] {
  const rows = [...errors].sort((a, b) => b.lastAttemptAt - a.lastAttemptAt);
  return rows.slice(0, FILE_ERROR_LIST_CAP).map((e) => ({
    path: e.filePath,
    message: e.error,
    permanent: e.permanent === true,
    at: e.lastAttemptAt,
  }));
}

/**
 * Files still waiting to move. Push-mode pairs are driven by the persistent
 * ops table, so the queued count is the truth there; the two-way executor
 * runs an in-memory action list and only knows its batch counters.
 */
export function pendingFileCount(input: {
  queuedOps: number;
  totalFilesInBatch: number;
  completedFilesInBatch: number;
}): number {
  const remainder = Math.max(0, input.totalFilesInBatch - input.completedFilesInBatch);
  return Math.max(input.queuedOps, remainder);
}

/** Whether a pairId names a pair in this status - the IPC layer's existence check. */
export function hasPair(status: Pick<SyncStatus, "pairs">, pairId: string): boolean {
  return pairId !== "" && status.pairs.some((p) => p.pairId === pairId);
}

/** Assemble the top-level status; fileErrorCount is the sum of the true per-pair counts. */
export function assembleSyncStatus(input: Omit<SyncStatus, "fileErrorCount"> & { pairs: SyncPairRuntimeStatus[] }): SyncStatus {
  return {
    ...input,
    fileErrorCount: input.pairs.reduce((n, p) => n + (p.fileErrorCount || 0), 0),
  };
}
