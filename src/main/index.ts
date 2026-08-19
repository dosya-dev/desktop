// Patch fs to handle EMFILE (too many open files) gracefully - must run before anything touches fs.
import { gracefulify } from "graceful-fs";
import fs, { statSync } from "fs";
gracefulify(fs);

import { app, BrowserWindow, shell, powerMonitor, session, crashReporter, ipcMain, protocol, net, screen } from "electron";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { dirname, join, resolve, sep } from "path";
import { pathToFileURL } from "url";

// Enable crash reporter for native crashes (GPU, renderer, main).
// Captures minidumps locally. Set submitURL to a collection endpoint when ready.
crashReporter.start({
  productName: "dosya",
  submitURL: "", // empty = store locally only, no network upload
  uploadToServer: false,
  compress: true,
});
import { registerIpcHandlers } from "./ipc";
import { isQuitting, markQuitting } from "./quit-state";
import { createWindowReclaimer } from "./window-reclaim";
import { captureWindowState, readWindowState, resolveWindowState, writeWindowState } from "./window-state";
import { validateSyncDeepLinkPath } from "./deep-link-path";
import { findDeepLinkArg, protocolClientRegistration } from "./deep-link";
import { linuxProtocolInstallPlan } from "./linux-protocol";
import { setupSession } from "./session";
import { createMenu } from "./menu";
import { createTray } from "./tray";
import { SyncEngine } from "./sync";
import { registerSyncIpcHandlers } from "./sync/ipc-handlers";
import { initAutoUpdater } from "./updater";
import { installQuickAction } from "./macos-services";

// ── Global crash handlers ───────────────────────────────────────────
// After an uncaught exception the process is in an undefined state.
// Log the error and exit to avoid silent data corruption.
process.on("uncaughtException", (err) => {
  console.error("[crash] Uncaught exception - exiting:", err);
  setTimeout(() => app.exit(1), 2000);
});
process.on("unhandledRejection", (reason) => {
  console.error("[crash] Unhandled rejection:", reason);
});

// The API split off the marketing site when the monorepo was created:
// dosya.dev is the Astro marketing site (no /api routes), the API lives on
// api.dosya.dev (prod) / localhost:4322 (apps/api dev server, 4321 is the site).
const API_BASE = process.env.API_BASE || (app.isPackaged ? "https://api.dosya.dev" : "http://localhost:4322");

// ── Custom renderer scheme (packaged builds) ───────────────────────
// Packaged builds serve the renderer from app://bundle/ instead of file://.
// A registered "standard" scheme gives the renderer a real, stable origin
// (app://bundle) - which is what lets us run with webSecurity ENABLED and do
// credentialed CORS to the API. file:// serializes to the "null" origin, which
// can't do credentialed CORS, which is the whole reason webSecurity was off.
const APP_SCHEME = "app";
const APP_ORIGIN = "app://bundle"; // must match the CORS allowlist on the API
protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

/** Register the app:// handler that serves the built renderer from disk. */
function registerAppProtocol(): void {
  const rendererDir = join(__dirname, "../renderer");
  const rendererRoot = resolve(rendererDir);
  protocol.handle(APP_SCHEME, async (request) => {
    let rel: string;
    try {
      rel = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response("Bad request", { status: 400 });
    }
    if (rel === "/" || rel === "") rel = "/index.html";
    const filePath = resolve(join(rendererDir, rel));
    // Path-traversal guard: never serve outside the renderer bundle.
    if (filePath !== rendererRoot && !filePath.startsWith(rendererRoot + sep)) {
      return new Response("Forbidden", { status: 403 });
    }
    try {
      return await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      // Unknown asset → serve index.html so client-side routing still resolves.
      return net.fetch(pathToFileURL(join(rendererDir, "index.html")).toString());
    }
  });
}

