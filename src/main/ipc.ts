import {
  ipcMain,
  BrowserWindow,
  dialog,
  session,
  shell,
  Notification,
} from "electron";
import { app } from "electron";
import { release as osRelease, arch as osArch } from "os";
import { HIDDEN_LAUNCH_ARG } from "./window-show";
import { currentDistribution } from "./distribution";
import { loginItemMode } from "./login-item";
import { join, resolve, sep, basename } from "path";
import { createWriteStream, readFileSync } from "fs";
import { mkdtemp, readdir, rm } from "fs/promises";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import QRCode from "qrcode";
import { longPath } from "./sync/paths";
import { makeIpcGate, rendererOrigin } from "./ipc-sender";
import { describePlatform, tailOfFile, LOG_TAIL_LINES } from "./bug-report";
import { detectDistribution } from "./distribution";
import { clearSessionCookie } from "./session";
import { isSessionCookieName, sessionCookieHeader } from "./session-cookie";
import { buildDownloadUrl } from "./download-url";
import { openSink, writeSink, closeSink, abortSink } from "./lan-receive";
import { openVaultSink, writeVaultSink, closeVaultSink, abortVaultSink } from "./vault-save";
import {
  linkFileProvider,
  relinkFileProvider,
  unlinkFileProvider,
  type FileProviderDeps,
  type FileProviderNative,
} from "./file-provider";
import {
  addonPath,
  loadAddon,
  mintLinkedSession,
  readPreference,
  writePreference,
} from "./file-provider-host";

/**
 * The app's version. Packaged, app.getVersion() reads the bundle; unpackaged
 * (dev, the test harness) it is Electron's own version, so the About window
 * would announce "43.4.0". package.json is the truth there.
 */
export function appVersion(): string {
  if (app.isPackaged) return app.getVersion();
  // `electron-vite dev` sets the app path to the project; the test harness
  // launches out/main/index.js directly, so the path is the bundle's own
  // directory and package.json sits two levels up. Walk up until found.
  let dir = app.getAppPath();
  for (let i = 0; i < 4; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === "@dosya-dev/desktop" && typeof pkg.version === "string") return pkg.version;
    } catch {}
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return app.getVersion();
}

