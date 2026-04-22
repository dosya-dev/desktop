import chokidar from "chokidar";
import { EventEmitter } from "events";
import { extname, basename } from "path";

// ── Shared ignore logic ─────────────────────────────────────────────
// Exported so the initial scanner, reconciler, and watcher all use the
// same rules.  When you add an entry here, also add the corresponding
// chokidar glob pattern below.

const IGNORED_NAMES = new Set([
  ".DS_Store", "Thumbs.db", "desktop.ini",
]);

const IGNORED_DIRS = new Set([
  "node_modules", ".git", ".Trash", "$RECYCLE.BIN",
  "__pycache__", ".venv", ".svn", ".hg",
]);

const IGNORED_EXTENSIONS = new Set([
  ".tmp", ".crdownload", ".part", ".swp", ".swo",
]);

const IGNORED_PREFIXES = ["~$", ".~lock."];

/**
 * Returns true if a file or directory should be excluded from sync.
 * Exported for use by the initial scan walk and the reconciler.
 *
 * @param name         The file/directory name (not path)
 * @param isDirectory  Whether the entry is a directory
 * @param userPatterns Optional user-configured exclude patterns from the sync pair
 */
export function shouldIgnoreEntry(
  name: string,
  isDirectory: boolean,
  userPatterns?: string[],
): boolean {
  // Built-in ignores
  if (IGNORED_NAMES.has(name)) return true;
  if (name.startsWith(".dosya-sync-")) return true;
  if (isDirectory && IGNORED_DIRS.has(name)) return true;

  if (!isDirectory) {
    for (const prefix of IGNORED_PREFIXES) {
      if (name.startsWith(prefix)) return true;
    }
    if (name.endsWith("~")) return true;
    const ext = extname(name).toLowerCase();
    if (ext && IGNORED_EXTENSIONS.has(ext)) return true;
  }

  // User-configured patterns
  if (userPatterns && userPatterns.length > 0) {
    for (const pattern of userPatterns) {
      if (matchesUserPattern(name, isDirectory, pattern)) return true;
    }
  }

  return false;
}

/**
 * Simple pattern matcher for user-configured exclude patterns.
 * Supports: exact names ("node_modules"), dotfiles (".env"),
 * wildcard extensions ("*.log"), and prefix wildcards ("*.min.*").
 * No external dependency needed.
 */