let mainWindow: BrowserWindow | null = null;
// Hoisted to module scope so the per-window listeners createWindow attaches
// (visibility → poller cadence, reclaim) can reach the engine.
let syncEngine: SyncEngine | undefined;

// ── Window memory reclaim ──────────────────────────────────────────
// The app lives in the tray: "closing" the window only hides it, which kept a
// full renderer + GPU process (easily 150-300 MB) alive for a window nobody
// could see. After WINDOW_RECLAIM_MS hidden, the window is destroyed and its
// memory returned; every open path (tray, dock activate, deep link, second
// instance) recreates it on demand via showMainWindow(). Sync is untouched -
// the engine lives entirely in the main process.
//
// DOSYA_WINDOW_RECLAIM_MS overrides the delay (tests use a short one);
// 0 disables reclaim.
const WINDOW_RECLAIM_DEFAULT_MS = 5 * 60 * 1000;
const reclaimEnvMs = Number(process.env.DOSYA_WINDOW_RECLAIM_MS);
const WINDOW_RECLAIM_MS =
  Number.isFinite(reclaimEnvMs) && reclaimEnvMs >= 0 ? reclaimEnvMs : WINDOW_RECLAIM_DEFAULT_MS;

/** True from the moment reclaim destroys the window until the next create -
 * tells window-all-closed "the app is still resident in the tray, don't quit". */
let windowReclaimed = false;

/** The live window, or null if it was never created, was reclaimed, or is mid-destroy. */
function getWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
}

/** Show the window, recreating it if reclaim (or anything else) destroyed it. */
function showMainWindow(): void {
  const win = getWindow();
  if (win) {
    win.show();
    win.focus();
    return;
  }
  createWindow(); // ready-to-show will show and focus it
}

/**
 * Send to the renderer, queueing until did-finish-load when the window was
 * just (re)created and its listeners aren't attached yet - the generalized
 * form of the pendingSyncPath pattern below.
 */
function sendToWindow(channel: string, ...args: unknown[]): void {
  const win = getWindow();
  if (!win) return;
  const wc = win.webContents;
  if (wc.isLoading()) {
    wc.once("did-finish-load", () => {
      if (!wc.isDestroyed()) wc.send(channel, ...args);
    });
  } else {
    wc.send(channel, ...args);
  }
}

// ── dosya:// URL handler ───────────────────────────────────────────
// Handles URLs like dosya://sync?path=/Users/john/Documents
// Triggered by the macOS Quick Action or protocol links.
let pendingSyncPath: string | null = null;
/** Backstop if the renderer never reports did-finish-load (blank/failed load). */
const SYNC_START_FALLBACK_MS = 8000;

// Single-use nonce for the OAuth login flow. We generate it when the user
// starts login (auth:begin-oauth), send it as OAuth `state`, and only accept a
// dosya://auth/callback whose `state` echoes it back. This blocks injected /
// replayed callback URLs from silently switching the app to an attacker session.
let pendingOAuthNonce: string | null = null;