export function registerIpcHandlers(apiBase: string): void {
  // ── Sender validation (S-1) ──────────────────────────────────────
  // Every channel below goes through `handle`/`on` from the gate rather than
  // ipcMain directly, so each one refuses a message that did not come from the
  // app's own top-level renderer. Defense in depth: nothing can reach these
  // channels today (one renderer, one origin, a sandboxed preload that does
  // not reach sub-frames), but the handlers assumed that instead of asserting
  // it. See ipc-sender.ts. `rendererOrigin` mirrors createWindow's loadURL
  // branch: only `electron-vite dev` gets the Vite dev server; packaged builds
  // AND the built-but-unpackaged test harness both load app://bundle.
  const { handle, on } = makeIpcGate(
    ipcMain,
    rendererOrigin({ isPackaged: app.isPackaged, devServerUrl: process.env.ELECTRON_RENDERER_URL }),
  );

  // "Open in system app" writes here. A single fixed name (the old approach)
  // lets another local user preclaim it on a shared /tmp before we start -
  // Linux's sticky bit on /tmp then stops us from ever removing or verifying
  // a directory we don't own, so we'd silently write the authenticated
  // download where they can read it. mkdtemp's random suffix means nobody
  // can preclaim a path they can't predict, and POSIX mandates the result is
  // created mode 0700 (owner-only), independent of umask.
  const openDirRoot = app.getPath("temp");
  const openDirPrefix = "dosya-open-";
  let openDirPromise: Promise<string> | null = null;
  const getOpenDir = (): Promise<string> => {
    if (!openDirPromise) {
      openDirPromise = mkdtemp(join(openDirRoot, openDirPrefix)).catch((err) => {
        openDirPromise = null;
        throw err;
      });
    }
    return openDirPromise;
  };

  // Best-effort sweep of dirs left behind by a crashed previous run. Safe to
  // ignore failures: each is uniquely named, so we never fall back to
  // reusing one we couldn't remove or don't own.
  readdir(openDirRoot)
    .then((entries) =>
      Promise.all(
        entries
          .filter((name) => name.startsWith(openDirPrefix))
          .map((name) => rm(join(openDirRoot, name), { recursive: true, force: true }).catch(() => {})),
      ),
    )
    .catch(() => {});

  // ── Window Controls ──────────────────────────────────────────────

  on("app:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  on("app:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });

  on("app:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // DOSYA_E2E_PLATFORM lets Playwright exercise the win32/linux titlebar
  // layouts from a single OS; honored only under the test runner's env.
  handle(
    "app:get-platform",
    () => (process.env.NODE_ENV === "test" && process.env.DOSYA_E2E_PLATFORM) || process.platform,
  );

  // ── Launch at login ──────────────────────────────────────────────
  // macOS honours openAsHidden and reports it back as wasOpenedAsHidden;
  // Windows has no hidden-launch flag, so the login item carries --hidden and
  // main/index.ts reads it off argv (window-show.ts). getLoginItemSettings on
  // Windows only answers openAtLogin=true when the registered args match, so
  // the same args are passed to both calls; executableWillLaunchAtLogin covers
  // an entry registered before the argument existed.
  const loginItemArgs = process.platform === "win32" ? [HIDDEN_LAUNCH_ARG] : [];
  // The Mac App Store build is sandboxed and Electron's login helper cannot
  // register from inside the sandbox; SMAppService can, on macOS 13+. See
  // login-item.ts for the decision and its test.
  const loginMode = loginItemMode({
    distribution: currentDistribution(),
    platform: process.platform,
    osVersion: process.getSystemVersion(),
  });
  const loginType = loginMode === "mainAppService" ? ({ type: "mainAppService" } as const) : {};
  const launchAtLogin = (): boolean => {
    if (loginMode === "unsupported") return false;
    try {
      const s = app.getLoginItemSettings({ args: loginItemArgs, ...loginType });
      return s.openAtLogin || (process.platform === "win32" && s.executableWillLaunchAtLogin === true);
    } catch {
      return false;
    }
  };
  handle("app:get-launch-at-login-supported", () => loginMode !== "unsupported");
  handle("app:get-launch-at-login", () => launchAtLogin());
  handle("app:set-launch-at-login", (_e, enabled: boolean) => {
    if (loginMode === "unsupported") return false;
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true, args: loginItemArgs, ...loginType });
    return launchAtLogin();
  });

  // ── Standard OS folders (for known-folder backup presets) ────────
  handle("app:get-standard-paths", () => {
    const get = (name: Parameters<typeof app.getPath>[0]) => {
      try { return app.getPath(name); } catch { return null; }
    };
    return {
      desktop: get("desktop"),
      documents: get("documents"),
      pictures: get("pictures"),
      downloads: get("downloads"),
      home: get("home"),
    };
  });

  // ── Bug reports (spec: docs/superpowers/specs/2026-10-03-bug-report-design.md) ──
  // What the renderer cannot know about the machine. Nothing here is a path.
  handle("app:get-diagnostics-info", () => ({
    version: app.getVersion(),
    // Same formula updater.ts uses for `app:get-distribution`, read through the
    // same pure helper rather than importing updater.ts's module-level constant.
    distribution: detectDistribution({
      windowsStore: process.windowsStore,
      mas: process.mas,
      env: process.env,
    }),
    arch: osArch(),
    platform: describePlatform({ platform: process.platform, release: osRelease() }),
    locale: app.getLocale(),
  }));

  // The About window's facts. Separate from the bug report's diagnostics so
  // adding a field here never changes what a report sends to the server.
  handle("app:get-about-info", () => ({
    version: appVersion(),
    distribution: detectDistribution({
      windowsStore: process.windowsStore,
      mas: process.mas,
      env: process.env,
    }),
    platform: describePlatform({ platform: process.platform, release: osRelease() }),
    arch: osArch(),
    electron: process.versions.electron ?? "",
    chrome: process.versions.chrome ?? "",
  }));

  // The last lines of main.log (file-logger.ts). Opt-in on the renderer side:
  // the log names files from the user's synced folders.
  handle("app:read-log-tail", () =>
    tailOfFile(join(app.getPath("userData"), "logs", "main.log"), LOG_TAIL_LINES),
  );

  // A picture of the window that asked, as JPEG bytes. Throws when there is no
  // window to capture; the renderer treats that as "no screenshot", not as a
  // failed report.
  handle("app:capture-window", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || win.isDestroyed()) throw new Error("No window to capture");
    const image = await win.webContents.capturePage();
    if (image.isEmpty()) throw new Error("Window capture is empty");
    return new Uint8Array(image.toJPEG(85));
  });

  // ── Auth ─────────────────────────────────────────────────────────

  handle("auth:clear-session", async () => {
    await clearSessionCookie(apiBase);
    // The extension holds a session of its own, and the files macOS downloaded
    // for it sit on disk. The server revokes the session with its parent, but
    // only removing the domain takes the location and those files away. Signing
    // out must never fail on this, so it is awaited and swallowed rather than
    // left to reject the handler.
    await unlinkFileProvider(null, fileProviderDeps()).catch(() => {});
  });

  handle("auth:get-api-base", () => apiBase);

  // Wait for the dosya_session cookie to be ready (SameSite fixed).
  // After login, the server sets SameSite=Lax which doesn't work for
  // cross-origin fetch. session.ts fixes it to SameSite=None async.
  // This handler polls until the fix is applied, and applies it directly
  // if the cookies.on("changed") listener hasn't done so yet.
  handle("auth:wait-for-session", async () => {
    const WAIT_TIMEOUT_MS = 10_000;

    /** Returns true when the cookie is present and usable (fixing it if not). */
    const tryResolve = async (): Promise<boolean> => {
      const all = await session.defaultSession.cookies.get({ url: apiBase });
      const cookies = all.filter((c) => isSessionCookieName(c.name));
      if (cookies.some((c) => c.sameSite === "no_restriction")) return true;

      const unfixed = cookies.find((c) => c.sameSite !== "no_restriction");
      if (!unfixed) return false; // not logged in yet - nothing to fix
      try {
        await session.defaultSession.cookies.set({
          url: apiBase,
          name: unfixed.name,
          value: unfixed.value,
          httpOnly: unfixed.httpOnly,
          secure: true,
          path: "/", // keep a __Host- cookie valid on re-set
          expirationDate: unfixed.expirationDate || Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60,
          sameSite: "no_restriction",
        });
        return true;
      } catch {
        return false; // a "changed" event will bring us back here
      }
    };

    if (await tryResolve()) return;

    // Wait on the cookie store's own event rather than re-querying 30 times at
    // 100ms. The old loop cost up to 3s of latency purely in polling
    // granularity and gave up while a slow login was still in flight; this
    // reacts the moment the cookie lands and can afford a longer ceiling.
    await new Promise<void>((resolveWait) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        session.defaultSession.cookies.removeListener("changed", onChanged);
        resolveWait();
      };
      const onChanged = (
        _e: Electron.Event,
        cookie: Electron.Cookie,
        _cause: string,
        removed: boolean,
      ): void => {
        if (!isSessionCookieName(cookie.name) || removed) return;
        void tryResolve().then((ok) => { if (ok) finish(); });
      };
      const timer = setTimeout(finish, WAIT_TIMEOUT_MS);
      session.defaultSession.cookies.on("changed", onChanged);
      // Re-check once after subscribing: the cookie may have landed in the gap
      // between the first check and the listener being attached.
      void tryResolve().then((ok) => { if (ok) finish(); });
    });
  });

  // ── File System ──────────────────────────────────────────────────

  handle("fs:open-file-dialog", async (_event, options) => {
    // Whitelist specific fields instead of spreading untrusted renderer options
    const safeOpts: Electron.OpenDialogOptions = {
      properties: ["openFile", "multiSelections"],
    };
    if (options && typeof options === "object") {
      if (typeof options.title === "string") safeOpts.title = options.title.slice(0, 200);
      if (typeof options.defaultPath === "string") safeOpts.defaultPath = options.defaultPath;
      if (Array.isArray(options.filters)) safeOpts.filters = options.filters;
    }
    return dialog.showOpenDialog(safeOpts);
  });

  handle("fs:save-file-dialog", async (_event, options) => {
    const safeOpts: Electron.SaveDialogOptions = {};
    if (options && typeof options === "object") {
      if (typeof options.title === "string") safeOpts.title = options.title.slice(0, 200);
      if (typeof options.defaultPath === "string") safeOpts.defaultPath = options.defaultPath;
      if (Array.isArray(options.filters)) safeOpts.filters = options.filters;
    }
    return dialog.showSaveDialog(safeOpts);
  });

  // ── LAN Transfer: where an incoming file is written ────────────────
  //
  // The renderer owns the WebRTC channel but never the destination. It opens
  // a sink by NAME, the user picks the path in a dialog here, and the handle
  // never leaves this process - so a peer on the network cannot aim its bytes
  // anywhere. See src/main/lan-receive.ts.

  handle("lan:recv-open", (_event, { name, size }: { name: unknown; size: unknown }) =>
    openSink(name, size));
  handle("lan:recv-chunk", (_event, { id, bytes }: { id: unknown; bytes: unknown }) =>
    writeSink(id, bytes));
  handle("lan:recv-close", (_event, { id }: { id: unknown }) => closeSink(id));
  handle("lan:recv-abort", (_event, { id }: { id: unknown }) => abortSink(id));

  // ── File Open ─────────────────────────────────────────────────────

  handle(
    "file:open",
    async (_event, { fileId, fileName }: { fileId: string; fileName: string }) => {
      // Validate inputs
      if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > 200) {
        throw new Error("Invalid fileId");
      }
      if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 500) {
        throw new Error("Invalid fileName");
      }

      // Sanitize fileName: strip directory separators to prevent path traversal
      const safeName = basename(fileName).replace(/[/\\]/g, "_");
      if (!safeName || safeName === "." || safeName === "..") {
        throw new Error("Invalid file name");
      }

      // Download the file to a temp directory and open it with the system default app
      const tempDir = await getOpenDir();

      const filePath = join(tempDir, safeName);

      // Verify the resolved path stays inside the temp directory
      const resolvedPath = resolve(filePath);
      const resolvedTempDir = resolve(tempDir);
      if (!resolvedPath.startsWith(resolvedTempDir + sep) && resolvedPath !== resolvedTempDir) {
        throw new Error("Invalid file path");
      }

      // Get session cookie
      const cookies = await session.defaultSession.cookies.get({ url: apiBase });
      const cookieHeader = sessionCookieHeader(cookies);
      if (!cookieHeader) {
        throw new Error("Not authenticated");
      }

      const res = await fetch(`${apiBase}/api/files/${encodeURIComponent(fileId)}/download`, {
        headers: {
          Cookie: cookieHeader,
        },
      });

      if (!res.ok) {
        throw new Error(`Download failed: ${res.status}`);
      }

      // Explicit mode is defense in depth: the containing dir is already 0700,
      // but this keeps the file itself owner-only if that ever changes.
      const fileStream = createWriteStream(longPath(filePath), { mode: 0o600 });
      await pipeline(Readable.fromWeb(res.body as any), fileStream);

      // shell.openPath resolves to an error STRING ("" on success), so ignoring
      // it made every failure look like a successful open. Note the `\\?\`
      // long-path prefix is deliberately NOT applied here: it is understood by
      // the Win32 file APIs (hence longPath on the write above) but not by
      // ShellExecute, which backs openPath - prefixing would turn a
      // path-too-long failure into an unconditional one.
      const openErr = await shell.openPath(filePath);
      if (openErr) throw new Error(`Could not open the file: ${openErr}`);
      return { ok: true };
    },
  );

  // ── File Download (to a user-chosen location) ─────────────────────

  handle(
    "file:download",
    async (
      _event,
      {
        fileId,
        fileName,
        version,
        archiveEntryIndex,
      }: { fileId: string; fileName: string; version?: number; archiveEntryIndex?: number },
    ) => {
      if (typeof fileId !== "string" || fileId.length === 0 || fileId.length > 200) {
        throw new Error("Invalid fileId");
      }
      if (typeof fileName !== "string" || fileName.length === 0 || fileName.length > 500) {
        throw new Error("Invalid fileName");
      }
      if (version !== undefined && (!Number.isInteger(version) || version < 1 || version > 100000)) {
        throw new Error("Invalid version");
      }
      // Validated (and the URL decided) before the save dialog even opens, the
      // same discipline the checks above already follow - a malformed entry
      // index fails fast instead of prompting for a save location it will
      // never use.
      const url = buildDownloadUrl(apiBase, { fileId, version, archiveEntryIndex });

      const safeName = basename(fileName).replace(/[/\\]/g, "_");
      if (!safeName || safeName === "." || safeName === "..") {
        throw new Error("Invalid file name");
      }

      const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Save file",
        defaultPath: join(app.getPath("downloads"), safeName),
      });
      if (canceled || !filePath) return { ok: false, canceled: true };

      const cookies = await session.defaultSession.cookies.get({ url: apiBase });
      const cookieHeader = sessionCookieHeader(cookies);
      if (!cookieHeader) {
        throw new Error("Not authenticated");
      }

      const res = await fetch(url, {
        headers: {
          Cookie: cookieHeader,
        },
      });

      if (!res.ok) {
        throw new Error(`Download failed: ${res.status}`);
      }

      const fileStream = createWriteStream(longPath(filePath));
      await pipeline(Readable.fromWeb(res.body as any), fileStream);
      return { ok: true, path: filePath };
    },
  );

  handle(
    "archive:download",
    async (_event, { fileIds, folderIds }: { fileIds: string[]; folderIds: string[] }) => {
      if (!Array.isArray(fileIds) || !Array.isArray(folderIds) || (fileIds.length === 0 && folderIds.length === 0)) {
        throw new Error("Nothing to download");
      }
      const { canceled, filePath } = await dialog.showSaveDialog({
        title: "Save archive",
        defaultPath: join(app.getPath("downloads"), "dosya-download.zip"),
      });
      if (canceled || !filePath) return { ok: false, canceled: true };

      const cookies = await session.defaultSession.cookies.get({ url: apiBase });
      const cookieHeader = sessionCookieHeader(cookies);
      if (!cookieHeader) throw new Error("Not authenticated");

      const res = await fetch(`${apiBase}/api/files/download-archive`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookieHeader },
        body: JSON.stringify({ file_ids: fileIds, folder_ids: folderIds }),
      });
      if (!res.ok) throw new Error(`Download failed: ${res.status}`);

      const fileStream = createWriteStream(longPath(filePath));
      await pipeline(Readable.fromWeb(res.body as any), fileStream);
      return { ok: true, path: filePath };
    },
  );

  // S-3: the path is one the renderer itself produced (a download it just
  // wrote, a sync folder it already knows) and showItemInFolder only reveals
  // it in the file manager - it does not read or hand back contents. The shape
  // check below is all the handler needs; who may supply a path at all is now
  // bounded by the gate above, which is the part that was missing.
  handle("file:show-in-folder", async (_event, path: string) => {
    if (typeof path !== "string" || path.length === 0 || path.length > 2000) {
      throw new Error("Invalid path");
    }
    shell.showItemInFolder(path);
  });

  // ── Vault: where a decrypted file is written ──────────────────────
  //
  // The renderer decrypts and asks by NAME; the dialog, the path and the file
  // handle stay here. It streams: one decrypted chunk per `vault:save-chunk`,
  // so neither process ever holds the whole plaintext and nothing is held
  // while the dialog is on screen (DSK-010). There is deliberately no
  // whole-buffer channel any more - it would put the 2x-the-file-across-two
  // -processes cost straight back. See src/main/vault-save.ts.
  handle("vault:save-open", (_event, { name }: { name: unknown }) => openVaultSink(name));
  handle("vault:save-chunk", (_event, { id, bytes, index }: { id: unknown; bytes: unknown; index: unknown }) =>
    writeVaultSink(id, bytes, index));
  handle("vault:save-close", (_event, { id }: { id: unknown }) => closeVaultSink(id));
  handle("vault:save-abort", (_event, { id }: { id: unknown }) => abortVaultSink(id));

  // ── 2FA QR generation ────────────────────────────────────────────
  // Render the authenticator QR entirely on-device. The otpauth:// URI embeds
  // the raw TOTP shared secret, so it must NEVER be sent to a third-party image
  // service (it previously went to api.qrserver.com). Generated locally here.
  handle("totp:generate-qr", async (_event, uri: string) => {
    if (typeof uri !== "string" || !uri.startsWith("otpauth://") || uri.length > 1000) {
      throw new Error("Invalid TOTP URI");
    }
    return QRCode.toDataURL(uri, { width: 220, margin: 1, errorCorrectionLevel: "M" });
  });

  // ── Notifications ────────────────────────────────────────────────

  on(
    "notification:show",
    (_event, opts: { title: string; body: string }) => {
      // Validate notification fields
      const title = typeof opts?.title === "string" ? opts.title.slice(0, 200) : "dosya";
      const body = typeof opts?.body === "string" ? opts.body.slice(0, 500) : "";
      new Notification({ title, body }).show();
    },
  );

  // ── Finder location (macOS) ──────────────────────────────────────
  // The addon is loaded once, lazily: on any other platform, and on a dev build
  // that has never run scripts/build-file-provider-addon.mjs, there is nothing
  // to load and the app simply offers no Finder location.
  let addon: FileProviderNative | null | undefined;
  const nativeAddon = (): FileProviderNative | null => {
    if (addon === undefined) {
      addon =
        process.platform === "darwin"
          ? loadAddon(
              addonPath({
                packaged: app.isPackaged,
                resourcesPath: process.resourcesPath,
                appRoot: app.getAppPath(),
              }),
            )
          : null;
    }
    return addon;
  };

  const fileProviderDeps = (): FileProviderDeps => ({
    native: nativeAddon(),
    mint: () =>
      mintLinkedSession(apiBase, {
        cookieHeader: async () =>
          sessionCookieHeader(await session.defaultSession.cookies.get({ url: apiBase })),
        fetch: globalThis.fetch,
      }),
  });

  const preferenceDir = (): string => app.getPath("userData");

  /**
   * True when a domain is registered but macOS has not been told it may run it.
   * A newly added domain starts disabled and stays that way until the user
   * approves the extension in System Settings; until then the location appears
   * in Finder and every request against it fails with "Sync is not enabled".
   */
  const needsApproval = async (native: FileProviderNative | null): Promise<boolean> => {
    if (!native) return false;
    try {
      return (await native.domainEnabled()) === false;
    } catch {
      return false;
    }
  };

  handle("fileProvider:status", async () => {
    const native = nativeAddon();
    return {
      available: Boolean(native?.isSupported()),
      enabled: await readPreference(preferenceDir()),
      needsApproval: await needsApproval(nativeAddon()),
    };
  });

  handle("fileProvider:open-settings", async () => {
    // The Extensions pane. macOS has no deep link to the File Providers section
    // itself, so the user lands one click away from it.
    await shell.openExternal("x-apple.systempreferences:com.apple.ExtensionsPreferences");
  });

  handle("fileProvider:link", async (_event, opts: { userId: unknown; fresh?: unknown }) => {
    const userId = opts?.userId;
    if (typeof userId !== "string" || userId.length === 0 || userId.length > 200) {
      throw new Error("Invalid userId");
    }
    if (!(await readPreference(preferenceDir()))) return { ok: false };
    const link = opts?.fresh === true ? relinkFileProvider : linkFileProvider;
    return { ok: await link(userId, fileProviderDeps()) };
  });

  handle(
    "fileProvider:set-enabled",
    async (_event, opts: { enabled: unknown; userId?: unknown }) => {
      const enabled = opts?.enabled;
      if (typeof enabled !== "boolean") throw new Error("Invalid enabled");
      const userId = typeof opts?.userId === "string" && opts.userId.length <= 200 ? opts.userId : null;
      await writePreference(preferenceDir(), enabled);
      // Take effect now rather than on the next sign-in: a switch that does
      // nothing until you restart reads as a switch that does not work.
      // `linked` is null when there is nobody to link: the preference is stored
      // and the next sign-in acts on it. False means it was tried and did not
      // work, which the switch has to show rather than report a bare success.
      let linked: boolean | null = null;
      if (enabled) {
        if (userId) linked = await linkFileProvider(userId, fileProviderDeps());
      } else {
        await unlinkFileProvider(null, fileProviderDeps());
      }
      return { enabled, linked, needsApproval: await needsApproval(nativeAddon()) };
    },
  );
}
