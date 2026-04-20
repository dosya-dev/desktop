import { create } from "zustand";

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
  filesInQueue: number;
  totalFilesInBatch: number;
  completedFilesInBatch: number;
}

export interface ActiveTransfer {
  pairId: string;
  fileName: string;
  direction: "upload" | "download";
  bytesTotal: number;
  bytesTransferred: number;
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

interface SyncStore {
  status: SyncStatus | null;
  conflicts: SyncConflict[];
  isLoading: boolean;
  init: () => () => void;
  refresh: () => Promise<void>;
}

export const useSyncStore = create<SyncStore>((set) => ({
  status: null,
  conflicts: [],
  isLoading: true,

  init: () => {
    window.electronAPI.getSyncStatus()
      .then((s: SyncStatus) => set({ status: s, isLoading: false }))
      .catch(() => set({ status: { pairs: [], globalPaused: false, activeTransfers: [], unresolvedConflicts: [] }, isLoading: false }));

    window.electronAPI.getSyncConflicts()
      .then((c: SyncConflict[]) => set({ conflicts: c }))
      .catch(() => {});

    const unsub1 = window.electronAPI.onSyncStatusChanged((s: SyncStatus) =>
      set({ status: s }),
    );
    const unsub2 = window.electronAPI.onSyncConflictDetected((c: SyncConflict) =>
      set((state) => ({ conflicts: [...state.conflicts, c] })),
    );

    return () => {
      unsub1();
      unsub2();
    };
  },

  refresh: async () => {
    const [status, conflicts] = await Promise.all([
      window.electronAPI.getSyncStatus(),
      window.electronAPI.getSyncConflicts(),
    ]);
    set({ status, conflicts });
  },
}));
