// Patch fs to handle EMFILE (too many open files) gracefully - must run before anything touches fs.
import { gracefulify } from "graceful-fs";
import { launchedHidden, shouldShowOnReady } from "./window-show";
import fs, { statSync } from "fs";
gracefulify(fs);

import { app, BrowserWindow, shell, powerMonitor, powerSaveBlocker, session, ipcMain, protocol, net, screen, Notification } from "electron";
import { randomUUID } from "crypto";
import { execFile } from "child_process";
import { dirname, join, resolve, sep } from "path";
import { pathToFileURL } from "url";
import { flushSentry, initSentryMain } from "./telemetry";

// Crash reporting first: this starts the native crashReporter (minidumps for
// GPU, renderer and main crashes, uploaded on the next launch), and it has to
// register its IPC scheme before registerSchemesAsPrivileged below runs.
initSentryMain();
import { registerIpcHandlers } from "./ipc";
import { makeIpcGate, rendererOrigin } from "./ipc-sender";
import { installFileLogger } from "./file-logger";
import { isQuitting, markQuitting } from "./quit-state";
import { createWindowReclaimer } from "./window-reclaim";
import { captureWindowState, readWindowState, resolveWindowState, writeWindowState } from "./window-state";
import { validateSyncDeepLinkPath } from "./deep-link-path";
import { findDeepLinkArg, protocolClientRegistration } from "./deep-link";
import { linuxProtocolInstallPlan } from "./linux-protocol";
import { setupSession, appDocumentCsp } from "./session";
import { isUnexpectedSessionLoss } from "./session-events";
import { isSessionCookieName, HOST_SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "./session-cookie";
import { originAllowed } from "./trusted-origins";
import { createMenu, parseMenuState, type AppMenu } from "./menu";
import { openAboutWindow } from "./about-window";
import { summarizeSyncStatus } from "./sync-status-summary";
import { throttleTrailing } from "./throttle";
import { createTray } from "./tray";
import { SyncEngine } from "./sync";
import { SyncEngineHost, type SyncEngineHandle } from "./sync/engine-host";
import { registerSyncIpcHandlers } from "./sync/ipc-handlers";
import { shouldRunEngineInProcess } from "./sync/engine-selection";
import { initAutoUpdater, checkForUpdatesNow, installUpdateNow, openStoreUpdates, getUpdateStatus, onUpdateStatus } from "./updater";
import { installQuickAction } from "./macos-services";
import { currentDistribution } from "./distribution";
import { rendererLogLine, type RendererConsoleDetails } from "./renderer-log";
import { abortAllSinks } from "./lan-receive";
import { abortAllVaultSinks } from "./vault-save";

// ── File logging ────────────────────────────────────────────────────
// Every console line also lands in <userData>/logs/main.log. A packaged
// app's console goes nowhere - the 2026-08-20 stress-test crash left zero
// retrievable evidence.
const fileLog = installFileLogger(join(app.getPath("userData"), "logs"));

// ── Global crash handlers ───────────────────────────────────────────
// After an uncaught exception the process is in an undefined state - but
// app.exit() skips before-quit, so the old bare exit dropped up to 499 file
// operations of unsaved sync state AND the only log line describing why.
// Flush both (bounded), then exit.
let crashExitStarted = false;
async function crashExit(err: unknown): Promise<void> {
  if (crashExitStarted) return;
  crashExitStarted = true;
  console.error("[crash] Uncaught exception - shutting down:", err);
  try {
    // The SDK's own uncaughtException handler has already captured `err`;
    // flushing here is what gets it out before app.exit() kills the socket.
    const stop = syncEngine?.stop().catch(() => {});
    await Promise.race([Promise.all([stop, flushSentry(2000)]), new Promise((r) => setTimeout(r, 3000))]);
  } catch {}
  await fileLog.flush().catch(() => {});
  app.exit(1);
}
process.on("uncaughtException", (err) => {
  void crashExit(err);
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

/**
 * Register the app:// handler that serves the built renderer from disk.
 *
 * This is also where the renderer's Content-Security-Policy is applied. It
 * used to be set in session.ts's `onHeadersReceived`, which had two problems
 * this fixes at once:
 *
 * 1. That hook could not be given a `urls` filter while it was the thing
 *    setting the policy, because Chromium's match-pattern parser rejects a
 *    custom scheme outright ("Wrong scheme type", at registration, inside
 *    `app.whenReady()`), so it stayed unfiltered and ran a blocking
 *    main-process round trip for every request the app made.
 * 2. Its condition was `app.isPackaged && app://`, which silently left a
 *    third real configuration with NO policy at all: built-but-unpackaged,
 *    i.e. `electron-vite preview` and the whole Playwright suite, where the
 *    renderer is served from app://bundle while `app.isPackaged` is false.
 *
 * Here the gate is the SCHEME - every app:// document gets the policy,
 * whoever built the bundle - and `tests/e2e/csp.spec.ts` can finally assert
 * it, which is what makes that spec a guard for the packaged build too.
 */
function registerAppProtocol(): void {
  const rendererDir = join(__dirname, "../renderer");
  const rendererRoot = resolve(rendererDir);
  const indexPath = resolve(join(rendererDir, "index.html"));
  const documentCsp = appDocumentCsp(API_BASE);

  /**
   * Serve the renderer document with its CSP attached.
   *
   * `net.fetch` hands back a Response whose headers are immutable, so the
   * policy has to go onto a NEW Response built from the same body. Status,
   * statusText and every original header are carried over - `Content-Type`
   * above all: drop it and Chromium sniffs the body, decides it is not HTML,
   * and renders the entire app as a wall of plain text with no error
   * anywhere. `new Headers(res.headers)` copies the lot, so nothing has to be
   * re-derived by hand.
   */
  const documentResponse = async (fileUrl: string): Promise<Response> => {
    const res = await net.fetch(fileUrl);
    const headers = new Headers(res.headers);
    headers.set("Content-Security-Policy", documentCsp);
    return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
  };

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
      // The policy goes on DOCUMENTS only - a stylesheet or a script chunk
      // carries no policy of its own, so putting one on every asset would
      // mean rebuilding every Response this handler serves for no effect.
      //
      // "Document" is every .html this bundle serves, NOT just index.html.
      // There are two (`out/renderer/index.html` and
      // `out/renderer/reader/index.html`) and the second one is the one that
      // matters most: `BookViewer.tsx` iframes `/reader/index.html`, and that
      // frame renders UNTRUSTED book content - foliate-js plus the book's own
      // stylesheets, fonts and media as blob/data URLs. The hook this handler
      // replaced matched on the scheme, so it covered that subframe; an
      // `=== indexPath` test silently did not, which left the one document
      // with untrusted input in it as the only one with no policy at all.
      // Whatever .html is added here next gets the policy by default, which
      // is the right direction for that mistake to be impossible in.
      return filePath.endsWith(".html")
        ? await documentResponse(pathToFileURL(filePath).toString())
        : await net.fetch(pathToFileURL(filePath).toString());
    } catch {
      // Unknown asset → serve index.html so client-side routing still
      // resolves. That fallback is a document too, and it is reachable by
      // navigation, so it gets the policy as well - it must not be the one
      // hole in it.
      return documentResponse(pathToFileURL(indexPath).toString());
    }
  });
}

