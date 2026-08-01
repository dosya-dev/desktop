import { create } from "zustand";

/** Mirrors SyncNotice in src/main/sync/types.ts. */
export interface SyncNotice {
  kind: "degraded-watch" | "files-skipped";
  message: string;
}

export interface SyncPairRuntimeStatus {
  pairId: string;
  workspaceId: string;
  workspaceName: string;
  remoteFolderName: string;
  localPath: string;
  syncMode: string;
  status: "idle" | "syncing" | "paused" | "error" | "offline" | "rate-limited";
  lastSyncedAt: number | null;
  errorMessage: string | null;
  /** Non-fatal conditions worth showing while the pair keeps working. */
  notices: SyncNotice[];
  filesInQueue: number;
  totalFilesInBatch: number;
  completedFilesInBatch: number;
  totalBytesInBatch: number;
  completedBytesInBatch: number;
  batchStartedAt: number;
  /** When the current sync cycle began (prep phases included). 0 when idle. */
  syncStartedAt: number;
  phase: "scanning" | "transferring" | null;
  scannedFiles: number;
  scannedFolders: number;
  statusText: string;
}

export interface ActiveTransfer {
  pairId: string;
  filePath?: string;
  fileName: string;
  direction: "upload" | "download";
  bytesTotal: number;
  bytesTransferred: number;
  startedAt?: number;
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
}

interface SyncStore {
  status: SyncStatus | null;
  conflicts: SyncConflict[];
  isLoading: boolean;
  init: () => () => void;
  refresh: () => Promise<void>;
}

/** Empty snapshot used as the catch-fallback (includes every required field). */
const EMPTY_STATUS: SyncStatus = {
  pairs: [],
  globalPaused: false,
  activeTransfers: [],
  unresolvedConflicts: [],
  recentLogs: [],
};

/** Cap on retained conflicts so a long session can't grow this unbounded. */
const MAX_CONFLICTS = 200;

// Single shared subscription, ref-counted so every consumer (TitleBar,
// Sidebar, Dashboard, SyncPage) shares ONE IPC listener instead of each
// opening its own. The listener is torn down when the last consumer unmounts.
let refCount = 0;
let unsubscribers: Array<() => void> = [];

export const useSyncStore = create<SyncStore>((set) => ({
  status: null,
  conflicts: [],
  isLoading: true,

  init: () => {
    refCount++;
    if (refCount === 1) {
      window.electronAPI.getSyncStatus()
        .then((s: SyncStatus) => set({ status: s, isLoading: false }))
        .catch(() => set({ status: EMPTY_STATUS, isLoading: false }));

      window.electronAPI.getSyncConflicts()
        .then((c: SyncConflict[]) => set({ conflicts: c.slice(-MAX_CONFLICTS) }))
        .catch(() => {});

      const unsub1 = window.electronAPI.onSyncStatusChanged((s: SyncStatus) =>
        set({ status: s }),
      );
      const unsub2 = window.electronAPI.onSyncConflictDetected((c: SyncConflict) =>
        set((state) => ({ conflicts: [...state.conflicts, c].slice(-MAX_CONFLICTS) })),
      );
      unsubscribers = [unsub1, unsub2];
    }

    return () => {
      refCount = Math.max(0, refCount - 1);
      if (refCount === 0) {
        for (const u of unsubscribers) u();
        unsubscribers = [];
      }
    };
  },

  refresh: async () => {
    const [status, conflicts] = await Promise.all([
      window.electronAPI.getSyncStatus(),
      window.electronAPI.getSyncConflicts(),
    ]);
    set({ status, conflicts: conflicts.slice(-MAX_CONFLICTS) });
  },
}));

// ── Fine-grained selectors ──────────────────────────────────────────
// These return primitives, so a subscribing component only re-renders when
// THAT value flips - not on every status tick (which fires during a transfer).
// This is the fix for the "TitleBar/Sidebar re-render on every sync event" cost.
const EMPTY_PAIRS: SyncPairRuntimeStatus[] = [];

export const useSyncPaused = () => useSyncStore((s) => s.status?.globalPaused ?? false);
export const useSyncSyncing = () =>
  useSyncStore((s) => s.status?.pairs.some((p) => p.status === "syncing") ?? false);
export const useSyncHasError = () =>
  useSyncStore((s) => s.status?.pairs.some((p) => p.status === "error") ?? false);
export const useSyncHasPairs = () => useSyncStore((s) => (s.status?.pairs.length ?? 0) > 0);
export const useSyncPairs = (): SyncPairRuntimeStatus[] =>
  useSyncStore((s) => s.status?.pairs ?? EMPTY_PAIRS);
