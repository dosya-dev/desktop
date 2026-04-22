import {
  ipcMain,
  BrowserWindow,
  dialog,
  session,
  shell,
  Notification,
} from "electron";
import { app } from "electron";
import { join, resolve, sep, basename } from "path";
import { createWriteStream } from "fs";
import { mkdir, rm } from "fs/promises";
import { pipeline } from "stream/promises";
import { Readable } from "stream";
import { clearSessionCookie } from "./session";

/** Allowed OAuth providers (prevents open redirect via arbitrary provider strings). */
const ALLOWED_OAUTH_PROVIDERS = new Set(["google", "github"]);

/** Allowed navigation prefixes for the OAuth popup. */
const OAUTH_ALLOWED_ORIGINS = [
  "https://accounts.google.com",
  "https://github.com",
  "https://www.google.com",
];

export function registerIpcHandlers(apiBase: string): void {
  // Clean up temp files from previous sessions on startup
  const tempDir = join(app.getPath("temp"), "dosya-open");
  rm(tempDir, { recursive: true, force: true }).catch(() => {});

  // ── Window Controls ──────────────────────────────────────────────

  ipcMain.on("app:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.on("app:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) {
      win.isMaximized() ? win.unmaximize() : win.maximize();
    }
  });

  ipcMain.on("app:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  ipcMain.handle("app:get-platform", () => process.platform);

  // ── Auth ─────────────────────────────────────────────────────────

  ipcMain.handle("auth:clear-session", async () => {
    await clearSessionCookie(apiBase);
  });

  ipcMain.handle("auth:get-api-base", () => apiBase);

  // Wait for the dosya_session cookie to be ready (SameSite fixed).
  // After login, the server sets SameSite=Lax which doesn't work for
  // cross-origin fetch. session.ts fixes it to SameSite=None async.
  // This handler polls until the fix is applied before the renderer
  // makes authenticated requests.
  ipcMain.handle("auth:wait-for-session", async () => {
    for (let i = 0; i < 20; i++) {
      const cookies = await session.defaultSession.cookies.get({ name: "dosya_session" });
      const ready = cookies.some((c) => c.sameSite === "no_restriction");
      if (ready) return;
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  // OAuth via popup BrowserWindow
  ipcMain.handle("auth:oauth", async (_event, provider: string) => {
    if (!ALLOWED_OAUTH_PROVIDERS.has(provider)) {
      return { ok: false, error: "Unknown OAuth provider" };
    }

    return new Promise((resolve) => {
      const authUrl = `${apiBase}/api/auth/${provider}`;
      let resolved = false;

      const popup = new BrowserWindow({
        width: 600,
        height: 700,
        show: true,
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
        },
      });

      // Restrict navigation to the API and known OAuth providers
      popup.webContents.on("will-navigate", (event, url) => {
        const allowed =
          url.startsWith(apiBase) ||
          OAUTH_ALLOWED_ORIGINS.some((origin) => url.startsWith(origin));
        if (!allowed) {
          event.preventDefault();
        }
      });

      // Block popup windows from within the OAuth popup
      popup.webContents.setWindowOpenHandler(() => ({ action: "deny" }));

      // Timeout: if nothing happens within 60s, resolve with error
      const loadTimeout = setTimeout(() => {
        done(false, "", "OAuth timed out");
      }, 60_000);

      popup.loadURL(authUrl);

      function done(ok: boolean, url: string, error?: string): void {
        if (resolved) return;
        resolved = true;
        clearTimeout(loadTimeout);
        popup.removeAllListeners();
        popup.webContents.removeAllListeners();
        if (!popup.isDestroyed()) popup.close();
        resolve(ok ? { ok: true, redirectedTo: url } : { ok: false, error });
      }

      async function check(url: string): Promise<void> {
        let path: string;
        try { path = new URL(url).pathname; } catch { return; }

        if (path.startsWith("/dashboard") || path.startsWith("/verify") || path.startsWith("/login/2fa")) {
          // Poll for the session cookie instead of relying on a fixed delay
          for (let i = 0; i < 20; i++) {
            const cookies = await session.defaultSession.cookies.get({ name: "dosya_session" });
            if (cookies.length > 0) {
              done(true, url);
              return;
            }
            await new Promise((r) => setTimeout(r, 100));
          }
          // Cookie still not found after 2s, resolve anyway (it may arrive later)
          done(true, url);
        } else if (path === "/login" && url.includes("error=")) {
          done(false, url, new URL(url).searchParams.get("error") || "OAuth failed");
        }
      }

      // did-navigate fires after the response (including Set-Cookie) is received
      popup.webContents.on("did-navigate", (_e, url) => {
        check(url).catch((err) => {
          console.error("[oauth] check error:", err);
          done(false, "", "OAuth check failed");
        });
      });

      popup.webContents.on("did-fail-load", (_e, code, desc) => {
        done(false, "", `Failed to load: ${desc} (${code})`);
      });

      popup.webContents.on("render-process-gone", () => {
        done(false, "", "OAuth popup crashed");
      });

      popup.on("closed", () => {
        if (!resolved) {
          resolved = true;
          clearTimeout(loadTimeout);
          resolve({ ok: false, error: "Window closed by user" });
        }
      });
    });
  });

  // ── File System ──────────────────────────────────────────────────

  ipcMain.handle("fs:open-file-dialog", async (_event, options) => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      ...options,
    });
    return result;
  });

  ipcMain.handle("fs:save-file-dialog", async (_event, options) => {
    const result = await dialog.showSaveDialog(options);
    return result;
  });

  // ── File Open ─────────────────────────────────────────────────────

  ipcMain.handle(
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
      await mkdir(tempDir, { recursive: true });

      const filePath = join(tempDir, safeName);

      // Verify the resolved path stays inside the temp directory
      const resolvedPath = resolve(filePath);
      const resolvedTempDir = resolve(tempDir);
      if (!resolvedPath.startsWith(resolvedTempDir + sep) && resolvedPath !== resolvedTempDir) {
        throw new Error("Invalid file path");
      }

      // Get session cookie
      const cookies = await session.defaultSession.cookies.get({ url: apiBase });
      const sessionCookie = cookies.find((c) => c.name === "dosya_session");
      if (!sessionCookie) {
        throw new Error("Not authenticated");
      }

      const res = await fetch(`${apiBase}/api/files/${encodeURIComponent(fileId)}/download`, {
        headers: {
          Cookie: `dosya_session=${sessionCookie.value}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Download failed: ${res.status}`);
      }

      const fileStream = createWriteStream(filePath);
      await pipeline(Readable.fromWeb(res.body as any), fileStream);

      await shell.openPath(filePath);
      return { ok: true };
    },
  );

  // ── Notifications ────────────────────────────────────────────────

  ipcMain.on(
    "notification:show",
    (_event, opts: { title: string; body: string }) => {
      // Validate notification fields
      const title = typeof opts?.title === "string" ? opts.title.slice(0, 200) : "dosya";
      const body = typeof opts?.body === "string" ? opts.body.slice(0, 500) : "";
      new Notification({ title, body }).show();
    },
  );
}
