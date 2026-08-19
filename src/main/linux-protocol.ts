/**
 * Linux AppImage `dosya://` scheme registration, computed without Electron so
 * it can be tested directly (same split as deep-link.ts).
 *
 * Background - the Linux flavour of the Windows OAuth bug:
 *
 * The `protocols:` block in electron-builder.yml does put
 * `MimeType=x-scheme-handler/dosya;` into the Linux desktop entry, but for the
 * AppImage target that entry only exists INSIDE the image. A downloaded
 * AppImage is executed, never installed, so no desktop entry ever reaches
 * ~/.local/share/applications and the OS has no handler for the scheme. The
 * runtime `app.setAsDefaultProtocolClient` call cannot repair this either: on
 * Linux it shells out to `xdg-settings set default-url-scheme-handler`, which
 * needs an already-installed desktop entry to point at, so it fails and the
 * OAuth redirect dies in the browser ("Failed to open URI"). The deb target is
 * immune because dpkg installs the entry and Ubuntu's desktop-file-utils
 * trigger rebuilds the MIME cache.
 *
 * The fix mirrors build/installer.nsh on Windows: the moment that would be
 * "install time" has to do the registration. For an AppImage the only such
 * moment is app startup, so the main process materialises the plan computed
 * here on every launch (idempotent, and it follows the file when the user
 * moves or renames the AppImage):
 *
 *   1. write <XDG_DATA_HOME>/applications/dosya.desktop with the scheme
 *      MimeType and Exec pointing at $APPIMAGE (set by the AppImage runtime),
 *   2. set it as the scheme default in <XDG_CONFIG_HOME>/mimeapps.list - the
 *      highest-precedence MIME config, edited directly so registration does
 *      not depend on xdg-utils being installed, and
 *   3. run update-desktop-database (best-effort) so mimeinfo.cache also
 *      advertises the handler.
 */

const SCHEME_MIME = "x-scheme-handler/dosya";
const DESKTOP_FILE = "dosya.desktop";
const DEFAULTS_SECTION = "[Default Applications]";

/**
 * Quote one Exec argument per the Desktop Entry spec. Values are read in two
 * passes - general string unescaping, then quote parsing - and each pass
 * consumes one level of backslash, so reserved characters need a double-level
 * escape. Literal `%` doubles to survive field-code expansion.
 */
function quoteExecArg(arg: string): string {
  const escaped = arg
    .replace(/\\/g, "\\\\\\\\")
    .replace(/"/g, '\\\\"')
    .replace(/`/g, "\\\\`")
    .replace(/\$/g, "\\\\$")
    .replace(/%/g, "%%");
  return `"${escaped}"`;
}

export interface LinuxProtocolPlan {
  /** Directory the desktop entry belongs in (created if missing). */
  desktopDir: string;
  /** Full path of the desktop entry to write. */
  desktopPath: string;
  /** Desired content of that entry; write only when it differs. */
  desktopContent: string;
  /** The user-level MIME defaults file. */
  mimeappsPath: string;
  /** Fold the scheme default into an existing mimeapps.list (null = absent). */
  mergeMimeapps(existing: string | null): string;
  /** Best-effort follow-ups; failure only degrades discovery, never login. */
  postCommands: { cmd: string; args: string[] }[];
}

/**
 * Everything the main process must install for the OS to resolve dosya://
 * back to this AppImage, or null when this run is not a packaged AppImage
 * (dev runs have nothing durable to point Exec at, and deb installs already
 * own a system-wide desktop entry that a user-local one would shadow).
 */
export function linuxProtocolInstallPlan(opts: {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  env: Record<string, string | undefined>;
  home: string;
  argv: readonly string[];
}): LinuxProtocolPlan | null {
  if (opts.platform !== "linux" || !opts.isPackaged) return null;

  // Set by the AppImage runtime to the absolute path of the image file. Treat
  // anything else as "not an AppImage run" rather than guessing.
  const appImage = opts.env.APPIMAGE;
  if (!appImage || !appImage.startsWith("/")) return null;

  const dataHome = opts.env.XDG_DATA_HOME || `${opts.home}/.local/share`;
  const configHome = opts.env.XDG_CONFIG_HOME || `${opts.home}/.config`;
  const desktopDir = `${dataHome}/applications`;

  // The browser delivers the callback by launching a second instance, and on a
  // root session (Chromium refuses to start as root without --no-sandbox) that
  // instance dies before it can forward the URL unless the flag rides along.
  // Rendering flags are deliberately not carried - a URL forwarder never paints.
  const exec = [
    quoteExecArg(appImage),
    ...(opts.argv.includes("--no-sandbox") ? ["--no-sandbox"] : []),
    "%U",
  ].join(" ");

  const desktopContent = [
    "[Desktop Entry]",
    "Type=Application",
    "Name=dosya",
    "Comment=Opens dosya:// links in the dosya AppImage. Auto-generated at app startup; edits are overwritten.",
    `Exec=${exec}`,
    "Terminal=false",
    // Scheme plumbing only - keep the entry out of app launchers so the menu
    // does not grow a duplicate "dosya" per download location.
    "NoDisplay=true",
    `MimeType=${SCHEME_MIME};`,
    "",
  ].join("\n");

  return {
    desktopDir,
    desktopPath: `${desktopDir}/${DESKTOP_FILE}`,
    desktopContent,
    mimeappsPath: `${configHome}/mimeapps.list`,
    mergeMimeapps: (existing) => mergeMimeapps(existing),
    postCommands: [{ cmd: "update-desktop-database", args: [desktopDir] }],
  };
}

/**
 * Return mimeapps.list content with `x-scheme-handler/dosya=dosya.desktop`
 * under [Default Applications], touching nothing else. The file is the user's
 * own config - other apps' defaults must survive byte-for-byte.
 */
function mergeMimeapps(existing: string | null): string {
  const wanted = `${SCHEME_MIME}=${DESKTOP_FILE}`;
  if (!existing || !existing.trim()) return `${DEFAULTS_SECTION}\n${wanted}\n`;

  const lines = existing.split("\n");
  const sectionAt = lines.findIndex((l) => l.trim() === DEFAULTS_SECTION);
  if (sectionAt === -1) {
    const body = existing.endsWith("\n") ? existing : `${existing}\n`;
    return `${body}\n${DEFAULTS_SECTION}\n${wanted}\n`;
  }

  // Replace a stale handler line inside the section; otherwise insert right
  // under the header.
  for (let i = sectionAt + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith("[")) break; // next section - key not present
    if (line.startsWith(`${SCHEME_MIME}=`)) {
      if (line === wanted) return existing;
      lines[i] = wanted;
      return lines.join("\n");
    }
  }
  lines.splice(sectionAt + 1, 0, wanted);
  return lines.join("\n");
}
