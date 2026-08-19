import { app, Notification, BrowserWindow, ipcMain, shell } from "electron";
import { join } from "path";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFile } from "child_process";
import { discardStaleShipItState } from "./shipit-cleanup";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string; filePath?: string }
  | { state: "error"; message: string }
  | { state: "not-available" }
  | { state: "store-managed" };

let updateStatus: UpdateStatus = { state: "idle" };

// ── Microsoft Store builds ──────────────────────────────────────────
// A Store build must not update itself. Store policy forbids an app fetching
// and installing executable code from outside the Store, and the Store's own
// update channel would be racing electron-updater for the same install anyway.
//
// Electron sets process.windowsStore only when the app is running from an
// appx/msix container, so it discriminates the Store build from the NSIS build
// off the identical codebase - there is no separate build flag to keep in sync,
// and it is false everywhere else at zero cost.
const isStoreBuild = process.windowsStore === true;

// Opens the Store's own "Downloads and updates" pane, which is where a Store
// user actually triggers an update check.
const STORE_UPDATES_URI = "ms-windows-store://downloadsandupdates";

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
    // No record yet - first launch
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
  ipcMain.handle("app:is-store-build", () => isStoreBuild);
  ipcMain.handle("updater:open-store", async () => {
    if (isStoreBuild) await shell.openExternal(STORE_UPDATES_URI);
  });

  // Store build: register the updater channels as no-ops and return before
  // electron-updater is ever imported, so no feed is contacted and nothing is
  // downloaded. The renderer reads "store-managed" and hides every update
  // control instead of showing dead buttons.
  if (isStoreBuild) {
    updateStatus = { state: "store-managed" };
    ipcMain.handle("updater:check", () => {});
    ipcMain.handle("updater:install", () => {});
    ipcMain.handle("updater:show-file", () => {});
    return;
  }

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
    //
    // Must be api.dosya.dev, NOT dosya.dev: the apex domain is the Astro
    // marketing site and serves no /api routes. This was previously pointed at
    // https://dosya.dev/api/desktop, which meant every update check fetched a
    // 404 for latest-*.yml and silently reported "no update available" - so
    // installed clients could never auto-update at all.
    autoUpdater.setFeedURL({
      provider: "generic",
      url: "https://api.dosya.dev/api/desktop",
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
      // isForceRunAfter MUST be true. quitAndInstall() defaults it to false,
      // which tells Squirrel `launchAfterInstallation: false` - the app quits,
      // ShipIt swaps the bundle, and nothing comes back. The user, who just
      // clicked "Restart to update", is left staring at a closed app and goes
      // and double-clicks the icon while ShipIt still has the bundle open.
      // macOS answers that with "dosya is damaged and can't be opened. You
      // should move it to the Bin", they bin it, and ShipIt then dies on ENOENT
      // (errSecCSStaticCodeNotFound) because its target just went to the Trash.
      // That is the whole 2.4.9 story, start to finish.
      autoUpdater.quitAndInstall(false, true);
    });

    // On Linux, also expose a dedicated handler to reveal the file
    ipcMain.handle("updater:show-file", () => {
      const st = updateStatus;
      if (st.state === "ready" && st.filePath) {
        shell.showItemInFolder(st.filePath);
      }
    });

    discardStaleShipItState({
      platform: process.platform,
      isPackaged: app.isPackaged,
      cachesDir: join(app.getPath("home"), "Library", "Caches"),
      uid: process.getuid?.() ?? null,
      // Fire-and-forget: a non-loaded job answers "Bad request", which is fine.
      bootoutJob: (target) => void execFile("launchctl", ["bootout", target], () => {}),
    });

    // Check for updates after a short delay to avoid blocking startup
    setTimeout(() => {
      autoUpdater.checkForUpdates().catch(() => {});
    }, 5_000);

    // Tray-resident machines stay up for weeks; a single check per process
    // lifetime left them on stale builds indefinitely.
    if (!isCrashLoop) {
      setInterval(() => {
        autoUpdater.checkForUpdates().catch(() => {});
      }, 4 * 60 * 60 * 1000);
    }
  } catch {
    // electron-updater not installed - register no-op handlers
    ipcMain.handle("updater:check", () => {});
    ipcMain.handle("updater:install", () => {});
    ipcMain.handle("updater:show-file", () => {});
  }
}
