// ── Shared ignore logic ─────────────────────────────────────────────
// One module, three consumers: the initial scanner, the reconciler, and the
// chokidar watcher all use these rules, so an entry is either synced
// everywhere or skipped everywhere. Kept free of electron/chokidar imports
// and TS-parameter-property syntax so plain `node --test` can load it.
//
// The engine hard-codes ONLY what is technical, not a preference:
// its own temp markers, transient editor/office artifacts, and virtual
// filesystems. Everything a user could legitimately want synced -
// node_modules, .git, /bin, *.log - lives in the pair's excludedPatterns,
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
): string | null {
  // Our own temp/partial-download files. downloadToFile writes them as a
  // SUFFIX ("photo.jpg.dosya-sync-tmp"), so a prefix-only check misses them
  // and the watcher would hash/upload the growing temp as a user file. Match
  // the marker as an infix (covers both prefix and suffix placements).
  if (name.includes(".dosya-sync-")) return "internal temp file";

  if (!isDirectory) {
    for (const prefix of IGNORED_PREFIXES) {
      if (name.startsWith(prefix)) return "transient lock file";
    }
    if (name.endsWith("~")) return "editor backup file";
  }

  if (isDirectory && absPath && VIRTUAL_FS_ROOTS.has(normalizeAbs(absPath))) {
    return "virtual filesystem (always skipped)";
  }

  // User-configured patterns
  if (userPatterns && userPatterns.length > 0) {
    for (const pattern of userPatterns) {
      if (matchesUserPattern(name, isDirectory, pattern, absPath)) {
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
): boolean {
  return ignoreReason(name, isDirectory, userPatterns, absPath) !== null;
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
  // Virtual filesystems (see VIRTUAL_FS_ROOTS): absolute paths only ever
  // match when the watched root actually contains them.
  "/proc", "/proc/**", "/sys", "/sys/**", "/dev", "/dev/**", "/run", "/run/**",
];
