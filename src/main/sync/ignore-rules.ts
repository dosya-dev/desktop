// ── Shared ignore logic ─────────────────────────────────────────────
// One module, three consumers: the initial scanner, the reconciler, and the
// chokidar watcher all use these rules, so an entry is either synced
// everywhere or skipped everywhere. Kept free of electron/chokidar imports
// and TS-parameter-property syntax so plain `node --test` can load it.
//
// The engine hard-codes ONLY what is technical or a security boundary, not a
// preference: its own temp markers, transient editor/office artifacts,
// virtual filesystems, and Git metadata (see PROTECTED_NAMES). Everything a
// user could legitimately want synced - node_modules, /bin, *.log - lives in
// the pair's excludedPatterns,
// which the sync-pair modal seeds with visible, removable defaults
// (SyncPage.tsx DEFAULT_EXCLUDED). The engine used to also hard-code those
// names invisibly, which (a) silently dropped /usr/bin-style folders because
// the match was name-anywhere, and (b) made the modal's chips a lie: deleting
// "node_modules" there changed nothing.

/**
 * Virtual filesystems, matched on the ABSOLUTE path so only the real mount
 * points are affected. Not a preference: entries there report bogus TB+
 * sizes, and reading some (e.g. /proc/kmsg) blocks forever, hanging the
 * hashing pipeline. The sync-pair modal states these are always skipped.
 */
const VIRTUAL_FS_ROOTS = new Set(["/proc", "/sys", "/dev", "/run"]);

/** Transient editor/office artifacts (Office/LibreOffice locks, backups). */
const IGNORED_PREFIXES = ["~$", ".~lock."];

/**
 * AppleDouble sidecars: macOS writes "._name" beside every file on volumes
 * that cannot hold extended attributes (SMB, FAT, exFAT, many USB sticks).
 * They are metadata about the user's file, not the file - syncing them
 * scatters unreadable 4 KB files across every other device and they change
 * on every Finder touch. Files only; a folder named "._x" is a real folder.
 */
const APPLEDOUBLE_PREFIX = "._";

/**
 * Names sync never creates, replaces, moves into, deletes, or uploads, in
 * any mode and whatever the pair's excludes say. A `.git` directory holds
 * hooks Git runs on the next commit, and a `.git` FILE redirects Git to
 * another metadata directory, so a workspace member who could place either
 * under someone's sync root could run code on their machine. The ".git"
 * chip in the sync-pair modal used to be the only guard, and removing it (or
 * a remote pass that never consulted it) wrote a remote
 * `.git/hooks/pre-commit` into a local repository (bounty 2026-11-07,
 * recheck 2026-11-11). Compared through foldName, so `.GIT`, an NFD
 * spelling, or a name padded with characters a filesystem ignores all count.
 */
const PROTECTED_NAMES = new Set([".git"]);

/**
 * Characters some filesystems drop when comparing names (HFS+ ignores
 * several zero-width and bidi controls). Stripped before a protected-name
 * comparison so `.g\u200Bit` cannot stand in for `.git`.
 */
