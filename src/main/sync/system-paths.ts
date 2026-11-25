/**
 * Sync-ROOT guard: refuse system trees as sync roots at pair-add time.
 *
 * History: the engine once hard-ignored system NAMES (bin, lib, tmp...) at any
 * depth, which silently dropped folders inside legitimate trees - the 2026-08
 * ignore-rules rework removed that on purpose. The consequence: nothing
 * stopped a user from syncing /usr itself, which the 2026-08-20 stress test
 * proved fatal (~500K root-owned files, EACCES churn, OOM). The guard belongs
 * here, on the ROOT the user picks, not in the per-entry ignore rules.
 *
 * Pure module (platform and home are injected) so node --test can load it.
 */

function norm(p: string, caseInsensitive: boolean): string {
  let s = p.replace(/\\/g, "/");
  if (s.length > 1) s = s.replace(/\/+$/, "");
  return caseInsensitive ? s.toLowerCase() : s;
}

function isOrInside(path: string, base: string): boolean {
  return path === base || path.startsWith(base + "/");
}

// NOT on any list, deliberately: /Volumes (macOS) and /mnt, /media (Linux).
// Those are where external drives and network shares mount, and backing up to
// or from an external disk is a primary reason people use this app - blocking
// them would break the main use case to guard against nothing.
const DENY: Partial<Record<NodeJS.Platform, string[]>> = {
  darwin: ["/System", "/Library", "/private", "/usr", "/bin", "/sbin", "/etc", "/var", "/opt", "/Applications", "/dev", "/cores"],
  linux: ["/usr", "/etc", "/var", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/boot", "/opt", "/srv", "/root", "/snap", "/nix", "/proc", "/sys", "/dev", "/run"],
  win32: ["C:/Windows", "C:/Program Files", "C:/Program Files (x86)", "C:/ProgramData"],
};

/**
 * Returns null when `absPath` is an acceptable sync root, otherwise a
 * user-readable reason to refuse it.
 */
export function forbiddenSyncRootReason(
  absPath: string,
  platform: NodeJS.Platform,
  home: string,
  /**
   * The OS scratch directory. On macOS this lives under /var/folders, which
   * sits inside a denied system tree - but it is per-user scratch space, not
   * the operating system, and refusing it blocks tooling and tests for no
   * safety gain. The catastrophe this guard exists to prevent is syncing /usr
   * or C:\Windows, not a bad-but-harmless choice.
   */
  tmpDir?: string,
): string | null {
  const ci = platform === "win32" || platform === "darwin";
  const p = norm(absPath, ci);
  const h = home ? norm(home, ci) : "";

  if (tmpDir) {
    const t = norm(tmpDir, ci);
    if (t && isOrInside(p, t)) return null;
  }

  if (p === "/" || /^[a-z]:$/i.test(p)) {
    return "Syncing an entire drive is not supported - pick a specific folder.";
  }
  if (h && p === h) {
    return "Syncing your whole home folder is not supported - pick a folder inside it (like Documents or Downloads).";
  }
  // /Users, /home, C:\Users: every account's home, keys and autostart
  // entries included. A pull into one of these writes into a home folder.
  if (h && h.startsWith(p + "/")) {
    return "Syncing a folder that contains your home folder is not supported - pick a folder inside it (like Documents or Downloads).";
  }
  const deny = [...(DENY[platform] ?? [])];
  if (platform === "darwin" && h) deny.push(h + "/Library");
  if (platform === "win32" && h) deny.push(h + "/AppData");
  for (const d of deny) {
    if (isOrInside(p, norm(d, ci))) {
      return `"${absPath}" is a system folder. Syncing it would upload operating-system files and can make the app unusable - pick a folder with your own files instead.`;
    }
  }
  if (h) {
    for (const name of CREDENTIAL_DIRS) {
      if (isOrInside(p, norm(`${h}/${name}`, ci))) {
        return `"${absPath}" holds keys, credentials or programs that start at login. Syncing it could expose them or let synced files run on this computer - pick a folder with your own documents instead.`;
      }
    }
  }
  return null;
}

/**
 * Folders under the home folder that hold credentials or autostart entries,
 * on every platform. Bounty (desktop 3.1.10): a script in the renderer pointed
 * a push pair at ~/.ssh to upload keys, and a pull pair at ~/.config to write
 * ~/.config/autostart/*.desktop and ~/.config/git/config, i.e. code execution
 * as the user. A sync root at or inside any of these is refused, however it
 * was chosen. ~/Library (LaunchAgents) and %APPDATA% (the Start Menu Startup
 * folder) are refused above as system folders; shell rc files live directly
 * in the home folder, which is refused on its own.
 */
const CREDENTIAL_DIRS = [
  ".ssh", ".gnupg", ".aws", ".azure", ".config", ".kube", ".docker", ".password-store",
  "Library/LaunchAgents",
];