function handleDosyaUrl(url: string): void {
  try {
    const parsed = new URL(url);

    // dosya://auth/callback?token=xxx&state=<nonce> - OAuth login from system browser
    if (parsed.hostname === "auth" || parsed.pathname === "//auth/callback") {
      const token = parsed.searchParams.get("token");
      if (!token) return;

      // Anti session-fixation: only accept a callback that answers a login WE
      // started, by matching the single-use nonce we sent as OAuth state. A
      // callback with a missing/wrong nonce is an injected or replayed URL.
      const state = parsed.searchParams.get("state");
      if (!pendingOAuthNonce || state !== pendingOAuthNonce) {
        console.warn("[auth] Rejected OAuth callback: missing or mismatched state nonce");
        pendingOAuthNonce = null;
        return;
      }
      pendingOAuthNonce = null; // single use

      // Store the session cookie manually (same as login flow)
      session.defaultSession.cookies.set({
        url: API_BASE,
        name: "dosya_session",
        value: token,
        httpOnly: true,
        secure: true,
        sameSite: "no_restriction",
        expirationDate: Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
      }).then(() => {
        // Pre-ready (cold start) there is no window yet and none is created
        // here: the renderer's normal startup auth check finds the cookie.
        if (app.isReady()) {
          showMainWindow(); // recreates the window if reclaim destroyed it
          // Tell the renderer to refresh auth state and navigate to dashboard
          sendToWindow("auth:oauth-complete");
        }
      }).catch((err) => {
        console.error("[auth] Failed to store OAuth cookie:", err);
      });
      return;
    }

    // dosya://sync?path=/Users/john/Documents - sync folder request
    if (parsed.hostname === "sync" || parsed.pathname === "//sync") {
      const rawPath = parsed.searchParams.get("path");
      if (!rawPath) return;

      // Anyone can navigate a browser to a custom scheme, so this value is
      // untrusted - see deep-link-path.ts for what the old two-line check let
      // through. Only the resolved, existence-checked path is forwarded.
      const folderPath = validateSyncDeepLinkPath(rawPath, (p) => {
        try { return statSync(p).isDirectory(); } catch { return false; }
      });
      if (!folderPath) {
        console.warn("[deep-link] rejected dosya://sync path");
        return;
      }

      if (app.isReady()) {
        showMainWindow(); // recreates the window if reclaim destroyed it
        sendToWindow("navigate", `/sync?localPath=${encodeURIComponent(folderPath)}`);
      } else {
        // Cold start (macOS open-url fires before whenReady): parked until the
        // first window finishes loading.
        pendingSyncPath = folderPath;
      }
    }
  } catch {}
}

// Register open-url early so cold-start URLs are captured.
// macOS only - Windows and Linux deliver the URL through argv instead, which is
// what registerProtocolClient/findDeepLinkArg below handle.
app.on("open-url", (event, url) => {
  event.preventDefault();
  handleDosyaUrl(url);
});

/**
 * Claim the dosya:// scheme with the OS.
 *
 * macOS gets this for free from CFBundleURLTypes in Info.plist, which
 * electron-builder generates from the `protocols:` block. The NSIS target
 * ignores that block, so on Windows the scheme went unregistered and the OAuth
 * callback redirect died in the browser. build/installer.nsh writes the keys at
 * install time; this call covers dev builds and repairs the association if
 * another app has taken it over since.
 */
function registerProtocolClient(): void {
  if (process.platform === "darwin") return;
  try {
    const reg = protocolClientRegistration({
      isPackaged: app.isPackaged,
      execPath: process.execPath,
      argv: process.argv,
      resolvePath: resolve,
    });
    const ok = reg.execPath
      ? app.setAsDefaultProtocolClient(reg.scheme, reg.execPath, reg.args)
      : app.setAsDefaultProtocolClient(reg.scheme);
    if (!ok) console.warn(`[deep-link] OS refused to register ${reg.scheme}://`);
  } catch (err) {
    // A failed association is not worth blocking startup over - in-app popup
    // login still works, only the browser hand-back is lost.
    console.error("[deep-link] Failed to register protocol client:", err);
  }
}

/**
 * AppImage runs are the one distribution with no install step, so nothing ever
 * puts a desktop entry with the dosya:// MimeType where xdg can see it and the
 * setAsDefaultProtocolClient call above fails (its xdg-settings backend needs
 * an installed entry to point at). Materialise the entry ourselves on every
 * launch - idempotent, and it follows the AppImage when the user moves it.
 * See linux-protocol.ts for the full background.
 */
