// ── Persisted Configuration ─────────────────────────────────────────

export type SyncMode =
  | "two-way"        // Full Sync — mirror both directions
  | "push"           // Push to Cloud — local changes → cloud, ignore cloud changes
  | "push-safe"      // Protect & Upload — upload only, never delete on cloud
  | "pull"           // Pull from Cloud — cloud changes → local, ignore local changes
  | "pull-safe";     // Save to Device — download only, never delete locally

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
  maxConcurrentTransfers: number;
}

export const DEFAULT_SYNC_CONFIG: SyncConfig = {
  pairs: [],
  globalPollIntervalMs: 30_000,
  pausedGlobally: false,
  maxConcurrentTransfers: 3,
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
  | "rate-limited";

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

export interface SyncStatus {
  pairs: SyncPairRuntimeStatus[];
  globalPaused: boolean;
  activeTransfers: ActiveTransfer[];
  unresolvedConflicts: SyncConflict[];
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
  /** "scanning" while walking the tree, "transferring" during uploads, null when idle. */
  phase: "scanning" | "transferring" | null;
  /** Number of files discovered so far during the scan walk. */
  scannedFiles: number;
  /** Number of folders discovered so far during the scan walk. */
  scannedFolders: number;
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
