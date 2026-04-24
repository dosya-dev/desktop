import { app, Tray, Menu, nativeImage, shell, type BrowserWindow } from "electron";
import { join } from "path";
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
      const syncing = syncStatus.pairs.filter((p) => p.status === "syncing").length;
      const errors = syncStatus.pairs.filter((p) => p.status === "error").length;
      const transferCount = syncStatus.activeTransfers.length;

      let summary = "All synced";
      if (syncStatus.globalPaused) summary = "Paused";
      else if (errors > 0) summary = `${errors} error${errors > 1 ? "s" : ""}`;
      else if (syncing > 0 || transferCount > 0)
        summary = `Syncing ${transferCount} file${transferCount !== 1 ? "s" : ""}...`;

      syncItems.push({ label: `Sync: ${summary}`, enabled: false });

      // Per-pair status
      for (const pair of syncStatus.pairs) {
        const statusIcon =
          pair.status === "idle" ? "✓" :
          pair.status === "syncing" ? "⟳" :
          pair.status === "error" ? "⚠" :
          pair.status === "paused" ? "⏸" : "?";

        syncItems.push({
          label: `  ${statusIcon} ${pair.workspaceName}/${pair.remoteFolderName}`,
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
          (app as any).isQuitting = true;
          app.quit();
        },
      },
    ]);

    tray?.setContextMenu(menu);

    // Update tooltip
    if (syncStatus) {
      const syncing = syncStatus.activeTransfers.length;
      tray?.setToolTip(syncing > 0 ? `dosya — Syncing ${syncing} file${syncing !== 1 ? "s" : ""}...` : "dosya — All synced");
    }
  }

  // Initial menu
  buildMenu();

  // Rebuild on sync status changes (debounced to avoid excessive menu rebuilds
  // during large syncs where status fires many times per minute)
  if (syncEngine) {
    let menuDebounceTimer: ReturnType<typeof setTimeout> | null = null;
    syncEngine.on("status-changed", (status: SyncStatus) => {
      if (menuDebounceTimer) clearTimeout(menuDebounceTimer);
      menuDebounceTimer = setTimeout(() => {
        menuDebounceTimer = null;
        buildMenu(status);
      }, 2000);
    });
  }

  tray.on("click", () => {
    mainWindow.show();
    mainWindow.focus();
  });
}