async function installLinuxProtocolHandler(): Promise<void> {
  try {
    const plan = linuxProtocolInstallPlan({
      platform: process.platform,
      isPackaged: app.isPackaged,
      env: process.env,
      home: app.getPath("home"),
      argv: process.argv,
    });
    if (!plan) return;

    await fs.promises.mkdir(plan.desktopDir, { recursive: true });
    const entry = await fs.promises.readFile(plan.desktopPath, "utf8").catch(() => null);
    if (entry !== plan.desktopContent) {
      await fs.promises.writeFile(plan.desktopPath, plan.desktopContent);
    }

    const mimeapps = await fs.promises.readFile(plan.mimeappsPath, "utf8").catch(() => null);
    const merged = plan.mergeMimeapps(mimeapps);
    if (merged !== mimeapps) {
      await fs.promises.mkdir(dirname(plan.mimeappsPath), { recursive: true });
      await fs.promises.writeFile(plan.mimeappsPath, merged);
    }

    for (const { cmd, args } of plan.postCommands) {
      // Best-effort cache refresh: the mimeapps.list default above already
      // registers the handler, and not every distro ships desktop-file-utils.
      execFile(cmd, args, { timeout: 5000 }, () => {});
    }
  } catch (err) {
    console.error("[deep-link] Failed to install AppImage protocol handler:", err);
  }
}

function createWindow(): void {
  // Reopen where the user left the window - reclaim recreates windows, so
  // without this every reopen-from-tray snapped back to 1200x800 centered.
  const stateDir = app.getPath("userData");
  const { bounds: savedBounds, maximized: savedMaximized } = resolveWindowState(
    readWindowState(stateDir),
    screen.getAllDisplays().map((d) => d.workArea),
    { width: 1200, height: 800, minWidth: 900, minHeight: 600 },
  );

  mainWindow = new BrowserWindow({
    width: savedBounds?.width ?? 1200,
    height: savedBounds?.height ?? 800,
    ...(savedBounds ? { x: savedBounds.x, y: savedBounds.y } : {}),
    // 900 was wide enough that the app could not be used beside anything else -
    // no macOS split view on a 13" laptop, no half-screen next to a browser.
    // The renderer holds up down to this width: the sidebar drops to icons
    // below 1000 (see Sidebar), the files toolbar wraps, and the file table
    // scrolls sideways rather than compressing its columns.
    //
    // Restored bounds are clamped to these by Electron, so a window saved at
    // an older, larger minimum still reopens at whatever the user last chose.
    minWidth: 700,
    minHeight: 560,
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
      // webSecurity ENABLED. Credentialed cross-origin requests to the API work
      // because the renderer now has a real origin (app://bundle in packaged
      // builds, http://localhost:5174 in dev) that the API allows via CORS -
      // rather than the "null" file:// origin that forced webSecurity off before.
      webSecurity: true,
      // Chromium's built-in PDF viewer is plugin-gated in Electron; the in-app
      // file viewer renders PDFs in an <iframe> and needs it enabled.
      plugins: true,
    },
  });

  const win = mainWindow;
  windowReclaimed = false;
  if (savedMaximized) win.maximize();

  win.on("ready-to-show", () => {
    win.show();
    win.focus();
  });

  // Persist geometry: debounced on resize/move, immediately on hide (the
  // reclaim path - state must be on disk before a destroy) and close (the
  // real-quit path, where close is not prevented).
  const persistBounds = (): void => writeWindowState(stateDir, captureWindowState(win));
  let boundsTimer: ReturnType<typeof setTimeout> | null = null;
  const persistBoundsSoon = (): void => {
    if (boundsTimer) clearTimeout(boundsTimer);
    boundsTimer = setTimeout(persistBounds, 500);
  };
  win.on("resize", persistBoundsSoon);
  win.on("move", persistBoundsSoon);
  win.on("close", persistBounds);

  // Hide window instead of closing - app keeps running in tray
  win.on("close", (e) => {
    if (!isQuitting()) {
      e.preventDefault();
      win.hide();
    }
  });

  // Reclaim the renderer's memory once the window has been hidden a while.
  // Decision logic lives in window-reclaim.ts (unit-tested); this wires the
  // real window. Listeners are attached HERE, per window, so a recreated
  // window gets the same visibility → sync-cadence and reclaim behavior.
  const reclaimer = createWindowReclaimer({
    delayMs: WINDOW_RECLAIM_MS,
    isQuitting,
    isHidden: () => !win.isDestroyed() && !win.isVisible(),
    destroy: () => {
      if (win.isDestroyed()) return;
      windowReclaimed = true;
      win.destroy();
    },
  });

  win.on("hide", () => {
    persistBounds();
    // Hidden (tray) → pollers slow to their idle cadence.
    syncEngine?.setAppVisible(false);
    reclaimer.onHide();
  });
  win.on("show", () => {
    syncEngine?.setAppVisible(true);
    reclaimer.onShow();
  });

  win.on("closed", () => {
    if (boundsTimer) clearTimeout(boundsTimer);
    // A window closed for ANY reason must not leave a live timer behind, and
    // stale references must read as "no window" from here on.
    reclaimer.dispose();
    if (mainWindow === win) mainWindow = null;
  });

  // Restrict navigation to the app's own URLs (prevents XSS escalation).
  // Mirrors the loadURL branch below exactly: only the Vite dev server case
  // (!app.isPackaged && ELECTRON_RENDERER_URL set) gets the localhost origin;
  // every other case - packaged builds AND the built-but-unpackaged case (test
  // harness / `electron-vite preview`) - loads from app://bundle, so a bare
  // `app.isPackaged` check on this side used to wrongly block reload() there.
  // Surface renderer errors in the main process log.
  //
  // A packaged build has no DevTools (see menu.ts), so a renderer exception was
  // invisible: the CSP violation that blanked the map page printed only to a
  // console nobody could open, while the terminal output a user can actually
  // copy showed nothing at all. Errors and warnings only - forwarding every
  // log line would bury the sync output this log exists for.
  win.webContents.on("console-message", (_event, level, message, line, sourceId) => {
    // Electron levels: 0 verbose, 1 info, 2 warning, 3 error.
    if (level < 2) return;
    const tag = level === 3 ? "error" : "warn";
    console.error(`[renderer:${tag}] ${message}  (${sourceId}:${line})`);
  });

  win.webContents.on("will-navigate", (event, url) => {
    const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    const allowed = devServerUrl
      ? url.startsWith(devServerUrl)
      : url.startsWith(`${APP_ORIGIN}/`);
    if (!allowed) {
      event.preventDefault();
    }
  });

  // Open external links in system browser (only http/https)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") {
        shell.openExternal(url);
      }
    } catch {}
    return { action: "deny" };
  });

  // Load renderer. Dev: Vite server. Packaged: our app:// scheme (real origin).
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadURL(`${APP_ORIGIN}/index.html`);
  }
}

