import { app, Tray, Menu, nativeImage, shell } from "electron";
import { join } from "path";
import { markQuitting } from "./quit-state";
import { summarizeSyncStatus } from "./sync-status-summary";
import type { SyncEngineHandle } from "./sync/engine-host";
import type { SyncStatus } from "./sync/types";

/**
 * The tray outlives every window generation: with memory reclaim, the hidden
 * window is destroyed and recreated on demand, so the tray takes accessors
 * (which recreate the window when needed) instead of a BrowserWindow
 * reference that would go stale after the first reclaim.
 */
export interface TrayWindowHandles {
  /** Show the main window, recreating it if it was destroyed. */
  showWindow: () => void;
  /** Send to the renderer, queued until it finishes loading if just recreated. */
  sendToWindow: (channel: string, ...args: unknown[]) => void;
}

let tray: Tray | null = null;

export function createTray(win: TrayWindowHandles, syncEngine?: SyncEngineHandle): void {
  // Load tray icon from build resources
  const trayIconPath = join(__dirname, "../../build/tray-icon.png");
  let icon: Electron.NativeImage;
  try {
    icon = nativeImage.createFromPath(trayIconPath);
    // On macOS, mark as template so it adapts to dark/light menu bar
    if (process.platform === "darwin") {
      icon = icon.resize({ width: 16, height: 16 });
      icon.setTemplateImage(true);
    }
  } catch {
    icon = nativeImage.createEmpty();
  }
  tray = new Tray(icon);
  tray.setToolTip("dosya");

  function buildMenu(syncStatus?: SyncStatus) {
    const syncItems: Electron.MenuItemConstructorOptions[] = [];

    if (syncStatus && syncStatus.pairs.length > 0) {
      // Summary line
      const pairs = syncStatus.pairs;

      // Icon + human label for a single pair. A paused folder is a deliberate
      // stop, not a failure - it reads "Paused", never as an error.
      const stateLabel = (status: string): { icon: string; text: string } => {
        switch (status) {
          case "idle": return { icon: "✓", text: "Synced" };
          case "syncing": return { icon: "⟳", text: "Syncing…" };
          case "paused": return { icon: "⏸", text: "Paused" };
          case "error": return { icon: "⚠", text: "Error" };
          case "rate-limited": return { icon: "⏳", text: "Waiting" };
          case "offline": return { icon: "⚠", text: "Offline" };
          default: return { icon: "•", text: "" };
        }
      };

      const summary = summarizeSyncStatus(syncStatus);

      syncItems.push({ label: `Sync: ${summary}`, enabled: false });

      // Per-pair status
      for (const pair of pairs) {
        const { icon, text } = stateLabel(pair.status);
        syncItems.push({
          label: `  ${icon} ${pair.workspaceName}/${pair.remoteFolderName}${text ? ` - ${text}` : ""}`,
          enabled: false,
        });
      }

      syncItems.push({ type: "separator" });

      // Pause / Resume
      if (syncStatus.globalPaused) {
        syncItems.push({
          label: "Resume Sync",
          click: () => syncEngine?.resumeAll(),
        });
      } else {
        syncItems.push({
          label: "Pause Sync",
          click: () => syncEngine?.pauseAll(),
        });
      }

      // Sync All Now
      syncItems.push({
        label: "Sync All Now",
        click: () => {
          for (const pair of syncStatus.pairs) {
            syncEngine?.syncNow(pair.pairId);
          }
        },
      });

      syncItems.push({ type: "separator" });

      // Open sync folders
      if (syncStatus.pairs.length === 1) {
        syncItems.push({
          label: "Open Sync Folder",
          click: () => shell.openPath(syncStatus.pairs[0].localPath),
        });
      } else {
        syncItems.push({
          label: "Open Sync Folder",
          submenu: syncStatus.pairs.map((p) => ({
            label: p.remoteFolderName,
            click: () => shell.openPath(p.localPath),
          })),
        });
      }

      syncItems.push({ type: "separator" });
    }

    const menu = Menu.buildFromTemplate([
      {
        label: "Open dosya",
        click: () => win.showWindow(),
      },
      { type: "separator" },
      ...syncItems,
      {
        label: "Upload File...",
        click: () => {
          win.showWindow();
          win.sendToWindow("navigate", "/upload");
        },
      },
      { type: "separator" },
      {
        label: "Quit dosya",
        click: () => {
          markQuitting();
          app.quit();
        },
      },
    ]);

    tray?.setContextMenu(menu);

    // Update tooltip. Uses the same priority logic as the menu's summary line
    // so a pair sitting in "error" can never be reported here as "All synced"
    // just because nothing is actively transferring.
    if (syncStatus) {
      tray?.setToolTip(`dosya - ${summarizeSyncStatus(syncStatus)}`);
    }
  }

  // Initial menu
  buildMenu();

  // Rebuild on sync status changes, throttled rather than debounced. A trailing
  // debounce reset its timer on every event, so during a large sync - exactly
  // when status changes most and the user is most likely to look - the menu
  // could go indefinitely without a rebuild. A throttle rebuilds at most once
  // per window but is guaranteed to land.
  if (syncEngine) {
    const MENU_THROTTLE_MS = 1000;
    let lastBuild = 0;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;
    let latestStatus: SyncStatus | undefined;

    syncEngine.on("status-changed", (status: SyncStatus) => {
      latestStatus = status;
      const since = Date.now() - lastBuild;
      if (since >= MENU_THROTTLE_MS) {
        lastBuild = Date.now();
        buildMenu(latestStatus);
        return;
      }
      if (trailingTimer) return; // one already scheduled; it will use latestStatus
      trailingTimer = setTimeout(() => {
        trailingTimer = null;
        lastBuild = Date.now();
        buildMenu(latestStatus);
      }, MENU_THROTTLE_MS - since);
    });
  }

  tray.on("click", win.showWindow);
  // Windows users expect double-click on a tray icon to open the app; without
  // this the gesture did nothing there. Harmless elsewhere - macOS and Linux
  // fire "click" and this simply never arrives.
  tray.on("double-click", win.showWindow);
}
