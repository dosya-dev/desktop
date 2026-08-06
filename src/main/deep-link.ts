/**
 * `dosya://` deep-link plumbing that has to work without Electron so it can be
 * tested directly.
 *
 * Background - the Windows OAuth bug this module was written for:
 *
 * Desktop sign-in opens the system browser, and the API finishes the flow with
 * a 302 to `dosya://auth/callback?token=...&state=...`. macOS handles that
 * because electron-builder turns the `protocols:` block in electron-builder.yml
 * into `CFBundleURLTypes` in Info.plist. The NSIS target ignores that same
 * block - it is only read by the macOS, Linux and AppX packagers - so on
 * Windows the scheme had no handler at all. The browser received the redirect
 * and silently did nothing, which users reported as "it stays in the browser
 * and never comes back to the app".
 *
 * Two things are needed on Windows, and they cover different moments:
 *   1. the installer writes the registry keys, so the very first callback works
 *      even if the app has never been launched (see build/installer.nsh), and
 *   2. `app.setAsDefaultProtocolClient` at startup, which repairs the keys if
 *      another app stole the scheme and is the only path that works in dev.
 */

/** The custom URL scheme the app registers with the OS. */
export const DEEP_LINK_SCHEME = "dosya";

const PREFIX = `${DEEP_LINK_SCHEME}://`;

/**
 * Pull the deep-link URL out of a process argv vector.
 *
 * Windows and Linux have no `open-url` event: the OS launches the app (or a
 * second instance of it) with the URL as a plain argument, so argv is the only
 * place it ever appears. Callers pass `process.argv` on cold start and the
 * `second-instance` argv when an instance is already running.
 *
 * The value is untrusted - anything that can navigate a browser can put a URL
 * here - so this only locates the argument. `handleDosyaUrl` is what decides
 * whether to honour it.
 */
export function findDeepLinkArg(argv: readonly string[]): string | null {
  for (const raw of argv) {
    if (typeof raw !== "string") continue;
    // A shell can hand the argument over still wrapped in its quotes.
    const arg = raw.trim().replace(/^"([\s\S]*)"$/, "$1");
    // URL schemes are case-insensitive and Windows does not normalise them.
    if (arg.toLowerCase().startsWith(PREFIX)) return arg;
  }
  return null;
}

export interface ProtocolClientRegistration {
  scheme: string;
  /** Set only when the OS must be told which binary to launch (dev builds). */
  execPath?: string;
  /** Arguments that binary needs before the URL is appended. */
  args?: string[];
}

/**
 * Work out the arguments for `app.setAsDefaultProtocolClient`.
 *
 * Packaged builds register themselves: `process.execPath` is the app binary, so
 * the one-argument form is right.
 *
 * Unpackaged builds are the trap. There `process.execPath` is
 * `node_modules/electron/dist/electron.exe`, so the one-argument form registers
 * the bare Electron runtime and a `dosya://` link launches Electron with no app
 * to run. Windows needs the entry script passed explicitly so it can rebuild
 * the full command line.
 */
export function protocolClientRegistration(opts: {
  isPackaged: boolean;
  execPath: string;
  argv: readonly string[];
  /** Injected so the path resolution is testable off-platform. */
  resolvePath?: (p: string) => string;
}): ProtocolClientRegistration {
  if (opts.isPackaged) return { scheme: DEEP_LINK_SCHEME };

  const entry = opts.argv[1];
  // No entry script to point at - registering bare electron.exe would be worse
  // than not registering at all, so leave the existing association alone.
  if (!entry) return { scheme: DEEP_LINK_SCHEME };

  const resolvePath = opts.resolvePath ?? ((p: string) => p);
  return { scheme: DEEP_LINK_SCHEME, execPath: opts.execPath, args: [resolvePath(entry)] };
}
