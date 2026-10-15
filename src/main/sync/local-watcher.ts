import chokidar, { type FSWatcher } from "chokidar";
import { EventEmitter } from "events";
import { CHOKIDAR_IGNORED, userPatternsToGlobs } from "./ignore-rules";

// The shared ignore rules live in ignore-rules.ts (electron-free so plain
// `node --test` can load them); re-exported here because the scanner and
// reconciler have always imported them from this module.
export { ignoreReason, shouldIgnoreEntry } from "./ignore-rules";

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
  private watcher: FSWatcher | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private maxWaitTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingEvents = new Map<string, WatchEvent>();
  /** Prevents EMFILE error from flooding the log. */
  private emfileWarned = false;
  /**
   * Set once the tree proved too large to watch (EMFILE). Live watching is
   * abandoned for this pair and the engine falls back to periodic rescans.
   * start() becomes a no-op so a later scan can't silently re-arm it.
   */
  private degraded = false;

  /** True when live watching was abandoned (tree too large). */
  isDegraded(): boolean {
    return this.degraded;
  }

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
    // Once degraded (tree too large to watch), never re-arm - a later scan
    // calling start() must not trigger another EMFILE storm.
    if (this.degraded) return;
    this.emfileWarned = false;
    this.startWatcher();
  }

  private startWatcher(): void {
    // Merge built-in ignores with user-configured patterns
    const ignored = [
      ...CHOKIDAR_IGNORED,
      ...userPatternsToGlobs(this.userExcludedPatterns),
    ];

    this.watcher = this.openWatcher(ignored);

    const handle = (type: WatchEvent["type"], path: string) => {
      this.pendingEvents.set(path, { type, path });
      this.scheduleBatch();
    };

    this.watcher.on("add", (p: string) => handle("add", p));
    this.watcher.on("change", (p: string) => handle("change", p));
    this.watcher.on("unlink", (p: string) => handle("unlink", p));
    this.watcher.on("addDir", (p: string) => handle("addDir", p));
    this.watcher.on("unlinkDir", (p: string) => handle("unlinkDir", p));
    this.watcher.on("error", (errUnknown: unknown) => {
      const err = errUnknown instanceof Error ? errUnknown : new Error(String(errUnknown));
      const isEmfile =
        (err as NodeJS.ErrnoException).code === "EMFILE" ||
        (err as NodeJS.ErrnoException).code === "ENOSPC" ||
        err.message?.includes("EMFILE");

      if (isEmfile) {
        // Guard on `degraded` (which is never reset), not `emfileWarned`
        // (which stop() clears). stop() is called immediately below, so a
        // subsequent EMFILE must not re-arm the warning/degraded spam.
        if (!this.degraded) {
          this.emfileWarned = true;
          this.degraded = true;
          // Abandon live watching for this tree. Polling would stat() every
          // path on every tick - on a 15k-directory tree that's thousands of
          // syscalls per second and murders CPU/battery. Periodic full
          // rescans (driven by the engine) are the right trade-off here:
          // a backup doesn't need sub-second change detection.
          console.warn(
            `[sync] EMFILE: "${this.localPath}" has too many directories to watch live. ` +
            `Switching to periodic rescans for this folder (no files are skipped).`,
          );
          // Not awaited: this handler stays synchronous on purpose. Chokidar
          // never awaits its "error" listeners, so making this one `async`
          // would just hand back a promise nothing ever looks at.
          //
          // `stop()` swallows a failed close itself (see its contract), so
          // this `.catch` is belt and braces, kept because an
          // unhandledRejection out of here would be fatal: the engine host
          // treats any of them as `process.exit(1)`.
          this.stop().catch((err) => {
            console.error(`[sync] LocalWatcher: stop() rejected after EMFILE for "${this.localPath}":`, err);
          });
          this.emit("degraded", "emfile");
        }
        return; // suppress repeated EMFILE noise
      }
      this.emit("error", err);
    });
  }

  /**
   * Opens the chokidar watcher. This is the one seam the class has:
   * `local-watcher.test.ts` subclasses and overrides it to hand back a
   * watcher whose `close()` rejects, which is the case `stop()`'s contract
   * below is about and which a real watcher will not reproduce on demand.
   */
  protected openWatcher(ignored: string[]): FSWatcher {
    return chokidar.watch(this.localPath, {
      ignoreInitial: true,
      ignored,
      persistent: true,
      followSymlinks: false,
      // NOTE: chokidar v4 REMOVED fsevents (its only dep is readdirp), so on
      // every platform it opens one fd per directory. A big tree (a Gradle
      // cache can be ~15k dirs) exhausts the process fd limit → EMFILE.
      // We do NOT fall back to chokidar polling: that stat()s every watched
      // path each tick (~27k paths / 2s = thousands of syscalls per second),
      // which is far worse than the problem. See the EMFILE handler below.
      // awaitWriteFinish DISABLED - it allocates a stat-polling interval for
      // every file event (100K files = 100K timers + cached Stats = GBs of RAM).
      // Instead we rely on our debounce + maxWait batching in scheduleBatch().
      // The stabilityThreshold was 2s anyway which our 1-2s debounce already covers.
      depth: 50,
    });
  }

  /**
   * Closes the underlying chokidar watcher and waits for it (OBS-2):
   * chokidar v4 opens one fd per watched directory, and close() releasing
   * them is itself async. start() refuses to re-arm while `this.watcher` is
   * set, so a caller that doesn't await this before calling start() again
   * can end up holding two live fd sets for the same tree - the exact
   * condition the EMFILE handling above exists for.
   *
   * **This never rejects, and callers depend on that.** The close CAN fail -
   * the EMFILE path above is precisely where another fs call is most likely
   * to hit a resource limit too - and it used to propagate, which was worse
   * than the failure it reported in three separate ways:
   *
   *  - `this.watcher` was left set, so `start()` early-returned for the rest
   *    of the session: live watching for that pair was silently off, and
   *    `emfileWarned` stayed true so further EMFILE errors were suppressed.
   *  - every awaiting caller abandoned the rest of its own state transition.
   *    `pauseForRateLimit` never armed its resume timer (the folder never
   *    synced again); `stopPair` skipped `releaseFolderAccess()`, leaking a
   *    macOS security-scoped bookmark, and left the runtime and poller alive;
   *    `holdPendingDeletion` skipped the `emitStatus()` that puts the
   *    mass-deletion prompt on screen.
   *  - in `runInitialScan` the await sits inside a try whose catch handles
   *    only SESSION_EXPIRED and rate limits, so a rejection fell THROUGH to
   *    `rt.syncing = true` and ran a full scan-and-upload against a folder
   *    the server had just said was no longer synced.
   *
   * None of those is an acceptable price for reporting a failed close, so the
   * error is logged whole (its `code`/`syscall` are the diagnostic) and the
   * state is reset either way. If the fds really did not come back, they were
   * not coming back whichever way this returned.
   */
  async stop(): Promise<void> {
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.maxWaitTimer) clearTimeout(this.maxWaitTimer);
    try {
      await this.watcher?.close();
    } catch (err) {
      console.error(`[sync] LocalWatcher: close failed for "${this.localPath}":`, err);
    } finally {
      this.watcher = null;
      this.pendingEvents.clear();
      this.emfileWarned = false;
    }
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
    // Only set once per batch - don't reset on every event.
    if (!this.maxWaitTimer) {
      this.maxWaitTimer = setTimeout(() => this.flush(), this.maxWaitMs);
    }
  }
}
