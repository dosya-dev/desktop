/**
 * Everything the transport needs from its host environment.
 *
 * RemoteClient used to reach for Electron directly - `session.defaultSession`
 * for the auth cookie and the system proxy, `app.isPackaged` for dev logging.
 * That is exactly three calls, but they are the reason the sync engine cannot
 * run anywhere except the Electron main process: a `utilityProcess` is plain
 * Node, where those APIs do not exist.
 *
 * Naming them here turns "the engine is welded to the main process" into "the
 * engine takes an object", which is the prerequisite for ever isolating it.
 * The Electron-backed implementation lives in electron-env.ts; a test or a
 * future utility process supplies its own.
 *
 * Deliberately tiny: every method added here is another thing a future host
 * has to be able to provide.
 */
/** A session cookie as the host sees it, before any domain matching. */
export interface HostCookie {
  value: string;
  /** May be dot-prefixed (".dosya.dev"). Empty when the host omits it. */
  domain: string;
}

export interface EnvProvider {
  /**
   * Every `dosya_session` cookie the host holds, unfiltered.
   *
   * Deliberately NOT "the cookie for this host": which one applies involves
   * exact-then-dot-suffix domain matching that the transport already does and
   * must keep doing identically. Moving that decision in here would fork it.
   */
  getSessionCookies(): Promise<HostCookie[]>;

  /**
   * The system/corporate proxy for a URL, e.g. "http://proxy:8080", or null
   * for a direct connection. PAC files and bypass rules are the provider's
   * problem, not the client's.
   */
  resolveProxy(url: string): Promise<string | null>;

  /** True in a development build - enables verbose transport logging. */
  readonly isDev: boolean;

  /**
   * Where this installation keeps its data (Electron's `userData`). The engine
   * puts its index and config under here. A non-Electron host has to be told
   * this rather than being able to ask for it.
   */
  readonly userDataDir: string;
}

/**
 * A provider with no session, no proxy and no dev logging. Useful as a
 * starting point in tests, and as an explicit "not wired up yet" that fails
 * loudly at the auth check rather than silently syncing as nobody.
 */
export const NULL_ENV: EnvProvider = {
  getSessionCookies: async () => [],
  resolveProxy: async () => null,
  isDev: false,
  userDataDir: "",
};
