import { create } from "zustand";
import { queryClient } from "./query-client";
import { LIBRARY_QUERY_ROOT } from "./library-request";
import { syncJustSettled } from "./sync-settled";
import { syncSummaryKey, syncPairCardsKey } from "./sync-summary";
import type { SyncPairStatus } from "../../main/sync/types";

/** Mirrors SyncNotice in src/main/sync/types.ts. */
export interface SyncNotice {
  kind: "degraded-watch" | "files-skipped" | "conflict-copy" | "deletions-held";
  message: string;
}

/** Mirrors SyncFileErrorStatus in src/main/sync/types.ts (Contract 9). */
export interface SyncFileErrorStatus {
  path: string;
  message: string;
  permanent: boolean;
  at: number;
}

/** Mirrors PendingDeletionStatus in src/main/sync/types.ts. */
export interface PendingDeletionStatus {
  count: number;
  sample: string[];
  heldAt: number;
}

export interface SyncPairRuntimeStatus {
  pairId: string;
  workspaceId: string;
  workspaceName: string;
  remoteFolderName: string;
  localPath: string;
  syncMode: string;
  status: SyncPairStatus;
  lastSyncedAt: number | null;
  errorMessage: string | null;
  /** Non-fatal conditions worth showing while the pair keeps working. */
  notices: SyncNotice[];
  /** Files that failed to sync, newest first (capped); fileErrorCount is exact. */
  fileErrors: SyncFileErrorStatus[];
  fileErrorCount: number;
  /** Non-null while status is "needs-confirmation". */
  pendingDeletion: PendingDeletionStatus | null;
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
  /** Counts only; the Issues tab pages the list with listSyncConflicts. */
  unresolvedConflictCount: number;
  conflictCountByPair: Record<string, number>;
  recentLogs: SyncLogEntry[];
  /** Failed files across every pair (Contract 9). */
  fileErrorCount: number;
}

interface SyncStore {
  status: SyncStatus | null;
  isLoading: boolean;
  /** The status IPC itself failed - render "couldn't read sync status", never
   *  the "no folders yet" empty state (they used to be indistinguishable). */
  loadFailed: boolean;
  init: () => () => void;
  refresh: () => Promise<void>;
}

/** Empty snapshot used as the catch-fallback (includes every required field). */
const EMPTY_STATUS: SyncStatus = {
  pairs: [],
  globalPaused: false,
  activeTransfers: [],
  unresolvedConflictCount: 0,
  conflictCountByPair: {},
  recentLogs: [],
  fileErrorCount: 0,
};

// Single shared subscription, ref-counted so every consumer (TitleBar,
// Sidebar, Dashboard, SyncPage) shares ONE IPC listener instead of each
// opening its own. The listener is torn down when the last consumer unmounts.
let refCount = 0;
let unsubscribers: Array<() => void> = [];


export const useSyncStore = create<SyncStore>((set) => ({
  status: null,
  isLoading: true,
  loadFailed: false,

  init: () => {
    refCount++;
    if (refCount === 1) {
      window.electronAPI.getSyncStatus()
        .then((s: SyncStatus) => set({ status: s, isLoading: false, loadFailed: false }))
        .catch(() => set({ status: EMPTY_STATUS, isLoading: false, loadFailed: true }));

      const unsub1 = window.electronAPI.onSyncStatusChanged((s: SyncStatus) => {
        // The sync engine writes files from the main process, where there is no
        // React Query cache to invalidate - so a file pulled down while the
        // Files page was open stayed invisible until its data went stale on a
        // timer. This is the one place every status tick already arrives, which
        // makes it the right seam to close that gap.
        if (syncJustSettled(useSyncStore.getState().status, s)) {
          void queryClient.invalidateQueries({ queryKey: ["files"] });
          // Same gap for the library view (photos, videos, documents): a file pulled
          // down by sync is in no folder listing the user is looking at, but it is in
          // this one.
          void queryClient.invalidateQueries({ queryKey: [LIBRARY_QUERY_ROOT] });
          void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
        }
        set({ status: s, loadFailed: false });
      });
      // The main process stops broadcasting sync:status-changed to a window
      // that is hidden or minimized (DSK-003), so a window reopened from the
      // tray would otherwise paint status frozen at the moment it was hidden.
      // Pull a fresh snapshot the instant it is shown or restored.
      const unsub3 = window.electronAPI.onWindowShown(() => {
        useSyncStore.getState().refresh().catch(() => {
          // This pull is the ONLY thing that corrects the display after a
          // hidden spell, because `broadcast` sends on change: if the engine
          // is now idle, no further tick is coming and a silent failure here
          // leaves status frozen at the moment the window was hidden,
          // looking current. Say so with the same flag the first load uses
          // ("couldn't read sync status") rather than showing stale state.
          useSyncStore.setState({ loadFailed: true });
        });
      });
      unsubscribers = [unsub1, unsub3];
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
    const status = await window.electronAPI.getSyncStatus();
    set({ status, loadFailed: false });
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

// The sidebar's per-workspace dots used to read `useSyncPairs()` directly and
// re-derive the summary in a `useMemo`. That still re-rendered on every tick:
// `status.pairs` arrives over IPC as a new array identity each time, so the
// `useMemo`'s input changed even when its output wouldn't have (DSK-002,
// isolated in evidence/12-selector-identity.md - a frozen, byte-identical
// payload still produced ~2 commits/s). This selector returns a primitive
// string instead, built by `syncSummaryKey` (see sync-summary.ts), so the
// subscribing component only re-renders when a workspace's displayed state
// actually changes.
export const useWorkspaceSyncSummaryKey = (): string =>
  useSyncStore((s) => syncSummaryKey(s.status?.pairs ?? EMPTY_PAIRS));

// Same reasoning for the dashboard's Sync card, which the sidebar fix did
// not reach: it renders four fields per pair and none of them advance per
// tick, but it subscribed to the pairs array, so the dashboard kept
// re-rendering at 2 Hz. The 64-minute soak is what caught that - act 2 was
// still at ~59 commits per 30 s sample with the sidebar already fixed.
export const useSyncPairCardsKey = (): string =>
  useSyncStore((s) => syncPairCardsKey(s.status?.pairs ?? EMPTY_PAIRS));
