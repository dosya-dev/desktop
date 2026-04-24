import { app, Notification, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";

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

// ── Crash-loop detection ────────────────────────────────────────────
// If the app crashes within CRASH_WINDOW_MS of launch for MAX_CRASHES
// consecutive times, disable auto-install to prevent infinite crash loops
// after a bad update.

const CRASH_WINDOW_MS = 30_000;
const MAX_CRASHES = 3;

interface LaunchRecord {
  version: string;
  timestamps: number[];
}

function getLaunchRecordPath(): string {
  return join(app.getPath("userData"), "launch-record.json");
}

function checkCrashLoop(): boolean {
  const recordPath = getLaunchRecordPath();
  const now = Date.now();
  const currentVersion = app.getVersion();

  let record: LaunchRecord = { version: currentVersion, timestamps: [] };
  try {
    const raw = readFileSync(recordPath, "utf-8");
    record = JSON.parse(raw);
  } catch {
    // No record yet — first launch
  }

  // Reset if version changed (new update installed successfully)
  if (record.version !== currentVersion) {
    record = { version: currentVersion, timestamps: [] };
  }

  // Remove old timestamps outside the crash window
  record.timestamps = record.timestamps.filter((t) => now - t < CRASH_WINDOW_MS);

  // Check if we're in a crash loop
  const inCrashLoop = record.timestamps.length >= MAX_CRASHES;

  // Record this launch
  record.timestamps.push(now);

  try {
    mkdirSync(app.getPath("userData"), { recursive: true });
    writeFileSync(recordPath, JSON.stringify(record));
  } catch {}

  if (inCrashLoop) {
    console.warn(
      `[updater] Crash loop detected: ${record.timestamps.length} crashes within ${CRASH_WINDOW_MS / 1000}s. ` +
      `Auto-update install disabled to prevent infinite restart loop.`,
    );
  }

  return inCrashLoop;
}

/** Mark the current launch as successful (called after app has been running stably). */
function markStableLaunch(): void {
  const recordPath = getLaunchRecordPath();
  try {
    writeFileSync(recordPath, JSON.stringify({ version: app.getVersion(), timestamps: [] }));
  } catch {}
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

  // Check for crash loop before enabling auto-install
  const isCrashLoop = checkCrashLoop();

  // After 60s of stable running, clear the crash counter
  setTimeout(() => markStableLaunch(), 60_000);

  try {
    const { autoUpdater } = await import("electron-updater");

    // Use dosya.dev's own update feed instead of GitHub Releases.
    // Builds are uploaded to R2 and served via /api/desktop/latest.
    autoUpdater.setFeedURL({
      provider: "generic",
      url: "https://dosya.dev/api/desktop",
    });

    autoUpdater.autoDownload = !isCrashLoop;
    autoUpdater.autoInstallOnAppQuit = !isCrashLoop;

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
        title: isLinux ? "Update Downloaded" : "Update Ready",
        body: isLinux
          ? `dosya ${info.version} has been downloaded. Replace the current AppImage to install.`
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