let mainWindow: BrowserWindow | null = null;
// Hoisted to module scope so the per-window listeners createWindow attaches
// (visibility → poller cadence, reclaim) can reach the engine.
let syncEngine: SyncEngineHandle | undefined;
let appMenu: AppMenu | undefined;

/** The renderer's base URL, exactly as createWindow loads it. */
function rendererBaseUrl(): string {
  return !app.isPackaged && process.env.ELECTRON_RENDERER_URL
    ? process.env.ELECTRON_RENDERER_URL
    : `${APP_ORIGIN}/index.html`;
}

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

/**
 * Tell a window it just became visible, so the renderer can pull a fresh
 * snapshot of anything it stopped being sent while it was hidden.
 *
 * This is the other half of the status-broadcast visibility gate in
 * sync/ipc-handlers.ts: a hidden or minimized window no longer receives
 * `sync:status-changed`, so without this it would paint status frozen at the
 * moment it was hidden when the user brought it back. sync-store's init()
 * subscribes and calls its own refresh().
 *
 * Deliberately NOT sendToWindow(): that queues on `did-finish-load`, and
 * queueing is wrong here. A dropped notification is the correct outcome when
 * the renderer is still loading, because a renderer that has not finished
 * loading has not run `init()` yet and will fetch the current status on its
 * own - there is nothing stale to correct.
 *
 * That case is reached in normal operation, not never: `createWindow` shows
 * the window from `ready-to-show`, which precedes `did-finish-load`, so the
 * `show` for a freshly created window arrives while `isLoading()` is still
 * true and this send is dropped. An earlier version of this comment claimed
 * the event "can only happen to a live, loaded window", which is not true.
 */
