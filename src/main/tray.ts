import { app, Tray, Menu, nativeImage, shell } from "electron";
import { join } from "path";
import { markQuitting } from "./quit-state";
import { summarizeSyncStatus } from "./sync-status-summary";
import { currentDir, onMainLocaleChange, tMain as t } from "./i18n";
import { trayFolderName, trayPairLabel } from "./tray-labels";
import { mayShowDefaultName, pairFolderLabel, rootPairIds } from "./sync-pair-label";
import { loadConfig } from "./sync/config";
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
  // macOS gets the black template image (alpha only, the menu bar tints it);
  // Windows and Linux draw the icon as-is, so they get the graphite plate.
  const trayIconPath = join(
    __dirname,
    process.platform === "darwin" ? "../../build/tray-icon.png" : "../../build/tray-icon-color.png",
  );
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

  // Pairs on a workspace root, from the pair config (the status does not say),
  // so their stored default name "Root" shows in the chosen language. Read
  // only when a pair carries that name, and again when the pair set changes.
  let rootIds = new Set<string>();
  let rootIdsFor = "";
  const refreshRootIds = (status: SyncStatus): void => {
    const candidates = status.pairs.filter(mayShowDefaultName).map((p) => p.pairId).sort().join("\n");
    if (candidates === rootIdsFor) return;
    rootIdsFor = candidates;
    if (!candidates) {
      rootIds = new Set();
      return;
    }
    loadConfig()
      .then((cfg) => {
        if (rootIdsFor !== candidates) return;
        rootIds = rootPairIds(cfg.pairs);
        buildMenu(latestStatus);
      })
      .catch(() => {
        // Unreadable config: the names stay as stored.
      });
  };
  const folderLabel = (p: { pairId: string; remoteFolderName: string }): string =>
    pairFolderLabel(p.remoteFolderName, rootIds.has(p.pairId), t);

  function buildMenu(syncStatus?: SyncStatus) {
    const syncItems: Electron.MenuItemConstructorOptions[] = [];

    if (syncStatus && syncStatus.pairs.length > 0) {
      // Summary line
      const pairs = syncStatus.pairs;

      // Icon + human label for a single pair. A paused folder is a deliberate
      // stop, not a failure - it reads "Paused", never as an error.
      const stateLabel = (status: string): { icon: string; text: string } => {
        switch (status) {
          case "idle": return { icon: "✓", text: t("common.status.synced") };
          case "syncing": return { icon: "⟳", text: t("common.status.syncing") };
          case "paused": return { icon: "⏸", text: t("common.status.paused") };
          case "error": return { icon: "⚠", text: t("common.status.error") };
          case "rate-limited": return { icon: "⏳", text: t("common.status.waiting") };
          case "offline": return { icon: "⚠", text: t("common.status.offline") };
          case "needs-confirmation": return { icon: "⚠", text: t("common.status.needsAttention") };
          // Mac App Store builds only: macOS revoked the sandbox grant for
          // this folder. Same icon family as "needs attention" - it is
          // waiting on the user, not a transient error - but its own label
          // so "Reselect" (added with the rest of the reselect UI) reads as
          // the obvious next step rather than a vague "attention".
          case "needs-permission": return { icon: "⚠", text: t("common.status.needsPermission") };
          default: return { icon: "•", text: "" };
        }
      };

      const summary = summarizeSyncStatus(syncStatus, t);

      syncItems.push({ label: t("tray.label.syncSummary", { summary }), enabled: false });

      // A platform switch paused this surface - show the team's message
      // (rt.errorMessage, set by SyncEngine.setMaintenance) if there is one,
      // right under the summary line.
      if (syncStatus.maintenance) {
        const pairMessage = syncStatus.pairs
          .map((p) => p.errorMessage)
          .find((m): m is string => !!m?.startsWith("Paused for maintenance:"));
        if (pairMessage) {
          syncItems.push({
            label: `  ${pairMessage.replace(/^Paused for maintenance:\s*/, "")}`,
            enabled: false,
          });
        }
      }

      // Per-pair status
      for (const pair of pairs) {
        const { icon, text } = stateLabel(pair.status);
        syncItems.push({
          label: trayPairLabel(icon, pair.workspaceName, folderLabel(pair), text, currentDir()),
          enabled: false,
        });
      }

      syncItems.push({ type: "separator" });

      // Pause / Resume
      if (syncStatus.globalPaused) {
        syncItems.push({
          label: t("common.action.resumeSync"),
          click: () => syncEngine?.resumeAll(),
        });
      } else {
        syncItems.push({
          label: t("common.action.pauseSync"),
          click: () => syncEngine?.pauseAll(),
        });
      }

      // Sync All Now
      syncItems.push({
        label: t("common.action.syncAllNow"),
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
          label: t("common.action.openSyncFolder"),
          click: () => shell.openPath(syncStatus.pairs[0].localPath),
        });
      } else {
        syncItems.push({
          label: t("common.action.openSyncFolder"),
          submenu: syncStatus.pairs.map((p) => ({
            label: trayFolderName(folderLabel(p), currentDir()),
            click: () => shell.openPath(p.localPath),
          })),
        });
      }

      syncItems.push({ type: "separator" });
    }

    const menu = Menu.buildFromTemplate([
      {
        label: t("tray.action.openDosya"),
        click: () => win.showWindow(),
      },
      { type: "separator" },
      ...syncItems,
      {
        label: t("tray.action.uploadFile"),
        click: () => {
          win.showWindow();
          win.sendToWindow("navigate", "/upload");
        },
      },
      { type: "separator" },
      {
        label: t("tray.action.quitDosya"),
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
      tray?.setToolTip(t("tray.label.dosyaSummary", { summary: summarizeSyncStatus(syncStatus, t) }));
    }
  }

  // The last status the menu was built from, so a language change can
  // rebuild the same menu in the new language.
  let latestStatus: SyncStatus | undefined;

  // Initial menu
  buildMenu();
  onMainLocaleChange(() => buildMenu(latestStatus));

  // Rebuild on sync status changes, throttled rather than debounced. A trailing
  // debounce reset its timer on every event, so during a large sync - exactly
  // when status changes most and the user is most likely to look - the menu
  // could go indefinitely without a rebuild. A throttle rebuilds at most once
  // per window but is guaranteed to land.
  if (syncEngine) {
    const MENU_THROTTLE_MS = 1000;
    let lastBuild = 0;
    let trailingTimer: ReturnType<typeof setTimeout> | null = null;

    syncEngine.on("status-changed", (status: SyncStatus) => {
      latestStatus = status;
      refreshRootIds(status);
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
