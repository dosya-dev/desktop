import { app, session } from "electron";
import type { EnvProvider } from "./env-provider";

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
      const cookies = await session.defaultSession.cookies.get({ name: "dosya_session" });
      return cookies.map((c) => ({ value: c.value, domain: c.domain ?? "" }));
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

    get isDev(): boolean {
      return !app.isPackaged;
    },

    get userDataDir(): string {
      return app.getPath("userData");
    },
  };
}