function notifyWindowShown(win: BrowserWindow): void {
  if (win.isDestroyed()) return;
  const wc = win.webContents;
  if (!wc.isDestroyed() && !wc.isLoading()) wc.send("window:shown");
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

      // Store the session cookie manually (same as login flow). Use the name
      // the API trusts for this origin: the untossable __Host- cookie against
      // https (prod), the plain name against http (dev, where __Host- - which
      // requires Secure - is not allowed). `path: "/"` keeps the prefix valid.
      session.defaultSession.cookies.set({
        url: API_BASE,
        name: API_BASE.startsWith("https:") ? HOST_SESSION_COOKIE : LEGACY_SESSION_COOKIE,
        value: token,
        httpOnly: true,
        secure: true,
        sameSite: "no_restriction",
        path: "/",
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

/**
 * True when this process was started as a hidden login item. Decided once at
 * startup; every later createWindow() (tray click, dock, deep link, reclaim
 * recreate) is the user asking for the window and shows it.
 */
let startedHidden = false;

function createWindow(opts: { showOnReady?: boolean } = {}): void {
  const showOnReady = opts.showOnReady ?? true;
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
    // A hidden login launch stays in the tray (field report 2026-09-02,
    // desktop #13); the window is created so the renderer and sync start,
    // and memory reclaim tears it down again if nobody opens it.
    if (!showOnReady) return;
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
    // Electron does not reliably emit "hide" - on macOS 24.6 / Electron 43,
    // win.hide() flips isVisible() to false and sends nothing, even with the
    // app frontmost. Without this backstop the destroy timer is never armed
    // and the renderer's memory is never returned, silently. Checking once per
    // delay period costs one wakeup every five minutes in production.
    verifyIntervalMs: WINDOW_RECLAIM_MS,
    isQuitting,
    // Hidden means HIDDEN (closed to the tray), deliberately NOT minimized.
    //
    // This briefly read `!win.isVisible() || win.isMinimized()`, on the
    // reasoning that `isVisible()` for a minimized window differs by platform
    // so both signals should count. That reasoning is right for deciding
    // whether to keep RENDERING (see `shouldReceiveStatus`, which does check
    // both) and wrong for deciding whether to DESTROY. Minimizing is not
    // closing: on Windows and Linux the window is still on the taskbar, and
    // destroying it takes that button away five minutes later, with no way
    // back except the tray. On a Linux desktop with no system tray - a case
    // `window-all-closed` already acknowledges - `windowReclaimed` keeps the
    // process alive with no window, no taskbar entry and no tray icon, which
    // leaves the app running and unreachable.
    //
    // So this stays `!isVisible()`, which is what it always was. On macOS
    // that still covers minimize, because macOS's `minimize()` emits `hide`
    // and flips `isVisible()` to false - unchanged behaviour there. The
    // minimize work that IS wanted (stop the renderer rendering, slow the
    // pollers) happens in the "minimize" listener below and in the broadcast
    // gate, neither of which destroys anything.
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
    notifyWindowShown(win);
  });

  // Minimize is not hide, and the difference cuts both ways.
  //
  // Electron happens to emit "hide" on minimize on macOS 15.7.4 (measured),
  // which is the only reason the poller cadence followed minimize at all;
  // nothing in the code said so, and the behaviour is documented to differ
  // per platform. So say it explicitly: a minimized window is not being
  // looked at, and the pollers can slow down.
  //
  // What this deliberately does NOT do is call `reclaimer.onHide()`. Arming
  // the destroy timer here would take the window off the taskbar five
  // minutes after the user minimized it (see the `isHidden` note above).
  // Minimizing stops the WORK - this line, plus the broadcast gate, which
  // checks `isMinimized()` - without taking the window away.
  win.on("minimize", () => {
    syncEngine?.setAppVisible(false);
  });
  win.on("restore", () => {
    syncEngine?.setAppVisible(true);
    reclaimer.onShow();
    notifyWindowShown(win);
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
  win.webContents.on("console-message", (details, level, message, line, sourceId) => {
    // Electron 43 fills `details` (level is a STRING there) and still passes
    // the deprecated positional args; renderer-log.ts prefers the former and
    // falls back to the latter. See renderer-log.ts for why reading only the
    // positional ones is a time bomb.
    const out = rendererLogLine(
      details as unknown as RendererConsoleDetails,
      level as unknown as number,
      message as unknown as string,
      sourceId as unknown as string,
      line as unknown as number,
    );
    if (out) console.error(`[renderer:${out.tag}] ${out.text}`);
  });

  // A dead renderer (OOM, GPU fault) used to leave a permanently blank window
  // - and destroying it on Linux quit the whole app via window-all-closed,
  // taking sync with it (the 2026-08-20 blank-screen symptom). Recreate it
  // instead, reusing the reclaim flag so the quit path knows this is
  // intentional.
  win.webContents.on("render-process-gone", (_event, details) => {
    // Destroying a window kills its renderer, so this fires for INTENTIONAL
    // teardown too - memory reclaim and quit both land here. Recreating the
    // window then would undo the reclaim the moment it happened, which is the
    // whole feature: a hidden window's renderer is 150-300 MB that reclaim
    // exists to give back. Only an unplanned death is a crash.
    if (windowReclaimed || isQuitting()) return;
    console.error("[crash] Renderer process gone:", details.reason, "exitCode:", details.exitCode);
    if (details.reason === "clean-exit") return;
    // The renderer that owned any in-flight LAN receive is gone, and its sink
    // ids died with it - nothing can ever complete them. Close them and remove
    // their partial files, or four crashes exhaust MAX_OPEN_SINKS and LAN
    // Transfer refuses every later receive for the rest of the session.
    void abortAllSinks().catch(() => {});
    // A Vault download's sink is owned by that renderer too, and its id died
    // with it, so the partial plaintext could never be completed or removed.
    void abortAllVaultSinks().catch(() => {});
    const wasVisible = !win.isDestroyed() && win.isVisible();
    windowReclaimed = true;
    if (!win.isDestroyed()) win.destroy();
    if (wasVisible) showMainWindow();
    // Hidden window: stay in the reclaimed state - the tray/dock recreates it
    // on demand, exactly like a memory reclaim.
  });

  win.webContents.on("will-navigate", (event, url) => {
    const devServerUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
    // Compare parsed origins. This was a `startsWith` pair, which was only safe
    // in the packaged branch by accident - the trailing slash on `${APP_ORIGIN}/`
    // happened to stop `app://bundle.evil`, while the dev branch had no such
    // slash and would have accepted `http://localhost:5174.evil.example`.
    const allowed = originAllowed(url, [devServerUrl ?? APP_ORIGIN]);
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
    // ── Sender validation (S-1) ────────────────────────────────────
    // The handlers registered directly in this callback (rather than in
    // ipc.ts or sync/ipc-handlers.ts) get the same gate: `handle`/`on` below
    // refuse a message that did not come from the app's own top-level
    // renderer. See ipc-sender.ts. `rendererOrigin` is the same expression
    // rendererBaseUrl() and the will-navigate guard use, minus the path - only
    // `electron-vite dev` gets the Vite dev server; packaged builds AND the
    // built-but-unpackaged harness both load app://bundle.
    const ipcGate = makeIpcGate(
      ipcMain,
      rendererOrigin({ isPackaged: app.isPackaged, devServerUrl: process.env.ELECTRON_RENDERER_URL }),
    );
    // Same gate, handed to initAutoUpdater below for its 8 channels, so the
    // allowed-origin expression exists in exactly one place per registrar.
    const { handle, on } = ipcGate;

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
    handle("auth:begin-oauth", (_e, provider: string) => {
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

    // The application menu. Its shape lives in menu-template.ts; here every
    // action is routed to main (updates, sync, external links, the About
    // window) or forwarded to the renderer as one typed "menu:action" event.
    //
    // Show first: on macOS the menu is reachable from the menu bar while the
    // window sits in the tray, so showMainWindow only needs to run before
    // sendToWindow. On Windows and Linux the menu is popped from the window's
    // own ☰ button, so this order also covers the window being recreated:
    // sendToWindow waits for did-finish-load when that happens.
    const toRenderer = (channel: string, ...args: unknown[]) => {
      showMainWindow();
      sendToWindow(channel, ...args);
    };
    appMenu = createMenu(
      {
        distribution: currentDistribution(),
        getUpdateState: () => getUpdateStatus().state,
        getSync: () => {
          const engine = syncEngine;
          if (!engine) return null;
          const status = engine.getStatus();
          return {
            summary: summarizeSyncStatus(status),
            globalPaused: status.globalPaused,
            unresolvedConflicts: status.unresolvedConflictCount,
            pairs: status.pairs.map((p) => ({ pairId: p.pairId, name: p.remoteFolderName, localPath: p.localPath })),
          };
        },
      },
      (action) => {
        switch (action.kind) {
          case "navigate":
            toRenderer("navigate", action.path);
            return;
          case "external":
            void shell.openExternal(action.url);
            return;
          case "open-sync-folder": {
            const pair = syncEngine?.getStatus().pairs.find((p) => p.pairId === action.pairId);
            if (pair) void shell.openPath(pair.localPath);
            return;
          }
          case "view":
          case "appearance":
            toRenderer("menu:action", action);
            return;
          case "simple":
            break;
        }
        switch (action.id) {
          case "about":
            openAboutWindow({ rendererUrl: rendererBaseUrl(), preloadPath: join(__dirname, "../preload/index.js"), parent: getWindow() });
            return;
          case "check-for-updates":
            // The Settings card shows the outcome (checking, downloading,
            // ready, up to date, error) - land the user on it.
            void checkForUpdatesNow();
            toRenderer("navigate", "/settings?tab=updates");
            return;
          case "install-update":
            installUpdateNow();
            return;
          case "open-store":
            void openStoreUpdates();
            return;
          case "sync-now-all":
            for (const pair of syncEngine?.getStatus().pairs ?? []) syncEngine?.syncNow(pair.pairId);
            return;
          case "sync-pause":
            void syncEngine?.pauseAll();
            return;
          case "sync-pause-hour":
            void syncEngine?.pauseAllFor(60 * 60 * 1000);
            return;
          case "sync-resume":
            void syncEngine?.resumeAll();
            return;
          case "open-log-folder":
            void shell.openPath(join(app.getPath("userData"), "logs"));
            return;
          case "report-problem":
            toRenderer("report-problem:open");
            return;
          default:
            // Everything else acts inside the renderer: new folder, list/grid,
            // find, sidebar, details, back/forward, sign out, shortcuts…
            toRenderer("menu:action", action);
        }
      },
    );
    // Re-label the update item as a check or download progresses.
    onUpdateStatus(() => appMenu?.rebuild());
    // The renderer tells the menu which route it is on, what is selected and
    // which checkmarks are on. Validated: only a known shape is accepted.
    on("menu:state", (_event, raw: unknown) => {
      const state = parseMenuState(raw);
      if (state) appMenu?.setState(state);
    });
    // Windows and Linux: the ☰ title-bar button.
    handle("menu:popup", (event, pos: { x?: unknown; y?: unknown }) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win) return;
      const x = typeof pos?.x === "number" ? pos.x : 0;
      const y = typeof pos?.y === "number" ? pos.y : 0;
      appMenu?.popup(win, x, y);
    });
    {
      let wasOpenedAsHidden: boolean | undefined;
      try { wasOpenedAsHidden = app.getLoginItemSettings().wasOpenedAsHidden; } catch { wasOpenedAsHidden = undefined; }
      startedHidden = launchedHidden({ argv: process.argv, wasOpenedAsHidden });
      if (startedHidden) console.log("[app] Hidden launch (login item) - window stays in the tray");
    }
    createWindow({ showOnReady: shouldShowOnReady({ openedAsHidden: startedHidden }) });
    initAutoUpdater(ipcGate);
    installQuickAction({ distribution: currentDistribution() });

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
    // GPU / utility process deaths were invisible; at least leave a log line.
    app.on("child-process-gone", (_e, details) => {
      console.error("[crash] Child process gone:", details.type, details.reason);
    });

    try {
      // The engine runs in its own utilityProcess so a crash, hang or OOM
      // inside it costs a re-fork instead of the whole app. Sync resumes from
      // the persistent ops queue, so a restart is invisible apart from a gap.
      //
      // The escape hatch is not dead weight: when a sync bug needs a debugger,
      // DOSYA_SYNC_IN_PROCESS=1 puts the engine back in the process the
      // inspector is already attached to.
      // The Mac App Store build also runs in-process - see engine-selection.ts.
      syncEngine = shouldRunEngineInProcess({ env: process.env, distribution: currentDistribution() })
        ? new SyncEngine(API_BASE)
        : new SyncEngineHost(API_BASE, join(__dirname, "engine.js"));
      registerSyncIpcHandlers(syncEngine);

      // ── Troubleshooting (Settings) ─────────────────────────────────
      // The escape hatches for "the app is in a bad state": a safe cache
      // clear, and a full reset that deletes everything local and starts
      // over. Registered here because the reset must stop the sync engine
      // before deleting its data out from under it.
      handle("app:clear-cache", async () => {
        const ses = session.defaultSession;
        await ses.clearCache();
        await ses.clearCodeCaches({});
        return { ok: true };
      });

      handle("app:factory-reset", async () => {
        console.log("[reset] Factory reset requested from Settings");
        try {
          await syncEngine?.stop();
        } catch (err) {
          console.error("[reset] Engine stop failed, continuing:", err);
        }
        // Sync configuration and per-pair state - everything under
        // <userData>/sync. Deleted while the engine is stopped so nothing
        // rewrites it on the way down.
        try {
          await fs.promises.rm(join(app.getPath("userData"), "sync"), {
            recursive: true,
            force: true,
          });
        } catch (err) {
          console.error("[reset] Sync data removal failed:", err);
        }
        const ses = session.defaultSession;
        // Cookies included: a reset signs the user out by design.
        try {
          await ses.clearStorageData();
        } catch (err) {
          console.error("[reset] Storage clear failed:", err);
        }
        try {
          await ses.clearCache();
        } catch {}
        // The harness cannot track a relaunched instance - it would outlive
        // the test run as an orphan - so test runs stop at quitting.
        if (process.env.NODE_ENV !== "test") app.relaunch();
        markQuitting();
        app.exit(0);
      });

      // Keep the OS from suspending the app mid-transfer (App Nap, timer
      // coalescing). Display sleep stays allowed - this only prevents app
      // suspension, so an unattended 12-hour sync actually runs for 12 hours.
      // Stopped 30s after the last transfer so brief gaps between batches
      // don't flap the blocker.
      let psbId: number | null = null;
      let psbStopTimer: ReturnType<typeof setTimeout> | null = null;
      // The engine talks to the server on a timer, so it is usually the
      // first to learn a session was revoked. The renderer confirms against
      // /api/me and signs out (auth-context.tsx).
      syncEngine.on("session-expired", () => sendToWindow("auth:session-expired"));
      syncEngine.on("status-changed", (status: { pairs: { status: string }[]; activeTransfers: unknown[] }) => {
        const active = status.pairs.some((p) => p.status === "syncing") || status.activeTransfers.length > 0;
        if (active) {
          if (psbStopTimer) { clearTimeout(psbStopTimer); psbStopTimer = null; }
          if (psbId === null || !powerSaveBlocker.isStarted(psbId)) {
            psbId = powerSaveBlocker.start("prevent-app-suspension");
          }
        } else if (psbId !== null && psbStopTimer === null) {
          psbStopTimer = setTimeout(() => {
            psbStopTimer = null;
            if (psbId !== null && powerSaveBlocker.isStarted(psbId)) powerSaveBlocker.stop(psbId);
            psbId = null;
          }, 30_000);
        }
      });
      // The tray outlives any window generation, so it gets accessors that
      // recreate a reclaimed window instead of a reference that can go stale.
      createTray({ showWindow: showMainWindow, sendToWindow }, syncEngine);
      // The Sync menu's status line and pause/resume items follow the engine,
      // throttled the same way the tray is.
      syncEngine.on("status-changed", throttleTrailing(() => appMenu?.rebuild(), 1000));
      // A window that was never shown never fires "show", so the pollers
      // would run at foreground cadence for a user who is not looking.
      if (startedHidden) syncEngine.setAppVisible(false);
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
    let lastSessionCookieValue: string | null = null;
    session.defaultSession.cookies.on("changed", (_event, cookie, cause, removed) => {
      if (!isSessionCookieName(cookie.name) || !syncEngine) return;

      if (removed) {
        // A cookie overwrite arrives as removed(cause "overwrite") for the
        // old value followed immediately by a set for the new one. That is a
        // session REPLACEMENT (re-login, token refresh), not a logout.
        // Stopping the engine here tore down every pair mid-flight and raced
        // the restart against whatever the user did right after signing in -
        // observed as "startPair skipped - engine not started" for a folder
        // added just after re-login, which then never synced. The paired
        // "set" event below decides what actually needs doing.
        if (cause === "overwrite" || cause === "expired-overwrite") return;
        lastSessionCookieValue = null;
        // Logout: stop the sync engine
        console.log(`[sync] Session cookie removed (${cause}) - stopping sync engine`);
        syncEngine.stop().catch(() => {});
        // An explicit logout is the user's own action - they already know.
        // Anything else (the fixed 30-day expiry elapsing, eviction from a
        // remote revocation) happened with no action on their part, and the
        // only other signal is a "sync stopped" email up to 72 hours later.
        if (isUnexpectedSessionLoss(removed, cause)) {
          new Notification({
            title: "Signed out of dosya",
            body: "Your session ended and sync has stopped. Open dosya to sign in again.",
          }).show();
        }
      } else if (!syncEngine.isRunning()) {
        // Login: start the sync engine
        lastSessionCookieValue = cookie.value;
        console.log("[sync] Session cookie set - starting sync engine");
        syncEngine.start().catch((err) => {
          console.error("[sync] Failed to start after login:", err);
        });
      } else if (cookie.value !== lastSessionCookieValue) {
        // Re-login while the engine is running. A server-side revocation
        // never removes the cookie - the renderer just starts seeing 401s -
        // so no stop/start cycle happens here. Without this nudge the client
        // rides out its 60s cookie cache and errored pairs wait for the 30s
        // recovery timer, all while the user is looking at a signed-in app
        // whose sync still says "Session expired. Please log in again."
        lastSessionCookieValue = cookie.value;
        console.log("[sync] Session cookie replaced - refreshing sync session");
        syncEngine.notifySessionRefreshed();
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
      // Transient pause: never persists pausedGlobally. If the app dies on
      // battery before the resume, the next launch must not come up wedged
      // in a paused state nobody chose (the 2026-08-20 empty-Sync-tab trap).
      if (onBattery && !syncEngine.getStatus().globalPaused) {
        batteryPaused = true;
        syncEngine.pauseAllTransient().catch(() => {});
      } else if (!onBattery && batteryPaused) {
        batteryPaused = false;
        syncEngine.resumeAllTransient().catch(() => {});
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
        // Transient: a crash while asleep must not leave pausedGlobally
        // persisted on disk with no resume handler left to clear it.
        syncEngine?.pauseAllTransient().catch(() => {});
      }
    });
    powerMonitor.on("resume", async () => {
      // Only auto-resume if the user hadn't manually paused before sleep.
      if (syncEngine && !wasPausedBeforeSleep) {
        await syncEngine.resumeAllTransient().catch(() => {});
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
    on("net:online", () => syncEngine?.notifyNetworkOnline());

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

    if (isShuttingDown) return;

    // Prevent the default quit - we need to await async cleanup
    e.preventDefault();
    isShuttingDown = true;

    const SHUTDOWN_TIMEOUT_MS = 5000;
    const shutdown = Promise.all([
      syncEngine?.stop().catch(() => {}) ?? Promise.resolve(),
      // A receive in flight owns an open handle and a half-written file at a
      // path the user chose. abortAllSinks() is what removes it; nothing
      // called it before (DSK-008).
      abortAllSinks().catch(() => {}),
      // Same contract for a Vault download, which writes decrypted plaintext
      // through its own sink family: a quit part-way must not leave a
      // truncated plaintext document that looks complete.
      abortAllVaultSinks().catch(() => {}),
    ]).then(() => {});
    const timeout = new Promise<void>((r) => setTimeout(r, SHUTDOWN_TIMEOUT_MS));

    Promise.race([shutdown, timeout]).finally(() => {
      app.quit(); // This re-fires before-quit, but isShuttingDown skips it
    });
  });
}