// Single instance lock (skip in test mode so Playwright can launch multiple instances)
const gotTheLock = (!app.isPackaged && process.env.NODE_ENV === "test") || app.requestSingleInstanceLock();

if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    // Windows/Linux deliver dosya:// links by launching a second instance with
    // the URL in argv - this is the path the OAuth callback takes while the app
    // is already running.
    const urlArg = findDeepLinkArg(argv);
    // Relaunching while the window is reclaimed must bring one back.
    const win = getWindow();
    if (win?.isMinimized()) win.restore();
    showMainWindow();
    if (urlArg) handleDosyaUrl(urlArg);
  });

  /** Guard so the did-finish-load signal and its fallback timer can't both start sync. */
  let syncStarted = false;
  let startSyncOnce: (() => void) | undefined;

  app.whenReady().then(async () => {
    // Serve the packaged renderer from app://bundle (must be registered before
    // the window loads that URL).
    registerAppProtocol();

    // Set dock icon on macOS (dev mode doesn't use the app bundle icon)
    if (process.platform === "darwin") {
      const iconPath = join(__dirname, "../../build/icon.png");
      try {
        const { nativeImage } = await import("electron");
        const dockIcon = nativeImage.createFromPath(iconPath);
        if (!dockIcon.isEmpty()) app.dock?.setIcon(dockIcon);
      } catch {}
    }

    setupSession(API_BASE);
    registerIpcHandlers(API_BASE);

    // Start an OAuth login: mint a fresh single-use nonce and hand the renderer
    // the provider URL carrying it. The dosya:// callback is only honored if it
    // echoes this exact nonce back (see handleDosyaUrl).
    ipcMain.handle("auth:begin-oauth", (_e, provider: string) => {
      if (provider !== "google" && provider !== "github" && provider !== "apple") {
        throw new Error("Unknown OAuth provider");
      }
      pendingOAuthNonce = randomUUID();
      return `${API_BASE}/api/auth/${provider}?desktop=1&state=${encodeURIComponent(pendingOAuthNonce)}`;
    });

    registerProtocolClient();
    void installLinuxProtocolHandler();

    // Cold start: on Windows/Linux the OS launches the app with the URL in
    // argv, and neither open-url (macOS only) nor second-instance (needs an
    // instance already holding the lock) fires. Without this the link is
    // dropped. Runs before createWindow so a dosya://sync link lands in
    // pendingSyncPath and gets forwarded once the renderer finishes loading.
    if (process.platform !== "darwin") {
      const startupUrl = findDeepLinkArg(process.argv);
      if (startupUrl) handleDosyaUrl(startupUrl);
    }

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

    // Initialize sync engine (non-critical - app works without it).
    // The engine checks for a valid session cookie before starting.
    // If the user is not logged in, it skips and waits for a login event.
    try {
      syncEngine = new SyncEngine(API_BASE);
      registerSyncIpcHandlers(syncEngine);
      // The tray outlives any window generation, so it gets accessors that
      // recreate a reclaimed window instead of a reference that can go stale.
      createTray({ showWindow: showMainWindow, sendToWindow }, syncEngine);
      // Sync must not start before the renderer has painted: state loading,
      // snapshot fetch and reconcile all block the main thread's IPC and the
      // window would sit blank. This waited a flat 3s for that, which both
      // idled fast machines and could still fire too early on slow ones.
      // did-finish-load is the actual signal; the timer is now only a backstop
      // for a renderer that never finishes loading.
      startSyncOnce = () => {
        if (syncStarted) return;
        syncStarted = true;
        syncEngine?.start().catch((err) => {
          console.error("[sync] Failed to start:", err);
        });
        // Battery state is reconciled as part of the same signal rather than
        // on a separate 4s timer, which used to let sync start and then
        // immediately stop again on a laptop with "pause on battery".
        try { void applyBatteryState(powerMonitor.isOnBatteryPower()); } catch {}
      };
      mainWindow!.webContents.once("did-finish-load", () => startSyncOnce?.());
      setTimeout(() => startSyncOnce?.(), SYNC_START_FALLBACK_MS);
    } catch (err) {
      console.error("[sync] Failed to initialize:", err);
      createTray({ showWindow: showMainWindow, sendToWindow });
    }

    // Visibility → sync poller cadence is wired inside createWindow (it must
    // re-attach on every recreated window), not here.

    // Watch for login/logout by monitoring the dosya_session cookie.
    // Start sync engine on login, stop on logout.
    session.defaultSession.cookies.on("changed", (_event, cookie, _cause, removed) => {
      if (cookie.name !== "dosya_session" || !syncEngine) return;

      if (removed) {
        // Logout: stop the sync engine
        console.log("[sync] Session cookie removed - stopping sync engine");
        syncEngine.stop().catch(() => {});
      } else if (!syncEngine.isRunning()) {
        // Login: start the sync engine
        console.log("[sync] Session cookie set - starting sync engine");
        syncEngine.start().catch((err) => {
          console.error("[sync] Failed to start after login:", err);
        });
      }
    });

    // Battery-aware pausing: when "pause on battery" is enabled, pause on
    // unplug and resume on plug-in - but only auto-resume what WE auto-paused,
    // so a manual pause is never clobbered.
    let batteryPaused = false;
    const applyBatteryState = async (onBattery: boolean) => {
      if (!syncEngine) return;
      const cfg = await syncEngine.getConfig();
      if (!cfg.pauseOnBattery) return;
      if (onBattery && !cfg.pausedGlobally) {
        batteryPaused = true;
        syncEngine.pauseAll().catch(() => {});
      } else if (!onBattery && batteryPaused) {
        batteryPaused = false;
        syncEngine.resumeAll().catch(() => {});
      }
    };
    powerMonitor.on("on-battery", () => applyBatteryState(true));
    powerMonitor.on("on-ac", () => applyBatteryState(false));

    // Pause/resume sync on system sleep/wake.
    // Track whether the user had manually paused before sleep.
    let wasPausedBeforeSleep = false;
    powerMonitor.on("suspend", () => {
      wasPausedBeforeSleep = syncEngine?.getStatus().globalPaused ?? false;
      if (!wasPausedBeforeSleep) {
        syncEngine?.pauseAll().catch(() => {});
      }
    });
    powerMonitor.on("resume", async () => {
      // Only auto-resume if the user hadn't manually paused before sleep.
      if (syncEngine && !wasPausedBeforeSleep) {
        await syncEngine.resumeAll().catch(() => {});
      }
      // The power source may have changed during sleep (e.g. unplugged), and
      // on-battery/on-ac only fire on live transitions - so reconcile battery
      // state explicitly on wake. This pauses if we woke on battery with
      // "pause on battery" enabled, and resumes if we were battery-paused and
      // woke on AC. Without this, waking on battery leaves sync running against
      // the user's preference.
      applyBatteryState(powerMonitor.isOnBatteryPower()).catch(() => {});
      // A machine that slept through a network change comes back with pairs
      // parked on stale connection errors - retry them now rather than after
      // the next 30s recovery tick.
      syncEngine?.notifyNetworkOnline();
    });

    // The renderer forwards the browser's `online` event (Electron's main
    // process has no equivalent), which is the earliest reliable signal that
    // connectivity is back after an outage.
    ipcMain.on("net:online", () => syncEngine?.notifyNetworkOnline());

    // Initial battery state is handled by startSyncOnce (events only fire on
    // transitions), so sync and the battery rule are decided by one signal.

    app.on("activate", () => {
      showMainWindow();
    });
  });

  // Don't quit when all windows are closed - keep running in tray for sync.
  // Exception: on Linux without a system tray (e.g. GNOME 40+), the user
  // has no way to reopen the app, so we quit instead.
  app.on("window-all-closed", () => {
    // Memory reclaim destroyed a hidden window on purpose: the app is still
    // resident in the tray and the next open path recreates the window. Not a
    // reason to quit on any platform.
    if (windowReclaimed) return;
    if (process.platform === "linux") {
      // On Linux, quit if there's no tray icon to reopen from
      markQuitting();
      app.quit();
    }
    // macOS/Windows: do nothing - app stays alive in tray
  });

  // Clean shutdown: prevent quit until sync state is persisted.
  let isShuttingDown = false;
  app.on("before-quit", (e) => {
    markQuitting();

    if (!syncEngine || isShuttingDown) return;

    // Prevent the default quit - we need to await async cleanup
    e.preventDefault();
    isShuttingDown = true;

    const SHUTDOWN_TIMEOUT_MS = 5000;
    const shutdown = syncEngine.stop().catch(() => {});
    const timeout = new Promise<void>((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS));

    Promise.race([shutdown, timeout]).finally(() => {
      app.quit(); // This re-fires before-quit, but isShuttingDown skips it
    });
  });
}
