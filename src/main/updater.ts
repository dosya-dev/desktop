import { app, Notification, BrowserWindow, shell, autoUpdater as nativeUpdater } from "electron";
import { join } from "path";
import type { IpcGate } from "./ipc-sender";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { execFile } from "child_process";
import { discardStaleShipItState } from "./shipit-cleanup";
import { armQuitWatchdog, installDownloadedUpdate, type QuitWatchdog } from "./update-install";
import { markQuitting } from "./quit-state";
import { currentDistribution, isStoreManaged, storeUpdatesUrl, type Distribution } from "./distribution";

export type UpdateStatus =
  | { state: "idle" }
  | { state: "checking" }
  | { state: "available"; version: string }
  | { state: "downloading"; percent: number }
  | { state: "ready"; version: string; filePath?: string }
  /** The quit for the install has begun; the app reopens on its own. */
  | { state: "installing"; version: string }
  | { state: "error"; message: string }
  | { state: "not-available" }
  | { state: "store-managed" };

let updateStatus: UpdateStatus = { state: "idle" };

/** Main-process subscribers (the application menu re-labels its update item). */
const statusListeners = new Set<(status: UpdateStatus) => void>();
export function onUpdateStatus(cb: (status: UpdateStatus) => void): () => void {
  statusListeners.add(cb);
  return () => { statusListeners.delete(cb); };
}
export function getUpdateStatus(): UpdateStatus {
  return updateStatus;
}

// The menu and the renderer's Settings card trigger the same two operations;
// both go through these so neither can drift from the IPC handlers. Replaced
// once initAutoUpdater decides which build this is.
let checkNow: () => Promise<void> = async () => {};
let installNow: () => void = () => {};
/** Help/app menu "Check for Updates…". No-op on a store build. */
export function checkForUpdatesNow(): Promise<void> { return checkNow(); }
/** "Restart to Update…" once a download is ready. */
export function installUpdateNow(): void { installNow(); }
/** "Open <Store>…" on a store build; nothing on a direct build. */
export async function openStoreUpdates(): Promise<void> {
  const url = storeUpdatesUrl(distribution);
  if (url) await shell.openExternal(url);
}

// ── Store builds ────────────────────────────────────────────────────
// A store install must not update itself. Every store's policy forbids an app
// fetching and installing executable code from outside the store, and the
// store's own update channel would be racing electron-updater for the same
// install anyway. Which store (if any) is read off platform signals at
// runtime - see distribution.ts - so the identical build tree serves the
// direct download, the Microsoft Store and the Snap Store with no build flag
// to keep in sync.
const distribution: Distribution = currentDistribution();
const isStoreBuild = isStoreManaged(distribution);

function broadcastStatus(status: UpdateStatus): void {
  updateStatus = status;
  for (const cb of statusListeners) {
    try { cb(status); } catch (err) { console.error("[updater] status listener failed:", err); }
  }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send("updater:status-changed", status);
    }
  }
}

// ── Install in progress ─────────────────────────────────────────────
// Electron's quitAndInstall() finishes only once every window has closed, and
// the app is silent until it relaunches. The renderer is told the install has
// begun so it can say so, and a watchdog destroys any window still open after
// QUIT_WATCHDOG_MS - the backstop for a close handler that hides instead of
// closing (3.1.2), which otherwise stalls the install until the memory
// reclaimer tears the window down five minutes later.
const QUIT_WATCHDOG_MS = 15_000;
let quitWatchdog: QuitWatchdog | null = null;

function announceInstalling(): void {
  if (updateStatus.state === "installing") return;
  const version = updateStatus.state === "ready" ? updateStatus.version : app.getVersion();
  broadcastStatus({ state: "installing", version });
}

