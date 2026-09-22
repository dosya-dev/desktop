// ── Persisted Configuration ─────────────────────────────────────────

export type SyncMode =
  | "two-way"        // Full Sync - mirror both directions
  | "push"           // Push to Cloud - local changes → cloud, ignore cloud changes
  | "push-safe"      // Protect & Upload - upload only, never delete on cloud
  | "pull"           // Pull from Cloud - cloud changes → local, ignore local changes
  | "pull-safe";     // Save to Device - download only, never delete locally

export interface SyncPair {
  id: string;
  workspaceId: string;
  workspaceName: string;
  remoteFolderId: string | null;
  remoteFolderName: string;
  localPath: string;
  selectiveFolders: SelectiveFolder[];
  /** User-configured patterns to exclude from sync (e.g. "node_modules", ".env", "*.log"). */
  excludedPatterns: string[];
  region: string;
  pollIntervalMs: number;
  syncMode: SyncMode;
  conflictStrategy: "last-write-wins" | "keep-both";
  enabled: boolean;
  createdAt: number;
}

export interface SelectiveFolder {
  folderId: string;
  folderName: string;
  included: boolean;
}

export interface SyncConfig {
  pairs: SyncPair[];
  globalPollIntervalMs: number;
  pausedGlobally: boolean;
  /** Epoch ms deadline for a timed pause ("snooze"). Persisted so a crash
   *  mid-snooze can't leave pausedGlobally stuck on across restarts. */
  pausedUntil?: number;
  maxConcurrentTransfers: number;
  /** Upload/download rate caps in bytes/sec. 0 or undefined = unlimited. */
  maxUploadBytesPerSec?: number;
  maxDownloadBytesPerSec?: number;
  /** Pause all sync while the machine is running on battery. */
  pauseOnBattery?: boolean;
  /** User ID that owns this sync config. Used to detect account switches. */
  userId?: string;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  pairs: [],
  globalPollIntervalMs: 30_000,
  pausedGlobally: false,
  maxConcurrentTransfers: 3,
  maxUploadBytesPerSec: 0,
  maxDownloadBytesPerSec: 0,
  pauseOnBattery: false,
};

// ── Persisted Sync State (per pair) ─────────────────────────────────

export interface SyncFileRecord {
  remoteId: string;
  remoteName: string;
  remoteFolderId: string | null;
  remoteSizeBytes: number;
  remoteUpdatedAt: number;
  remoteVersion: number;
  localPath: string; // relative to sync pair root
  localSizeBytes: number;
  localMtimeMs: number;
  syncedAt: number;
  /** MD5 hash of file content. Used to detect actual changes vs mtime-only changes. */
  contentHash?: string;
}

export interface SyncFolderRecord {
  remoteId: string;
  remoteName: string;
  remoteParentId: string | null;
  localPath: string; // relative to sync pair root
  syncedAt: number;
}

export interface SyncFileError {
  filePath: string;
  error: string;
  retryCount: number;
  lastAttemptAt: number;
  permanent: boolean; // true for errors that won't resolve by retrying (permission, quota)
}

export interface SyncPairState {
  pairId: string;
  lastRemotePollAt: number;
  lastFullSyncAt: number;
  rootFolderCreated: boolean;
  files: Record<string, SyncFileRecord>; // keyed by remoteId
  folders: Record<string, SyncFolderRecord>; // keyed by relative path
  fileErrors: Record<string, SyncFileError>; // keyed by relative path
}

export const EMPTY_PAIR_STATE = (pairId: string): SyncPairState => ({
  pairId,
  lastRemotePollAt: 0,
  lastFullSyncAt: 0,
  rootFolderCreated: false,
  files: {},
  folders: {},
  fileErrors: {},
});

// ── Runtime State (in-memory) ───────────────────────────────────────

export type SyncPairStatus =
  | "idle"
  | "syncing"
  | "paused"
  | "error"
  | "offline"
  | "rate-limited"
  /** Held: a large local deletion is waiting for the user to confirm or
   *  keep the cloud copies (see PendingDeletionStatus). Nothing syncs until
   *  they decide. */
  | "needs-confirmation";

export type TransferDirection = "upload" | "download";

export interface ActiveTransfer {
  pairId: string;
  filePath: string;
  fileName: string;
  direction: TransferDirection;
  bytesTotal: number;
  bytesTransferred: number;
  startedAt: number;
}

export interface SyncConflict {
  id: string;
  pairId: string;
  localPath: string;
  remoteName: string;
  remoteId: string;
  localMtimeMs: number;
  remoteUpdatedAt: number;
  localSizeBytes: number;
  remoteSizeBytes: number;
  detectedAt: number;
}

export interface SyncLogEntry {
  timestamp: number;
  pairId: string;
  message: string;
}

export interface SyncStatus {
  pairs: SyncPairRuntimeStatus[];
  globalPaused: boolean;
  activeTransfers: ActiveTransfer[];
  unresolvedConflicts: SyncConflict[];
  recentLogs: SyncLogEntry[];
  /** Files that failed to sync across every pair (Contract 9). The tray's
   *  "All synced" is a lie whenever this is non-zero. */
  fileErrorCount: number;
  /** A platform switch has paused this surface - see remote-client.ts's
   *  MaintenanceError and SyncEngine.setMaintenance. Cleared the same way an
   *  offline pair clears: the next successful round trip proves the switch
   *  is back on. */
  maintenance?: boolean;
}

