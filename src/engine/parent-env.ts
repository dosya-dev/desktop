import type { EnvProvider, HostCookie } from "../main/sync/env-provider";

/** Sends a host request to the parent and resolves when it answers. */
export type HostCall = (method: "getSessionCookies" | "resolveProxy", args: unknown[]) => Promise<unknown>;

/**
 * The EnvProvider for the isolated engine.
 *
 * Every capability it describes lives in the Electron main process -
 * `session.defaultSession` for the auth cookie and the system proxy - and a
 * utilityProcess is plain Node with none of that. So each call is a round trip
 * to the parent, which serves it from the very same `createElectronEnv()` the
 * in-process engine would have called directly.
 *
 * Nothing is cached, deliberately. The session cookie in particular must never
 * be: the parent swaps it on login and clears it on logout, and an engine
 * syncing with a dead cookie is precisely the class of bug this boundary is
 * supposed to make impossible rather than introduce. The transport only asks
 * on request setup, so the round trip is not on a hot path.
 */
export function createParentEnv(call: HostCall, opts: { userDataDir: string; isDev: boolean }): EnvProvider {
  return {
    async getSessionCookies(): Promise<HostCookie[]> {
      const res = await call("getSessionCookies", []);
      return Array.isArray(res) ? (res as HostCookie[]) : [];
    },

    async resolveProxy(url: string): Promise<string | null> {
      const res = await call("resolveProxy", [url]);
      return typeof res === "string" ? res : null;
    },

    isDev: opts.isDev,
    userDataDir: opts.userDataDir,
  };
}