/** The quit for the install is under way - from any door into quitAndInstall. */
function onQuitForUpdate(): void {
  announceInstalling();
  if (quitWatchdog) {
    quitWatchdog.rearm();
    return;
  }
  quitWatchdog = armQuitWatchdog({
    timeoutMs: QUIT_WATCHDOG_MS,
    hasWindows: () => BrowserWindow.getAllWindows().some((w) => !w.isDestroyed()),
    destroyWindows: () => {
      console.warn("[updater] windows still open after quitAndInstall - destroying them so the install can proceed");
      for (const w of BrowserWindow.getAllWindows()) {
        if (!w.isDestroyed()) w.destroy();
      }
    },
  });
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
 *
 * `gate` is the sender-validating wrapper around ipcMain (see ipc-sender.ts):
 * every channel below refuses a message that did not come from the app's own
 * top-level renderer (S-1). It is passed in rather than built here on purpose
 * - the allowed-origin expression must exist in exactly one place, and the
 * caller in index.ts's whenReady already has a gate for its own channels.
 *
 * Only one branch below ever runs - store build, dev, electron-updater
 * missing, or the real updater - and each returns after registering its set,
 * so the 17 call sites are 8 channels registered once per process.
 */
export async function initAutoUpdater(gate: IpcGate): Promise<void> {
  // Always register IPC so the renderer doesn't error in dev mode
  gate.handle("app:get-version", () => app.getVersion());
  gate.handle("updater:get-status", () => updateStatus);
  gate.handle("app:is-store-build", () => isStoreBuild);
  gate.handle("app:get-distribution", () => distribution);
  gate.handle("updater:open-store", () => openStoreUpdates());

  // Store build: register the updater channels as no-ops and return before
  // electron-updater is ever imported, so no feed is contacted and nothing is
  // downloaded. The renderer reads "store-managed" and hides every update
  // control instead of showing dead buttons.
  if (isStoreBuild) {
    updateStatus = { state: "store-managed" };
    gate.handle("updater:check", () => {});
    gate.handle("updater:install", () => {});
    gate.handle("updater:show-file", () => {});
    return;
  }

  if (!app.isPackaged) {
    // In dev, simulate check so the UI gives feedback
    checkNow = async () => {
      broadcastStatus({ state: "checking" });
      setTimeout(() => broadcastStatus({ state: "not-available" }), 1_500);
    };
    gate.handle("updater:check", () => checkNow());
    gate.handle("updater:install", () => {});
    gate.handle("updater:show-file", () => {});
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

    // Electron's quitAndInstall() closes every window before before-quit
    // fires, and the window close handler hides to the tray unless a quit is
    // marked. electron-updater reaches the native quitAndInstall() on its own
    // too, so mark the quit on the native event as well as in installNow.
    if (process.platform === "darwin" || process.platform === "win32") {
      nativeUpdater.on("before-quit-for-update", markQuitting);
      // Electron emits this on macOS from its own quitAndInstall();
      // electron-updater's BaseUpdater emits it on the same native emitter on
      // Windows, just before app.quit(). Either way the quit for the install
      // is now under way.
      nativeUpdater.on("before-quit-for-update", onQuitForUpdate);
    }

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

    checkNow = async () => {
      broadcastStatus({ state: "checking" });
      try {
        await autoUpdater.checkForUpdates();
      } catch (err: any) {
        broadcastStatus({ state: "error", message: err.message ?? "Check failed" });
      }
    };
    gate.handle("updater:check", () => checkNow());

    installNow = () =>
      installDownloadedUpdate(process.platform, {
        announceInstalling,
        markQuitting,
        // isForceRunAfter MUST be true on Windows: false leaves the app closed
        // after the installer runs, the user double-clicks it mid-install, and
        // the install breaks (the 2.4.9 story). On macOS electron-updater
        // ignores both arguments and relaunches per autoRunAppAfterInstall
        // (default true) - which only ever happened once the window could
        // actually close, see installDownloadedUpdate.
        quitAndInstall: () => autoUpdater.quitAndInstall(false, true),
        showDownloadedFile: () => {
          const st = updateStatus;
          if (st.state === "ready" && st.filePath) shell.showItemInFolder(st.filePath);
        },
      });
    gate.handle("updater:install", () => installNow());

    // On Linux, also expose a dedicated handler to reveal the file
    gate.handle("updater:show-file", () => {
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
    gate.handle("updater:check", () => {});
    gate.handle("updater:install", () => {});
    gate.handle("updater:show-file", () => {});
  }
}