/** One failed file as the UI sees it (Contract 9). */
export interface SyncFileErrorStatus {
  path: string;
  message: string;
  /** True when retrying by itself will not help (permission, quota, or the
   *  retry ladder ran out). The Sync page's Retry resets it. */
  permanent: boolean;
  /** Epoch ms of the last attempt. */
  at: number;
}

/**
 * A large local deletion the engine refused to mirror to the cloud until the
 * user says so. Held in the runtime and surfaced on the pair's status; the
 * Sync page renders the question and calls confirm/dismiss.
 */
export interface PendingDeletionStatus {
  /** Files that disappeared locally and would be deleted from the cloud. */
  count: number;
  /** A few of their relative paths, for the banner. */
  sample: string[];
  /** Epoch ms when the deletion was held. */
  heldAt: number;
}

/** A non-fatal, user-visible condition attached to a pair. */
export interface SyncNotice {
  kind: "degraded-watch" | "files-skipped" | "conflict-copy" | "deletions-held";
  message: string;
}

export interface SyncPairRuntimeStatus {
  pairId: string;
  workspaceId: string;
  workspaceName: string;
  remoteFolderName: string;
  localPath: string;
  syncMode: SyncMode;
  status: SyncPairStatus;
  lastSyncedAt: number | null;
  errorMessage: string | null;
  /**
   * Non-fatal conditions the user needs to know about while the pair keeps
   * working - live watching downgraded to periodic rescans, files skipped for
   * being too large. These are not errors (`status` stays idle/syncing), so
   * they had nowhere to surface and only ever reached a console warning.
   */
  notices: SyncNotice[];
  /** Files that failed to sync, newest first, capped (see status-assembly). */
  fileErrors: SyncFileErrorStatus[];
  /** The TRUE number of failed files for this pair - the list above is capped. */
  fileErrorCount: number;
  /** Non-null while status is "needs-confirmation". */
  pendingDeletion: PendingDeletionStatus | null;
  /** Files still waiting to be transferred this cycle (queued ops, or the
   *  batch remainder for the two-way executor). 0 when idle. */
  filesInQueue: number;
  /** Total files in the current batch operation (scan/reconcile). 0 when idle. */
  totalFilesInBatch: number;
  /** Files completed so far in the current batch. */
  completedFilesInBatch: number;
  /** Total bytes across all files in the current batch. */
  totalBytesInBatch: number;
  /** Bytes completed so far in the current batch. */
  completedBytesInBatch: number;
  /** Timestamp when the current batch started (for ETA calculation). */
  batchStartedAt: number;
  /** Timestamp when the current sync cycle began, including the prep phases
   *  (snapshot fetch + local scan) before any transfer. 0 when idle. Lets the
   *  UI show elapsed time during the indeterminate "scanning" phase. */
  syncStartedAt: number;
  /** "scanning" while walking the tree, "transferring" during uploads, null when idle. */
  phase: "scanning" | "transferring" | null;
  /** Number of files discovered so far during the scan walk. */
  scannedFiles: number;
  /** Number of folders discovered so far during the scan walk. */
  scannedFolders: number;
  /** Human-readable status text describing what the engine is doing right now. */
  statusText: string;
}

// ── Remote Data Shapes ──────────────────────────────────────────────

export interface RemoteFileInfo {
  id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  extension: string | null;
  region: string;
  folder_id: string | null;
  updated_at: number;
  current_version: number;
  /** The file's own modification time (unix seconds) as the uploader
   *  declared it - applied to downloads so the date survives the round
   *  trip. Absent or null when the server does not know it. */
  source_modified_at?: number | null;
}

export interface RemoteFolderInfo {
  id: string;
  name: string;
  parent_id: string | null;
  file_count: number;
}

export interface LocalFileStat {
  sizeBytes: number;
  mtimeMs: number;
  isDirectory: boolean;
}

// ── Sync Actions (output of reconciler) ─────────────────────────────

export type SyncAction =
  | { type: "download-new"; remoteFile: RemoteFileInfo; localDir: string }
  | {
      type: "download-update";
      remoteFile: RemoteFileInfo;
      localPath: string;
      existingRecord: SyncFileRecord;
    }
  | {
      type: "upload-new";
      localPath: string;
      remoteFolderId: string | null;
      stat: LocalFileStat;
      fileName: string;
    }
  | {
      type: "upload-update";
      localPath: string;
      existingRecord: SyncFileRecord;
      stat: LocalFileStat;
    }
  | { type: "delete-local"; localPath: string; record: SyncFileRecord }
  | { type: "delete-remote"; remoteId: string; record: SyncFileRecord }
  | { type: "move-local"; oldLocalPath: string; newLocalPath: string; remoteFile: RemoteFileInfo; record: SyncFileRecord }
  | {
      type: "create-remote-folder";
      localPath: string;
      parentRemoteId: string | null;
      name: string;
    }
  | {
      type: "create-local-folder";
      remoteFolderId: string;
      localDir: string;
      name: string;
    }
  | { type: "conflict"; conflict: SyncConflict };
