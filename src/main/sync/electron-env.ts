import { app, session, shell } from "electron";
import type { EnvProvider } from "./env-provider";
import { HOST_SESSION_COOKIE, LEGACY_SESSION_COOKIE } from "../session-cookie";

/**
 * The Electron-backed EnvProvider - the only place the transport's host
 * dependencies are resolved against real Electron APIs.
 *
 * Keeping this in its own file is the point: `remote-client.ts` no longer
 * imports electron at all, so moving the engine into a `utilityProcess`
 * (plain Node, no session or app APIs) becomes a matter of supplying a
 * different provider rather than rewriting the transport.
 */
export function createElectronEnv(): EnvProvider {
  return {
    async getSessionCookies() {
      // Both names: the __Host- cookie (prod) and the legacy one (dev / a
      // session that predates the migration).
      const [host, legacy] = await Promise.all([
        session.defaultSession.cookies.get({ name: HOST_SESSION_COOKIE }),
        session.defaultSession.cookies.get({ name: LEGACY_SESSION_COOKIE }),
      ]);
      return [...host, ...legacy].map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.domain ?? "",
      }));
    },

    async resolveProxy(url: string): Promise<string | null> {
      try {
        // "DIRECT" | "PROXY host:port" | "HTTPS host:port". Chromium has
        // already applied PAC files and NO_PROXY rules by this point.
        const info = await session.defaultSession.resolveProxy(url);
        if (!info || info === "DIRECT") return null;
        const match = info.match(/^(PROXY|HTTPS)\s+(.+)$/i);
        if (!match) return null;
        const scheme = match[1].toUpperCase() === "HTTPS" ? "https" : "http";
        return `${scheme}://${match[2]}`;
      } catch {
        return null;
      }
    },

    async trashItem(absPath: string): Promise<void> {
      await shell.trashItem(absPath);
    },

    get isDev(): boolean {
      return !app.isPackaged;
    },

    get userDataDir(): string {
      return app.getPath("userData");
    },
  };
}