const IGNORABLE_CHARS = /[\u00AD\u034F\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

/**
 * Comparison key for a name on a case-folding filesystem: NFC, then upper
 * and back to lower, so letters whose lower case is not the folded form
 * (U+017F long s, U+212A Kelvin sign) meet their ASCII twins the way APFS and
 * NTFS treat them. Over-matching is the safe direction for an exclude.
 */
export function foldName(name: string): string {
  return name.normalize("NFC").toUpperCase().toLowerCase().normalize("NFC");
}

/** True when `name` is, or is an alias of, a name sync never touches. */
export function isProtectedName(name: string): boolean {
  return PROTECTED_NAMES.has(foldName(name.replace(IGNORABLE_CHARS, "")));
}

/** True when any segment of a forward- or back-slash relative path is protected. */
export function hasProtectedSegment(relPath: string): boolean {
  return relPath.split(/[\\/]/).some((segment) => segment.length > 0 && isProtectedName(segment));
}

/**
 * Why a remote-supplied path segment cannot be written safely on Windows, or
 * null. Windows resolves several spellings to a different file than the one
 * named: `GIT~1` is the 8.3 short alias of `.git`, a trailing dot or space is
 * stripped (`.git.` is `.git`), `name:stream` addresses an alternate data
 * stream, and CON/NUL/COM1... open devices whatever the extension. None of
 * them is a name a remote file can be given safely, so they are refused
 * (skipped with an error), never written. Other platforms return null:
 * those spellings are ordinary distinct names there.
 */
export function windowsUnsafeSegment(segment: string, platform: string = process.platform): string | null {
  if (platform !== "win32") return null;
  if (/[<>:"|?*]/.test(segment)) return "contains a character Windows reserves (< > : \" | ? *)";
  if (/[. ]$/.test(segment)) return "ends with a dot or a space, which Windows strips";
  const dot = segment.indexOf(".");
  const base = dot === -1 ? segment : segment.slice(0, dot);
  const ext = dot === -1 ? "" : segment.slice(dot + 1);
  if (/~\d+$/.test(base) && base.length <= 8 && ext.length <= 3 && !ext.includes(".")) {
    return "looks like a Windows short (8.3) name, which can stand for a different file";
  }
  if (/^(con|prn|aux|nul|conin\$|conout\$|com[0-9\u00B9\u00B2\u00B3]|lpt[0-9\u00B9\u00B2\u00B3])$/i.test(base.trimEnd())) {
    return "is a reserved Windows device name";
  }
  return null;
}

/** First Windows-unsafe segment of a relative path, as a reason, or null. */
export function windowsUnsafePath(relPath: string, platform: string = process.platform): string | null {
  if (platform !== "win32") return null;
  for (const segment of relPath.split(/[\\/]/)) {
    if (!segment) continue;
    const reason = windowsUnsafeSegment(segment, platform);
    if (reason) return `"${segment}" ${reason}`;
  }
  return null;
}

/**
 * Why an entry is excluded from sync, or null if it isn't.
 * Exported for the scanner so skips can be logged to the Activity tab with
 * their cause; shouldIgnoreEntry below is the boolean form.
 *
 * @param name         The file/directory name (not path)
 * @param isDirectory  Whether the entry is a directory
 * @param userPatterns User-configured exclude patterns from the sync pair
 * @param absPath      Absolute path; enables "/bin"-style anchored patterns
 *                     and the virtual-filesystem guard
 */
export function ignoreReason(
  name: string,
  isDirectory: boolean,
  userPatterns?: string[],
  absPath?: string,
  /** Compare names case-insensitively (macOS/Windows filesystems fold case). */
  foldCase = false,
): string | null {
  // Our own temp/partial-download files. downloadToFile writes them as a
  // SUFFIX ("photo.jpg.dosya-sync-tmp"), so a prefix-only check misses them
  // and the watcher would hash/upload the growing temp as a user file. Match
  // the marker as an infix (covers both prefix and suffix placements).
  if (name.includes(".dosya-sync-")) return "internal temp file";

  // Files and folders alike: a `.git` file points Git at another directory.
  if (isProtectedName(name)) return "Git metadata (never synced)";

  if (!isDirectory) {
    for (const prefix of IGNORED_PREFIXES) {
      if (name.startsWith(prefix)) return "transient lock file";
    }
    if (name.endsWith("~")) return "editor backup file";
    if (name.startsWith(APPLEDOUBLE_PREFIX)) return "AppleDouble metadata file";
  }

  if (isDirectory && absPath && VIRTUAL_FS_ROOTS.has(normalizeAbs(absPath))) {
    return "virtual filesystem (always skipped)";
  }

  // User-configured patterns
  if (userPatterns && userPatterns.length > 0) {
    for (const pattern of userPatterns) {
      // NFC on both sides always (macOS hands back NFD names); full case
      // folding where the filesystem folds, so an alias spelling the
      // filesystem treats as the same entry cannot slip past an exclude.
      if (matchesUserPattern(
        foldCase ? foldName(name) : name.normalize("NFC"), isDirectory,
        pattern.startsWith("/") ? pattern : (foldCase ? foldName(pattern) : pattern.normalize("NFC")), absPath,
      )) {
        return `excluded by pattern "${pattern}"`;
      }
    }
  }

  return null;
}

/**
 * Returns true if a file or directory should be excluded from sync.
 * Exported for use by the initial scan walk and the reconciler.
 */
export function shouldIgnoreEntry(
  name: string,
  isDirectory: boolean,
  userPatterns?: string[],
  absPath?: string,
  foldCase = false,
): boolean {
  return ignoreReason(name, isDirectory, userPatterns, absPath, foldCase) !== null;
}

/**
 * Whether a REMOTE path, placed under the local root, lands on something the
 * pair ignores. Every segment is judged, so a remote `.git/hooks/pre-commit`
 * is caught by a `.git` exclude the same way the local walk never descends
 * into `.git`. The local scan only ever filtered what it found on disk; the
 * remote side was never asked, so a workspace member could create
 * `.git/hooks/pre-commit` and sync wrote it into the excluded local `.git`
 * (bounty 2026-11-07). `foldCase` must be on where the filesystem folds case,
 * or `.GIT/...` walks into `.git` anyway.
 */
export function isRemotePathIgnored(
  relPath: string,
  isDirectory: boolean,
  userPatterns: string[] | undefined,
  localRoot: string,
  foldCase: boolean,
): boolean {
  const segments = relPath.split("/").filter(Boolean);
  let abs = localRoot.replace(/[\\/]+$/, "");
  for (let i = 0; i < segments.length; i++) {
    abs = `${abs}/${segments[i]}`;
    const segIsDir = i < segments.length - 1 || isDirectory;
    if (shouldIgnoreEntry(segments[i], segIsDir, userPatterns, abs, foldCase)) return true;
  }
  return false;
}

/** Forward slashes, no trailing slash - so "/proc/" and "\proc" both compare. */
function normalizeAbs(p: string): string {
  const s = p.replace(/\\/g, "/");
  return s.length > 1 && s.endsWith("/") ? s.slice(0, -1) : s;
}

/**
 * Simple pattern matcher for user-configured exclude patterns.
 * Supports: exact names ("node_modules"), dotfiles (".env"),
 * wildcard extensions ("*.log"), prefix wildcards ("*.min.*"), and
 * absolute paths ("/bin"). No external dependency needed.
 */
function matchesUserPattern(name: string, isDirectory: boolean, pattern: string, absPath?: string): boolean {
  // Absolute-path match (e.g. "/bin", "/usr/local"): anchored to the entry's
  // full path, so the system-directory defaults only fire at the filesystem
  // root - a project's own bin/ or lib/ folder never matches. Matching the
  // directory itself is enough to skip its whole subtree (the walk never
  // descends into it).
  if (pattern.startsWith("/")) {
    return absPath !== undefined && normalizeAbs(absPath) === normalizeAbs(pattern);
  }

  // Exact name match (e.g. "node_modules", ".env", ".env.local")
  if (name === pattern) return true;

  // Wildcard extension match (e.g. "*.log", "*.tmp")
  if (pattern.startsWith("*.")) {
    const suffix = pattern.slice(1); // ".log"
    if (name.endsWith(suffix)) return true;
  }

  // Wildcard prefix match (e.g. "test_*")
  if (pattern.endsWith("*") && !pattern.startsWith("*")) {
    const prefix = pattern.slice(0, -1);
    if (name.startsWith(prefix)) return true;
  }

  return false;
}

/**
 * Convert user patterns to chokidar-compatible glob patterns.
 */
export function userPatternsToGlobs(patterns: string[]): string[] {
  const globs: string[] = [];
  for (const p of patterns) {
    if (p.startsWith("/")) {
      // Absolute path: "/bin" → itself and its subtree. Chokidar compares
      // against absolute watched paths, so this anchors exactly like
      // matchesUserPattern's absolute branch.
      const abs = p.length > 1 && p.endsWith("/") ? p.slice(0, -1) : p;
      globs.push(abs);
      globs.push(`${abs}/**`);
    } else if (p.startsWith("*.")) {
      // Wildcard extension: "*.log" → "**/*.log"
      globs.push(`**/${p}`);
    } else if (p.includes("*")) {
      // Other wildcards: pass through with prefix
      globs.push(`**/${p}`);
    } else if (p.startsWith(".")) {
      // Dotfiles/dirs: ".env" → "**/.env", ".env.local" → "**/.env.local"
      globs.push(`**/${p}`);
    } else {
      // Directory/file names: "node_modules" → "**/{name}" and "**/{name}/**"
      globs.push(`**/${p}`);
      globs.push(`**/${p}/**`);
    }
  }
  return globs;
}

/**
 * Chokidar glob patterns - must match shouldIgnoreEntry's TECHNICAL rules
 * only. Preference ignores (node_modules, *.tmp, /bin, ...) come from the
 * pair's excludedPatterns via userPatternsToGlobs, so the watcher and the
 * scanner read the same single source of truth.
 */
export const CHOKIDAR_IGNORED = [
  // Internal temp files. Match the marker anywhere in the basename: downloads
  // are written as a SUFFIX ("photo.jpg.dosya-sync-tmp"), which the leading-dot
  // glob alone would not catch.
  "**/.dosya-sync-*",
  "**/*.dosya-sync-*",
  // Office / LibreOffice lock files
  "**/~$*",
  "**/.~lock.*",
  // Editor backup files
  "**/*~",
  // Git metadata (see PROTECTED_NAMES). Globs are case-sensitive, so the
  // event handler re-checks every path segment with isProtectedName.
  "**/.git", "**/.git/**",
  // AppleDouble sidecars (see APPLEDOUBLE_PREFIX)
  "**/._*",
  // Virtual filesystems (see VIRTUAL_FS_ROOTS): absolute paths only ever
  // match when the watched root actually contains them.
  "/proc", "/proc/**", "/sys", "/sys/**", "/dev", "/dev/**", "/run", "/run/**",
];
