import { app, Tray, Menu, nativeImage, shell, type BrowserWindow } from "electron";
import { join } from "path";
import { markQuitting } from "./quit-state";
import type { SyncEngine } from "./sync";
import type { SyncStatus } from "./sync/types";

let tray: Tray | null = null;

export function createTray(mainWindow: BrowserWindow, syncEngine?: SyncEngine): void {
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
      const syncing = pairs.filter((p) => p.status === "syncing").length;
      const errors = pairs.filter((p) => p.status === "error").length;
      const paused = pairs.filter((p) => p.status === "paused").length;
      const transferCount = syncStatus.activeTransfers.length;

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

      // Priority: global pause / all paused → paused; then real errors; then
      // active sync; then a partial pause; else everything is synced. Paused
      // pairs must never be summarized as an error.
      let summary: string;
      if (syncStatus.globalPaused || (paused > 0 && paused === pairs.length)) summary = "Paused";
      else if (errors > 0) summary = `${errors} error${errors > 1 ? "s" : ""}`;
      else if (syncing > 0 || transferCount > 0)
        summary = `Syncing ${transferCount} file${transferCount !== 1 ? "s" : ""}…`;
      else if (paused > 0) summary = `${paused} paused`;
      else summary = "All synced";

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
        click: () => {
          mainWindow.show();
          mainWindow.focus();
        },
      },
      { type: "separator" },
      ...syncItems,
      {
        label: "Upload File...",
        click: () => {
          mainWindow.show();
          mainWindow.webContents.send("navigate", "/upload");
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

    // Update tooltip
    if (syncStatus) {
      const syncing = syncStatus.activeTransfers.length;
      tray?.setToolTip(syncing > 0 ? `dosya - Syncing ${syncing} file${syncing !== 1 ? "s" : ""}...` : "dosya - All synced");
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

  const showWindow = () => {
    mainWindow.show();
    mainWindow.focus();
  };

  tray.on("click", showWindow);
  // Windows users expect double-click on a tray icon to open the app; without
  // this the gesture did nothing there. Harmless elsewhere - macOS and Linux
  // fire "click" and this simply never arrives.
  tray.on("double-click", showWindow);
}
