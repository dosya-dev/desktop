import { contextBridge, ipcRenderer } from "electron";

/** Typed API exposed to the renderer via window.electronAPI */
const electronAPI = {
  // Platform
  getPlatform: (): Promise<NodeJS.Platform> =>
    ipcRenderer.invoke("app:get-platform"),

  // Window controls
  minimize: (): void => ipcRenderer.send("app:minimize"),
  maximize: (): void => ipcRenderer.send("app:maximize"),
  close: (): void => ipcRenderer.send("app:close"),

  // Auth
  getApiBase: (): Promise<string> => ipcRenderer.invoke("auth:get-api-base"),
  clearSession: (): Promise<void> => ipcRenderer.invoke("auth:clear-session"),
  waitForSession: (): Promise<void> => ipcRenderer.invoke("auth:wait-for-session"),
  oauth: (provider: string): Promise<{ ok: boolean; redirectedTo?: string; error?: string }> =>
    ipcRenderer.invoke("auth:oauth", provider),

  // File system
  openFileDialog: (
    options?: Electron.OpenDialogOptions,
  ): Promise<Electron.OpenDialogReturnValue> =>
    ipcRenderer.invoke("fs:open-file-dialog", options),

  saveFileDialog: (
    options?: Electron.SaveDialogOptions,
  ): Promise<Electron.SaveDialogReturnValue> =>
    ipcRenderer.invoke("fs:save-file-dialog", options),

  openFile: (fileId: string, fileName: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("file:open", { fileId, fileName }),

  // Notifications
  showNotification: (opts: { title: string; body: string }): void =>
    ipcRenderer.send("notification:show", opts),

  // Updater
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:get-version"),
  getUpdateStatus: (): Promise<any> => ipcRenderer.invoke("updater:get-status"),
  checkForUpdates: (): Promise<void> => ipcRenderer.invoke("updater:check"),
  installUpdate: (): Promise<void> => ipcRenderer.invoke("updater:install"),
  showUpdateFile: (): Promise<void> => ipcRenderer.invoke("updater:show-file"),
  onUpdateStatusChanged: (cb: (status: any) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) => cb(status);
    ipcRenderer.on("updater:status-changed", handler);
    return () => ipcRenderer.removeListener("updater:status-changed", handler);
  },

  // Navigation events from main process (e.g., tray menu -> navigate)
  onNavigate: (callback: (path: string) => void): (() => void) => {
    const handler = (_event: Electron.IpcRendererEvent, path: string) =>
      callback(path);
    ipcRenderer.on("navigate", handler);
    return () => ipcRenderer.removeListener("navigate", handler);
  },

  // OAuth complete event — fired when dosya://auth/callback is handled
  onOAuthComplete: (callback: () => void): (() => void) => {
    const handler = () => callback();
    ipcRenderer.on("auth:oauth-complete", handler);
    return () => ipcRenderer.removeListener("auth:oauth-complete", handler);
  },

  // ── Sync ──────────────────────────────────────────────────────
  getSyncConfig: () => ipcRenderer.invoke("sync:get-config"),
  saveSyncConfig: (updates: any) => ipcRenderer.invoke("sync:save-config", updates),
  getSyncStatus: () => ipcRenderer.invoke("sync:get-status"),
  addSyncPair: (opts: any) => ipcRenderer.invoke("sync:add-pair", opts),
  removeSyncPair: (pairId: string) => ipcRenderer.invoke("sync:remove-pair", { pairId }),
  updateSyncPair: (pairId: string, updates: any) => ipcRenderer.invoke("sync:update-pair", { pairId, updates }),
  pickLocalFolder: (): Promise<string | null> => ipcRenderer.invoke("sync:pick-local-folder"),
  getSyncFolderTree: (workspaceId: string) => ipcRenderer.invoke("sync:get-folder-tree", { workspaceId }),
  pauseSyncPair: (pairId: string) => ipcRenderer.invoke("sync:pause-pair", { pairId }),
  resumeSyncPair: (pairId: string) => ipcRenderer.invoke("sync:resume-pair", { pairId }),
  pauseAllSync: () => ipcRenderer.invoke("sync:pause-all"),
  resumeAllSync: () => ipcRenderer.invoke("sync:resume-all"),
  syncNow: (pairId: string) => ipcRenderer.invoke("sync:sync-now", { pairId }),
  resolveConflict: (conflictId: string, resolution: string) => ipcRenderer.invoke("sync:resolve-conflict", { conflictId, resolution }),
  openSyncFolder: (pairId: string) => ipcRenderer.invoke("sync:open-sync-folder", { pairId }),
  getSyncConflicts: () => ipcRenderer.invoke("sync:get-conflicts"),
  onSyncStatusChanged: (cb: (status: any) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, status: any) => cb(status);
    ipcRenderer.on("sync:status-changed", handler);
    return () => ipcRenderer.removeListener("sync:status-changed", handler);
  },
  onSyncConflictDetected: (cb: (conflict: any) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, conflict: any) => cb(conflict);
    ipcRenderer.on("sync:conflict-detected", handler);
    return () => ipcRenderer.removeListener("sync:conflict-detected", handler);
  },
  onSyncError: (cb: (err: { pairId: string; message: string }) => void): (() => void) => {
    const handler = (_e: Electron.IpcRendererEvent, err: { pairId: string; message: string }) => cb(err);
    ipcRenderer.on("sync:error", handler);
    return () => ipcRenderer.removeListener("sync:error", handler);
  },
};

contextBridge.exposeInMainWorld("electronAPI", electronAPI);

export type ElectronAPI = typeof electronAPI;
