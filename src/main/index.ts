// Patch fs to handle EMFILE (too many open files) gracefully.
// Must run before anything touches fs. Uses require() to avoid missing type declarations.
// eslint-disable-next-line @typescript-eslint/no-var-requires
(require("graceful-fs") as { gracefulify: (fs: any) => void }).gracefulify(require("fs"));

import { app, BrowserWindow, shell, powerMonitor, session } from "electron";
import { join } from "path";
import { registerIpcHandlers } from "./ipc";
import { setupSession } from "./session";
import { createMenu } from "./menu";
import { createTray } from "./tray";
import { SyncEngine } from "./sync";
import { registerSyncIpcHandlers } from "./sync/ipc-handlers";
import { initAutoUpdater } from "./updater";
import { installQuickAction } from "./macos-services";

// ── Global crash handlers ───────────────────────────────────────────
process.on("uncaughtException", (err) => {
  console.error("[crash] Uncaught exception:", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[crash] Unhandled rejection:", reason);
});

const API_BASE = process.env.API_BASE || (app.isPackaged ? "https://dosya.dev" : "http://localhost:4321");

let mainWindow: BrowserWindow | null = null;

// ── dosya:// URL handler ───────────────────────────────────────────
// Handles URLs like dosya://sync?path=/Users/john/Documents
// Triggered by the macOS Quick Action or protocol links.
let pendingSyncPath: string | null = null;

function handleDosyaUrl(url: string): void {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "sync" || parsed.pathname === "//sync") {
      const folderPath = parsed.searchParams.get("path");
      if (!folderPath) return;

      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
        mainWindow.webContents.send("navigate", `/sync?localPath=${encodeURIComponent(folderPath)}`);
      } else {
        // Window not ready yet — store for later
        pendingSyncPath = folderPath;
      }
    }
  } catch {}
}

// Register open-url early so cold-start URLs are captured
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDosyaUrl(url);
});

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    show: false,
    icon: join(__dirname, "../../build/icon.png"),
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "hidden",
    trafficLightPosition: { x: 16, y: 16 },
    ...(process.platform === "darwin" ? { vibrancy: "sidebar" } : {}),
    ...(process.platform === "win32"
      ? {
          titleBarOverlay: {
            color: "#f9f8f6",
            symbolColor: "#1a1917",
            height: 52,
          },
        }
      : {}),
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      // webSecurity is off so the renderer (file:// or localhost:5174) can
      // make credentialed cross-origin requests to the API without CORS
      // preflight failures. The actual attack surface this opens (navigation
      // to a malicious page that abuses the bridge) is locked down by:
      //   - will-navigate handler (blocks navigation to external URLs)
      //   - setWindowOpenHandler (only allows http/https opens)
      //   - CSP in production (restricts script/connect sources)
      webSecurity: false,
    },
  });

  mainWindow.on("ready-to-show", () => {
    mainWindow?.show();
  });

  // Hide window instead of closing — app keeps running in tray
  mainWindow.on("close", (e) => {
    if (!(app as any).isQuitting) {
      e.preventDefault();
      mainWindow?.hide();
    }
  });

  // Restrict navigation to the app's own URLs (prevents XSS escalation)
  mainWindow.webContents.on("will-navigate", (event, url) => {
    const allowed = app.isPackaged
      ? url.startsWith("file://")
      : url.startsWith(process.env.ELECTRON_RENDERER_URL || "http://localhost");
    if (!allowed) {
      event.preventDefault();
    }
  });

  // Open external links in system browser (only http/https)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        shell.openExternal(url);
      }
    } catch {}
    return { action: "deny" };
  });

  // Load renderer
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// Single instance lock (skip in test mode so Playwright can launch multiple instances)
const gotTheLock = process.env.NODE_ENV === "test" || app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
    // Check if launched with a dosya:// URL (e.g. from Quick Action)
    const urlArg = argv.find((arg) => arg.startsWith("dosya://"));
    if (urlArg) handleDosyaUrl(urlArg);
  });

  let syncEngine: SyncEngine | undefined;

  app.whenReady().then(async () => {
    // Set dock icon on macOS (dev mode doesn't use the app bundle icon)
    if (process.platform === "darwin") {
      const iconPath = join(__dirname, "../../build/icon.png");
      try {
        const { nativeImage } = await import("electron");
        const dockIcon = nativeImage.createFromPath(iconPath);
        if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon);
      } catch {}
    }

    setupSession(API_BASE);
    registerIpcHandlers(API_BASE);
    createMenu();
    createWindow();
    initAutoUpdater();
    installQuickAction();

    // If app was launched via dosya://sync URL, send it once the renderer is ready
    if (pendingSyncPath && mainWindow) {
      mainWindow.webContents.once("did-finish-load", () => {
        if (pendingSyncPath) {
          mainWindow!.webContents.send("navigate", `/sync?localPath=${encodeURIComponent(pendingSyncPath)}`);
          pendingSyncPath = null;
        }
      });
    }

    // Initialize sync engine (non-critical — app works without it).
    // The engine checks for a valid session cookie before starting.
    // If the user is not logged in, it skips and waits for a login event.
    try {
      syncEngine = new SyncEngine(API_BASE);
      registerSyncIpcHandlers(syncEngine);
      createTray(mainWindow!, syncEngine);
      syncEngine.start().catch((err) => {
        console.error("[sync] Failed to start:", err);
      });
    } catch (err) {
      console.error("[sync] Failed to initialize:", err);
      createTray(mainWindow!);
    }

    // Watch for login/logout by monitoring the dosya_session cookie.
    // Start sync engine on login, stop on logout.
    session.defaultSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
      if (cookie.name !== "dosya_session" || !syncEngine) return;

      if (removed) {
        // Logout: stop the sync engine
        console.log("[sync] Session cookie removed — stopping sync engine");
        syncEngine.stop().catch(() => {});
      } else if (!syncEngine.isRunning()) {
        // Login: start the sync engine
        console.log("[sync] Session cookie set — starting sync engine");
        syncEngine.start().catch((err) => {
          console.error("[sync] Failed to start after login:", err);
        });
      }
    });

    // Pause/resume sync on system sleep/wake
    // Track whether the user had manually paused before sleep
    let wasPausedBeforeSleep = false;
    powerMonitor.on("suspend", () => {
      wasPausedBeforeSleep = syncEngine?.getStatus().globalPaused ?? false;
      if (!wasPausedBeforeSleep) {
        syncEngine?.pauseAll().catch(() => {});
      }
    });
    powerMonitor.on("resume", () => {
      // Only resume if the user hadn't manually paused before sleep
      if (syncEngine && !wasPausedBeforeSleep) {
        syncEngine.resumeAll().catch(() => {});
      }
    });

    app.on("activate", () => {
      if (mainWindow) {
        mainWindow.show();
        mainWindow.focus();
      } else {
        createWindow();
      }
    });
  });

  // Don't quit when all windows are closed — keep running in tray for sync
  app.on("window-all-closed", () => {
    // Do nothing — app stays alive in tray
  });

  // Clean shutdown
  app.on("before-quit", async () => {
    (app as any).isQuitting = true;
    if (syncEngine) {
      await syncEngine.stop().catch(() => {});
    }
  });
}
