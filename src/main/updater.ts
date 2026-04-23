import { app, Notification, BrowserWindow, ipcMain, shell } from "electron";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string; filePath?: string }
  | { state: "error"; message: string }
  | { state: "not-available" };

let updateStatus: UpdateStatus = { state: "idle" };

function broadcastStatus(status: UpdateStatus): void {
  updateStatus = status;
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("updater:status-changed", status);
    }
  }
}

/**
 * Initialize auto-updater and register IPC handlers.
 * Downloads updates in the background and lets the renderer
 * check status, trigger checks, and install updates.
 */
export async function initAutoUpdater(): Promise<void> {
  // Always register IPC so the renderer doesn't error in dev mode
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("updater:get-status", () => updateStatus);

  if (!app.isPackaged) {
    // In dev, simulate check so the UI gives feedback
    ipcMain.handle("updater:check", () => {
      broadcastStatus({ state: "checking" });
      setTimeout(() => broadcastStatus({ state: "not-available" }), 1_500);
    });
    ipcMain.handle("updater:install", () => {});
    ipcMain.handle("updater:show-file", () => {});
    return;
  }

  try {
    const { autoUpdater } = await import("electron-updater");

    // Use dosya.dev's own update feed instead of GitHub Releases.
    // Builds are uploaded to R2 and served via /api/desktop/latest.
    autoUpdater.setFeedURL({
      provider: "generic",
      url: "https://dosya.dev/api/desktop",
    });

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("checking-for-update", () => {
      broadcastStatus({ state: "checking" });
    });

    autoUpdater.on("update-available", (info: any) => {
      console.log("[updater] Update available:", info.version);
      broadcastStatus({ state: "downloading", percent: 0 });
    });

    autoUpdater.on("update-not-available", () => {
      broadcastStatus({ state: "not-available" });
    });

    autoUpdater.on("download-progress", (progress: any) => {
      broadcastStatus({ state: "downloading", percent: Math.round(progress.percent) });
    });

    autoUpdater.on("update-downloaded", (info: any) => {
      const filePath: string | undefined = info.downloadedFile;
      broadcastStatus({ state: "ready", version: info.version, filePath });

      const isLinux = process.platform === "linux";
      new Notification({
        title: "Update Ready",
        body: isLinux
          ? `dosya ${info.version} has been downloaded. Open the file to install.`
          : `dosya ${info.version} is ready to install. Restart to update.`,
      }).show();
    });

    autoUpdater.on("error", (err: Error) => {
      console.error("[updater] Error:", err.message);
      broadcastStatus({ state: "error", message: err.message });
    });

    ipcMain.handle("updater:check", async () => {
      broadcastStatus({ state: "checking" });
      try {
        await autoUpdater.checkForUpdates();
      } catch (err: any) {
        broadcastStatus({ state: "error", message: err.message ?? "Check failed" });
      }
    });

    ipcMain.handle("updater:install", () => {
      if (process.platform === "linux") {
        // On Linux, quitAndInstall() is unreliable for AppImage.
        // Show the downloaded file so the user can install manually.
        const st = updateStatus;
        if (st.state === "ready" && st.filePath) {
          shell.showItemInFolder(st.filePath);
        }
        return;
      }
      autoUpdater.quitAndInstall();
    });

    // On Linux, also expose a dedicated handler to reveal the file
    ipcMain.handle("updater:show-file", () => {
      const st = updateStatus;
      if (st.state === "ready" && st.filePath) {
        shell.showItemInFolder(st.filePath);
      }
    });

    // Check for updates after a short delay to avoid blocking startup
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 5_000);
  } catch {
    // electron-updater not installed — register no-op handlers
    ipcMain.handle("updater:check", () => {});
    ipcMain.handle("updater:install", () => {});
    ipcMain.handle("updater:show-file", () => {});
  }
}