function matchesUserPattern(name: string, isDirectory: boolean, pattern: string): boolean {
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
function userPatternsToGlobs(patterns: string[]): string[] {
  const globs: string[] = [];
  for (const p of patterns) {
    if (p.startsWith("*.")) {
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

/** Chokidar glob patterns — must match shouldIgnoreEntry semantics. */
const CHOKIDAR_IGNORED = [
  // OS metadata
  "**/.DS_Store",
  "**/Thumbs.db",
  "**/desktop.ini",
  // Temp / partial downloads
  "**/*.tmp",
  "**/*.crdownload",
  "**/*.part",
  // Internal temp files
  "**/.dosya-sync-*",
  // Large dependency / VCS trees
  "**/node_modules/**",
  "**/.git/**",
  "**/.Trash/**",
  "**/$RECYCLE.BIN/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/.svn/**",
  "**/.hg/**",
  // Office / LibreOffice lock files
  "**/~$*",
  "**/.~lock.*",
  // Editor swap / backup files
  "**/*.swp",
  "**/*.swo",
  "**/*~",
];

// ── Watcher ─────────────────────────────────────────────────────────

export type WatchEvent =
  | { type: "add"; path: string }
  | { type: "change"; path: string }
  | { type: "unlink"; path: string }
  | { type: "addDir"; path: string }
  | { type: "unlinkDir"; path: string };

/** Maximum pending events before force-flushing to prevent unbounded memory growth. */
const MAX_PENDING_EVENTS = 50_000;

export class LocalWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvents = new Map<string, WatchEvent>();
  /** Prevents EMFILE error from flooding the log. */
  private emfileWarned = false;
  /** True if we fell back to polling mode after an EMFILE error. */
  private usingPollingFallback = false;

  constructor(
    private localPath: string,
    private debounceMs = 1000,
    private maxWaitMs = 5000,
    private userExcludedPatterns: string[] = [],
  ) {
    super();
  }

  isWatching(): boolean {
    return this.watcher !== null;
  }

  start(): void {
    if (this.watcher) return;
    this.emfileWarned = false;
    this.startWatcher(false);
  }

  private startWatcher(usePolling: boolean): void {
    this.usingPollingFallback = usePolling;

    // Merge built-in ignores with user-configured patterns
    const ignored = [
      ...CHOKIDAR_IGNORED,
      ...userPatternsToGlobs(this.userExcludedPatterns),
    ];

    this.watcher = chokidar.watch(this.localPath, {
      ignoreInitial: true,
      ignored,
      persistent: true,
      followSymlinks: false,
      // macOS: chokidar v4 auto-uses fsevents (single fd for entire tree).
      // Linux: uses inotify (one watch per dir — can hit EMFILE on large trees).
      // Windows: uses ReadDirectoryChangesW (recursive, no fd issue).
      // Polling fallback: uses setInterval instead of OS watchers.
      // Slower (checks every 2s) but never hits fd limits.
      ...(usePolling ? { usePolling: true, interval: 2000 } : {}),
      // awaitWriteFinish DISABLED — it allocates a stat-polling interval for
      // every file event (100K files = 100K timers + cached Stats = GBs of RAM).
      // Instead we rely on our debounce + maxWait batching in scheduleBatch().
      // The stabilityThreshold was 2s anyway which our 1-2s debounce already covers.
      depth: 50,
    });

    const handle = (type: WatchEvent["type"], path: string) => {
      this.pendingEvents.set(path, { type, path });
      this.scheduleBatch();
    };

    this.watcher.on("add", (p: string) => handle("add", p));
    this.watcher.on("change", (p: string) => handle("change", p));
    this.watcher.on("unlink", (p: string) => handle("unlink", p));
    this.watcher.on("addDir", (p: string) => handle("addDir", p));
    this.watcher.on("unlinkDir", (p: string) => handle("unlinkDir", p));
    this.watcher.on("error", (err: Error) => {
      const isEmfile =
        (err as NodeJS.ErrnoException).code === "EMFILE" ||
        (err as NodeJS.ErrnoException).code === "ENOSPC" ||
        err.message?.includes("EMFILE");

      if (isEmfile) {
        if (!this.emfileWarned) {
          this.emfileWarned = true;

          // If not already on polling, restart with polling fallback
          if (!this.usingPollingFallback) {
            console.warn(
              `[sync] EMFILE: too many open files watching "${this.localPath}". ` +
              `Falling back to polling mode (2s interval). ` +
              `To fix: increase fs.inotify.max_user_watches on Linux or ulimit -n on macOS.`
            );
            // Close the broken watcher and restart with polling
            this.watcher?.close();
            this.watcher = null;
            this.startWatcher(true);
            return;
          }

          // Already on polling — should not happen, but emit once
          console.error(`[sync] EMFILE even in polling mode for "${this.localPath}"`);
          this.emit("error", err);
        }
        return; // suppress repeated EMFILE noise
      }
      this.emit("error", err);
    });

    if (usePolling) {
      console.log(`[sync] Watcher started in polling mode for "${this.localPath}"`);
    }
  }

  stop(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.watcher?.close();
    this.watcher = null;
    this.pendingEvents.clear();
    this.emfileWarned = false;
  }

  private flush(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    this.debounceTimer = null;
    this.maxWaitTimer = null;

    const events = Array.from(this.pendingEvents.values());
    this.pendingEvents.clear();
    if (events.length > 0) {
      this.emit("batch", events);
    }
  }

  private scheduleBatch(): void {
    // Force-flush if pending events exceed the cap to prevent unbounded memory growth
    if (this.pendingEvents.size >= MAX_PENDING_EVENTS) {
      this.flush();
      return;
    }

    // Reset debounce timer on every new event
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    this.debounceTimer = setTimeout(() => this.flush(), this.debounceMs);

    // Max-wait timer: flush after maxWaitMs regardless of new events.
    // Only set once per batch — don't reset on every event.
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.flush(), this.maxWaitMs);
    }
  }
}
