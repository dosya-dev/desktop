import { EventEmitter } from "events";
import { access, readdir, stat, statfs, unlink, mkdir } from "fs/promises";
import { join, resolve, sep, basename, dirname } from "path";
import { toRelPath, normalizeRel, pathKey, absKey, longPath } from "./paths";
import { loadConfig, saveConfig, loadPairState, savePairState, deletePairState } from "./config";
import { terminateStateWriter } from "./state-writer";
import { RemoteClient, RateLimitError } from "./remote-client";
import { LocalWatcher, type WatchEvent, shouldIgnoreEntry } from "./local-watcher";
import { RemotePoller, type RemoteSnapshot } from "./remote-poller";
import { reconcile, reconcileRemoteOnly } from "./reconciler";
import { hashFile } from "./hash";
import type {
  SyncConfig,
  SyncPair,
  SyncPairState,
  SyncStatus,
  SyncPairRuntimeStatus,
  SyncPairStatus,
  ActiveTransfer,
  SyncConflict,
  SyncAction,
  SyncMode,
  RemoteFileInfo,
} from "./types";

// ── Concurrency semaphore ───��───────────────────────────────────────

class Semaphore {
  private queue: (() => void)[] = [];
  private active = 0;
  constructor(private max: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active++;
      return;
    }
    return new Promise<void>((r) => this.queue.push(r));
  }

  release(): void {
    this.active--;
    const next = this.queue.shift();
    if (next) {
      this.active++;
      next();
    }
  }

  updateMax(newMax: number): void {
    this.max = newMax;
    while (this.active < this.max && this.queue.length > 0) {
      this.active++;
      this.queue.shift()!();
    }
  }
}

// ── Path index ──────────────────────────────────────────────────────
//
// localPath (relative) → remoteId, with O(1) lookup. Keys are normalized
// (NFC + case-folded on case-insensitive filesystems) via pathKey() so that
// macOS NFD/NFC differences and "Foo.txt"/"foo.txt" collisions map to a
// single entry — matching how the OS treats them on disk. The real,
// case/NFC-preserving path stays in the file record; this index only maps.
// Same API surface as Map so call sites are unchanged.
class PathIndex {
  private m = new Map<string, string>();
  set(relPath: string, remoteId: string): void { this.m.set(pathKey(relPath), remoteId); }
  get(relPath: string): string | undefined { return this.m.get(pathKey(relPath)); }
  delete(relPath: string): boolean { return this.m.delete(pathKey(relPath)); }
  clear(): void { this.m.clear(); }
  get size(): number { return this.m.size; }
}

// ── Constants ───────��────────────────────────────────���──────────────

const RECENT_DOWNLOAD_TTL_MS = 120_000; // suppress watcher events for 2 min after download (large files can take >10s)
const STATE_SAVE_INTERVAL = 500; // save state every N file operations
const SESSION_RECOVERY_MS = 30_000; // check for session recovery every 30s
const MAX_FILE_RETRIES = 5; // max retry attempts per persistently failing file
const TRANSFER_CONCURRENCY_CAP = 32; // never exceed the client's per-host socket pool
/** Rescan interval when live watching was abandoned (tree too big — EMFILE). */
const DEGRADED_RESCAN_MS = 10 * 60 * 1000;

// ── Runtime types ───���───────────────────────────────────────────────

interface PairRuntime {
  pair: SyncPair;
  state: SyncPairState;
  watcher: LocalWatcher | null;
  poller: RemotePoller | null;
  status: SyncPairStatus;
  errorMessage: string | null;
  syncing: boolean;
  queuedSync: boolean;
  /** Watcher events that arrived while a sync was in flight, deduped by path.
   *  Drained after the sync so deletes/moves aren't lost (a plain rescan
   *  only re-discovers additions). */
  queuedEvents: Map<string, WatchEvent>;
  /** Set when queuedEvents overflowed and we fell back to a full rescan. */
  queuedOverflow: boolean;
  /** O(1) lookup: localPath → remoteId (normalized keys — see PathIndex) */
  pathIndex: PathIndex;
  /** Timer for auto-resuming after rate limit pause */
  rateLimitResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Periodic rescan timer used when the watcher degraded (tree too large). */
  rescanTimer: ReturnType<typeof setInterval> | null;
  /** Total files in the current batch operation (scan/reconcile). 0 when idle. */
  totalFilesInBatch: number;
  /** Files completed so far in the current batch. */
  completedFilesInBatch: number;
  /** Total bytes across all files in the current batch. */
  totalBytesInBatch: number;
  /** Bytes completed so far in the current batch (finished files only). */
  completedBytesInBatch: number;
  /** When the current batch started (epoch ms). */
  batchStartedAt: number;
  /** Current sync phase. */
  phase: "scanning" | "transferring" | null;
  /** Files discovered so far during scan walk. */
  scannedFiles: number;
  /** Folders discovered so far during scan walk. */
  scannedFolders: number;
  /** Human-readable status text. */
  statusText: string;
  /** True if the watcher has detected local changes since the last reconcile. */
  localDirty: boolean;
  /** Timestamp of the last full local scan (for periodic consistency checks). */
  lastFullLocalScanAt: number;
  /** When the current sync cycle began (prep phases included). 0 when idle. */
  syncStartedAt: number;
  /** Last time this pair reported forward progress — drives the stall watchdog. */
  lastProgressAt: number;
  /** Throttle for periodic "still scanning/fetching…" progress logs. */
  lastProgressLogAt: number;
}

/**
 * Helper: check if an error is a rate limit error.
 */
function isRateLimitError(err: unknown): err is RateLimitError {
  return err instanceof RateLimitError || (err instanceof Error && err.message === "RATE_LIMITED");
}

function getRetryAfterMs(err: unknown): number {
  if (err instanceof RateLimitError) return err.retryAfterMs;
  return 60_000;
}

/**
 * SyncEngine — bidirectional sync engine for dosya.dev.
 *
 * Supports five sync modes:
 *   two-way    — reconciler-based three-way diff (watcher + poller + reconciler)
 *   push       — upload local changes, delete remote on local delete
 *   push-safe  — upload only, never delete remote (backup mode)
 *   pull       — download remote changes, delete local on remote delete
 *   pull-safe  — download only, never delete local
 */
export class SyncEngine extends EventEmitter {
  private config: SyncConfig | null = null;
  private client: RemoteClient;
  private runtimes = new Map<string, PairRuntime>();
  private activeTransfers = new Set<ActiveTransfer>();
  private started = false;
  private conflicts: SyncConflict[] = [];

  /** Paths recently written by download — watcher events for these are suppressed. */
  private recentDownloads = new Map<string, number>();

  /** Rolling log buffer (last 200 entries) — shown in the UI Activity tab. */
  private logs: import("./types").SyncLogEntry[] = [];
  private static readonly MAX_LOGS = 200;

  /** Limits concurrent uploads/downloads across all pairs. */
  private transferSemaphore: Semaphore;

  /** Periodic timer to recover pairs stuck in SESSION_EXPIRED or RATE_LIMITED error. */
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  /** Auto-resume timer for a timed ("snooze") pause. */
  private pauseResumeTimer: ReturnType<typeof setTimeout> | null = null;

  /** Periodic timer to evict stale entries from recentDownloads. */
  private recentDownloadsCleanupTimer: ReturnType<typeof setInterval> | null = null;

  /** Throttle emitStatus to avoid flooding IPC during large batch operations. */
  private statusTimer: ReturnType<typeof setTimeout> | null = null;
  private statusDirty = false;

  /** File IDs that need sync-flag set after a batch upload completes. */
  private pendingSyncFlagIds: string[] = [];

  /** Per-pair save lock to prevent concurrent writes to the same state file. */
  private saveLocks = new Set<string>();

  /** Pairs whose state changed while a save was in flight — re-saved on completion. */
  private saveDirty = new Set<string>();

  /**
   * Serializes config-mutating operations (add/remove/update pair).
   * Each of those does load → check → save, and `this.config` is shared
   * instance state. Without this lock two concurrent calls both load the same
   * config, both pass the overlap check, and both push — which is how exact
   * duplicate pairs ended up persisted and syncing the same folder twice.
   */
  private configOp: Promise<unknown> = Promise.resolve();
  private withConfigLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.configOp.then(fn, fn);
    this.configOp = run.catch(() => {});
    return run;
  }

  /**
   * Serializes engine lifecycle (start/stop). Login/logout cookie events can
   * fire in quick succession; without this a stop() racing an in-flight
   * start() would leak timers the start sets after stop cleared them, and
   * stop's runtimes.clear() could wipe pairs a newer start just created —
   * leaving sync half-running while logged out.
   */
  private lifecycleOp: Promise<unknown> = Promise.resolve();
  private withLifecycleLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lifecycleOp.then(fn, fn);
    this.lifecycleOp = run.catch(() => {});
    return run;
  }

  /**
   * Concurrency for lightweight direct-to-R2 transfers (presigned URLs).
   * Derived from the user's maxConcurrentTransfers setting, bounded by the
   * client socket pool so surplus workers don't just spin, and capped so
   * memory stays predictable (each in-flight transfer ≈ one 64KB stream).
   */
  private directTransferConcurrency(): number {
    const base = this.config?.maxConcurrentTransfers || 3;
    return Math.min(TRANSFER_CONCURRENCY_CAP, Math.max(6, base * 6));
  }

  private async safeSaveState(state: SyncPairState): Promise<void> {
    const key = state.pairId;
    // If a save is already in progress for this pair, don't drop this request:
    // the in-flight save snapshotted state at postMessage time (structured
    // clone in the writer worker) and won't include mutations made since. Mark
    // the pair dirty so the in-flight save re-runs once more when it finishes.
    if (this.saveLocks.has(key)) {
      this.saveDirty.add(key);
      return;
    }
    this.saveLocks.add(key);
    try {
      // Loop so a mutation that lands mid-save is flushed once more. Any number
      // of skipped saves during a single write coalesce into one follow-up.
      do {
        this.saveDirty.delete(key);
        try {
          await savePairState(state);
        } catch {
          // Swallow — state save should never break sync operations
        }
      } while (this.saveDirty.has(key));
    } finally {
      this.saveLocks.delete(key);
    }
  }

  constructor(private apiBase: string) {
    super();
    this.client = new RemoteClient(apiBase);
    this.transferSemaphore = new Semaphore(3);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    return this.withLifecycleLock(() => this.startLocked());
  }

  private async startLocked(): Promise<void> {
    if (this.started) return;

    // Don't start sync if user is not logged in.
    // The app should call start() again after login.
    // Cookie cache was cleared on the last stop(), so this read is fresh.
    const hasSession = await this.client.hasSession();
    if (!hasSession) {
      console.log("[sync] No session cookie found — sync engine will not start until login.");
      return;
    }

    this.started = true;
    this.config = await loadConfig();
    this.transferSemaphore.updateMax(this.config.maxConcurrentTransfers || 3);
    this.client.setBandwidthLimits(this.config.maxUploadBytesPerSec || 0, this.config.maxDownloadBytesPerSec || 0);

    // Detect account switch: fetch current user ID and compare to stored config.
    // If the user changed (logout → login with different account), all sync state
    // is stale and must be wiped to prevent cross-account data leakage.
    try {
      const currentUserId = await this.client.getCurrentUserId();
      if (currentUserId) {
        if (this.config.userId && this.config.userId !== currentUserId) {
          console.log(`[sync] Account switch detected (${this.config.userId} → ${currentUserId}). Wiping sync state.`);
          // Delete all pair state files
          for (const pair of this.config.pairs) {
            await deletePairState(pair.id);
          }
          // Reset config but keep structure, then fall through with the
          // emptied pair list: the engine must stay started so pairs the new
          // account adds can start immediately (startPair requires started).
          this.config.pairs = [];
          this.config.userId = currentUserId;
          await saveConfig(this.config);
        }
        // Store user ID if not set yet
        if (!this.config.userId) {
          this.config.userId = currentUserId;
          await saveConfig(this.config);
        }
      }
    } catch {
      // API call failed — continue with existing config (user might be offline)
    }

    // Start session recovery loop
    this.recoveryTimer = setInterval(() => this.checkRecovery(), SESSION_RECOVERY_MS);

    // Periodically evict stale entries from recentDownloads to prevent unbounded growth
    this.recentDownloadsCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [path, ts] of this.recentDownloads) {
        if (now - ts > RECENT_DOWNLOAD_TTL_MS) this.recentDownloads.delete(path);
      }
    }, 5 * 60 * 1000); // every 5 minutes

    for (const pair of this.config.pairs) {
      if (pair.enabled && !this.config.pausedGlobally) {
        await this.startPair(pair);
      }
    }
  }

  async stop(): Promise<void> {
    return this.withLifecycleLock(() => this.stopLocked());
  }

  private async stopLocked(): Promise<void> {
    this.started = false;
    // Drop the cached session cookie so hasSession() doesn't report a stale
    // positive right after logout (the cache only stores present cookies).
    this.client.clearCookieCache();
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    if (this.pauseResumeTimer) {
      clearTimeout(this.pauseResumeTimer);
      this.pauseResumeTimer = null;
    }
    if (this.recentDownloadsCleanupTimer) {
      clearInterval(this.recentDownloadsCleanupTimer);
      this.recentDownloadsCleanupTimer = null;
    }
    if (this.statusTimer) {
      clearTimeout(this.statusTimer);
      this.statusTimer = null;
      this.statusDirty = false;
    }

    // Phase 1: Signal all pairs to stop. In-flight workers check rt.status
    // and this.stopped — both must be set before we do anything destructive.
    for (const [, rt] of this.runtimes) {
      rt.watcher?.removeAllListeners();
      rt.watcher?.stop();
      rt.poller?.removeAllListeners();
      rt.poller?.stop();
      if (rt.rateLimitResumeTimer) clearTimeout(rt.rateLimitResumeTimer);
      if (rt.rescanTimer) { clearInterval(rt.rescanTimer); rt.rescanTimer = null; }
      rt.status = "paused";
      rt.syncing = false;
    }

    // Phase 2: Let the event loop tick so in-flight workers see the paused
    // status and bail out before we save state and clear runtimes.
    await new Promise<void>(r => setTimeout(r, 100));

    // Phase 3: Persist state with a hard timeout.
    // If any state save hangs (disk I/O stall, full disk, network drive),
    // we abandon after 4s to avoid blocking shutdown indefinitely.
    const SAVE_TIMEOUT_MS = 4000;
    const saveAll = Promise.all(
      Array.from(this.runtimes.values()).map((rt) =>
        this.safeSaveState(rt.state).catch(() => {}),
      ),
    );
    await Promise.race([
      saveAll,
      new Promise<void>((r) => setTimeout(r, SAVE_TIMEOUT_MS)),
    ]);

    this.runtimes.clear();
    this.activeTransfers.clear();
    this.conflicts = [];
    this.pendingSyncFlagIds = [];
    this.recentDownloads.clear();
    terminateStateWriter();
    try { this.emitStatus(); } catch {}
  }

  /** Check if engine is stopped. In-flight operations should bail out when true. */
  private get stopped(): boolean {
    return !this.started;
  }

  // ── Session & rate-limit recovery ────────────────────────────────

  private async checkRecovery(): Promise<void> {
    for (const [pairId, rt] of this.runtimes) {
      // Stall watchdog: a pair that's been syncing without any forward progress
      // for a while is either on a genuinely slow operation or wedged. Either
      // way, say so in the Activity log instead of showing a silent spinner —
      // this is what turns "it just sat at Starting initial sync" from a
      // mystery into a visible, timestamped signal.
      const STALL_MS = 90_000;
      if (rt.syncing && rt.lastProgressAt && Date.now() - rt.lastProgressAt > STALL_MS) {
        const secs = Math.round((Date.now() - (rt.syncStartedAt || rt.lastProgressAt)) / 1000);
        this.log(pairId, `Still working: ${rt.statusText || "syncing"} — ${secs}s elapsed, no new progress yet`);
        rt.lastProgressAt = Date.now(); // reset so we log at most once per interval
      }

      // Recover from session expiry
      if (rt.status === "error" && rt.errorMessage?.includes("Session expired")) {
        try {
          this.client.clearCookieCache();
          await this.client.getWorkspaceRegion(rt.pair.workspaceId);
          console.log("[sync] Session recovered for pair:", pairId);
          rt.status = "idle";
          rt.errorMessage = null;
          rt.watcher?.start();
          rt.poller?.start();
          this.emitStatus();
          const mode = rt.pair.syncMode || "push-safe";
          if (["two-way", "push", "push-safe"].includes(mode)) {
            this.runInitialScan(pairId);
          }
        } catch {
          // Still expired — will retry next interval
        }
      }
      // Note: rate-limited pairs are recovered via their own setTimeout timers,
      // not via this periodic check. This ensures exact Retry-After timing.
    }
  }

  // ── Rate limit handling helpers ──────────────────────────────────

  /**
   * Pause a pair due to rate limiting and schedule automatic resume.
   * The pair's watcher and poller are stopped to prevent further requests.
   */
  private pauseForRateLimit(rt: PairRuntime, retryAfterMs: number): void {
    // Clear any existing rate limit timer
    if (rt.rateLimitResumeTimer) {
      clearTimeout(rt.rateLimitResumeTimer);
      rt.rateLimitResumeTimer = null;
    }

    const resumeInSec = Math.ceil(retryAfterMs / 1000);
    rt.status = "rate-limited";
    rt.errorMessage = `Rate limit reached. Resuming in ${resumeInSec}s.`;
    rt.watcher?.stop();
    rt.poller?.stop();
    rt.syncing = false;
    this.emitStatus();
    console.log(`[sync] Pair ${rt.pair.id} rate-limited. Will resume in ${resumeInSec}s`);

    // Schedule automatic resume
    rt.rateLimitResumeTimer = setTimeout(() => {
      rt.rateLimitResumeTimer = null;
      if (rt.status !== "rate-limited") return; // was manually resumed/stopped
      console.log(`[sync] Pair ${rt.pair.id} rate limit expired, resuming`);
      rt.status = "idle";
      rt.errorMessage = null;
      rt.watcher?.start();
      rt.poller?.start();
      this.emitStatus();
      const mode = rt.pair.syncMode || "push-safe";
      if (["two-way", "push", "push-safe"].includes(mode)) {
        this.runInitialScan(rt.pair.id);
      }
    }, retryAfterMs + 1000); // +1s buffer
  }

  // ── Error helpers ──────────────────────────────────────────────────

  /**
   * Set a pair to error state, but only if it wasn't intentionally paused or stopped.
   * When the user pauses mid-sync, in-flight operations fail — those errors should
   * be silently discarded, not shown as sync failures.
   */
  private setError(rt: PairRuntime, message: string): void {
    if (this.stopped || rt.status === "paused" || rt.status === "rate-limited") return;
    rt.status = "error";
    rt.errorMessage = message;
  }

  // ── Progress reporting (visibility for long/silent phases) ─────────

  /** Mark the start of a sync cycle so elapsed time and the stall watchdog
   *  have a baseline. Called from every entry point that sets syncing = true. */
  private beginSyncCycle(rt: PairRuntime): void {
    const now = Date.now();
    rt.syncStartedAt = now;
    rt.lastProgressAt = now;
    rt.lastProgressLogAt = now;
  }

  /** Record forward progress. Updates the watchdog timestamp and, throttled,
   *  emits a human-readable line to the Activity log so long prep phases
   *  (remote snapshot fetch, local scan) aren't a silent black box. */
  private markProgress(rt: PairRuntime, logMessage?: string, throttleMs = 3000): void {
    const now = Date.now();
    rt.lastProgressAt = now;
    if (logMessage && now - rt.lastProgressLogAt >= throttleMs) {
      rt.lastProgressLogAt = now;
      this.log(rt.pair.id, logMessage);
    }
  }

  // ── Path safety ───────────────────────────────────────────────────

  /**
   * Returns true if relPath resolves inside syncRoot.
   * Prevents path traversal attacks from malicious remote file names.
   */
  private isPathSafe(syncRoot: string, relPath: string): boolean {
    const resolved = resolve(syncRoot, relPath);
    const normalizedRoot = resolve(syncRoot);
    return resolved === normalizedRoot || resolved.startsWith(normalizedRoot + sep);
  }

  // ── Path index helpers (O(1) lookups) ─────────────────────────────

  private rebuildPathIndex(rt: PairRuntime): void {
    rt.pathIndex.clear();
    for (const [remoteId, record] of Object.entries(rt.state.files)) {
      rt.pathIndex.set(record.localPath, remoteId);
    }
  }

  private lookupByPath(rt: PairRuntime, relPath: string): { remoteId: string; record: import("./types").SyncFileRecord } | undefined {
    const remoteId = rt.pathIndex.get(relPath);
    if (!remoteId) return undefined;
    const record = rt.state.files[remoteId];
    return record ? { remoteId, record } : undefined;
  }

  // ── Recent download tracking (prevents re-upload loop) ────────────

  private markRecentDownload(absPath: string): void {
    this.recentDownloads.set(absKey(absPath), Date.now());
  }

  private isRecentDownload(absPath: string): boolean {
    const key = absKey(absPath);
    const ts = this.recentDownloads.get(key);
    if (!ts) return false;
    if (Date.now() - ts > RECENT_DOWNLOAD_TTL_MS) {
      this.recentDownloads.delete(key);
      return false;
    }
    return true;
  }

  // ── Start / stop pairs ────────────────────────────────────────────

  private async startPair(pair: SyncPair): Promise<void> {
    // Sync must only run while logged in. The engine is only started with a
    // session present, and every path that spins up watchers/pollers/scans
    // funnels through here — so a stopped engine (logged out) never grows
    // sync machinery, no matter which IPC call or timer fires.
    if (!this.started) {
      console.log("[sync] startPair skipped — engine not started:", pair.id);
      return;
    }
    if (this.runtimes.has(pair.id)) return;
    console.log("[sync] startPair:", pair.id, "mode:", pair.syncMode, "path:", pair.localPath);

    // Clean up orphaned .dosya-sync-tmp files from crashed downloads
    try {
      await this.cleanupTempFiles(pair.localPath);
    } catch {}

    try {
      await access(pair.localPath);
    } catch {
      const rt: PairRuntime = {
        pair,
        state: await loadPairState(pair.id),
        watcher: null,
        poller: null,
        status: "error",
        errorMessage: `Sync folder not found: ${pair.localPath}`,
        syncing: false,
        queuedSync: false,
        queuedEvents: new Map(),
        queuedOverflow: false,
        pathIndex: new PathIndex(),
        rateLimitResumeTimer: null,
      rescanTimer: null,
        totalFilesInBatch: 0,
        completedFilesInBatch: 0,
        totalBytesInBatch: 0,
        completedBytesInBatch: 0,
        batchStartedAt: 0,
        phase: null,
        scannedFiles: 0,
        scannedFolders: 0,
        statusText: "",
        localDirty: true,
        lastFullLocalScanAt: 0,
        syncStartedAt: 0,
        lastProgressAt: 0,
        lastProgressLogAt: 0,
      };
      this.runtimes.set(pair.id, rt);
      this.emitStatus();
      return;
    }

    // Fetch the workspace's actual default region
    try {
      const wsRegion = await this.client.getWorkspaceRegion(pair.workspaceId);
      if (wsRegion && wsRegion !== pair.region) {
        pair.region = wsRegion;
        if (this.config) {
          const idx = this.config.pairs.findIndex(p => p.id === pair.id);
          if (idx !== -1) {
            this.config.pairs[idx].region = wsRegion;
            await saveConfig(this.config);
          }
        }
      }
    } catch (err: any) {
      console.error("[sync] Failed to fetch workspace region:", err.message);
    }

    const state = await loadPairState(pair.id);

    // Create a root folder on the server matching the local folder name
    if (!pair.remoteFolderId && !state.rootFolderCreated) {
      try {
        const folderName = basename(pair.localPath);
        const folderId = await this.client.createFolder(
          pair.workspaceId,
          folderName,
          null,
        );
        pair.remoteFolderId = folderId;
        state.rootFolderCreated = true;
        console.log(`[sync] Created root folder on server: "${folderName}" → ${folderId}`);

        try {
          await this.client.setFolderSyncFlag(folderId, true);
        } catch (e: any) {
          console.error("[sync] Failed to set sync flag:", e.message);
        }

        if (this.config) {
          const idx = this.config.pairs.findIndex(p => p.id === pair.id);
          if (idx !== -1) {
            this.config.pairs[idx].remoteFolderId = folderId;
            await saveConfig(this.config);
          }
        }
        await this.safeSaveState(state);
      } catch (err: any) {
        console.error("[sync] Failed to create root folder:", err.message);
      }
    }

    const mode = pair.syncMode || "push-safe";
    const needsLocalWatch = ["two-way", "push", "push-safe"].includes(mode);
    const needsRemotePoll = ["two-way", "pull", "pull-safe"].includes(mode);

    let watcher: LocalWatcher | null = null;
    let poller: RemotePoller | null = null;

    if (needsLocalWatch) {
      // Adaptive debounce: large trees get longer debounce to reduce CPU churn
      const trackedFiles = Object.keys(state.files).length;
      const debounceMs = trackedFiles > 5000 ? 2000 : 1000;
      const maxWaitMs = trackedFiles > 5000 ? 8000 : 5000;
      watcher = new LocalWatcher(pair.localPath, debounceMs, maxWaitMs, pair.excludedPatterns);
    }
    if (needsRemotePoll) {
      poller = new RemotePoller(this.client, pair);
    }

    // Build path index from stored state
    const pathIndex = new PathIndex();
    for (const [remoteId, record] of Object.entries(state.files)) {
      pathIndex.set(record.localPath, remoteId);
    }

    const rt: PairRuntime = {
      pair, state, watcher, poller,
      status: "idle",
      errorMessage: null,
      syncing: false,
      queuedSync: false,
      queuedEvents: new Map(),
      queuedOverflow: false,
      pathIndex,
      rateLimitResumeTimer: null,
      rescanTimer: null,
      totalFilesInBatch: 0,
      completedFilesInBatch: 0,
      totalBytesInBatch: 0,
      completedBytesInBatch: 0,
      batchStartedAt: 0,
      phase: null,
      scannedFiles: 0,
      scannedFolders: 0,
      statusText: "",
      localDirty: true,
      lastFullLocalScanAt: 0,
      syncStartedAt: 0,
      lastProgressAt: 0,
      lastProgressLogAt: 0,
    };

    this.runtimes.set(pair.id, rt);

    if (mode === "two-way") {
      // ── Two-way mode ──
      // 1. Run initial reconcile immediately (downloads + uploads)
      // 2. Then start watcher + poller for ongoing changes
      if (poller) {
        poller.on("snapshot", (snapshot: RemoteSnapshot) => {
          this.runReconcile(pair.id, snapshot);
        });
        poller.on("error", (err: Error) => {
          if (err.message === "SESSION_EXPIRED") {
            this.setError(rt, "Session expired. Please log in again.");
            this.emitStatus();
          } else if (isRateLimitError(err)) {
            this.pauseForRateLimit(rt, getRetryAfterMs(err));
          }
        });
      }
      if (watcher) {
        watcher.on("batch", () => {
          rt.localDirty = true;
          if (poller) poller.triggerNow();
        });
        watcher.on("error", (err: Error) => {
          console.error(`[sync] watcher error for ${pair.id}:`, err.message);
        });
        // In two-way mode the poller already does a full local scan on its own
        // schedule, so losing the watcher degrades latency, not correctness.
        watcher.on("degraded", () => {
          this.log(pair.id, "Folder too large to watch live — relying on periodic reconcile scans");
          rt.localDirty = true;
        });
      }

      // Run initial reconcile, then start watcher + poller for ongoing changes
      this.runInitialReconcile(pair.id).then(() => {
        const currentRt = this.runtimes.get(pair.id);
        if (currentRt && currentRt.status !== "paused" && currentRt.status !== "error") {
          watcher?.start();
          poller?.start();
        }
      });
    } else {
      // ── Push / push-safe modes: direct upload on watcher events ──
      if (watcher) {
        watcher.on("batch", (events: WatchEvent[]) => {
          this.handleLocalChanges(pair.id, events);
        });
        watcher.on("error", (err: Error) => {
          console.error(`[sync] watcher error for ${pair.id}:`, err.message);
        });
        // Tree too large to watch live (EMFILE) — the watcher is the only
        // change trigger in push modes, so fall back to periodic full rescans
        // so nothing is missed.
        watcher.on("degraded", () => {
          this.log(pair.id, "Folder too large to watch live — switching to periodic rescans");
          this.startPeriodicRescan(pair.id);
        });
        // Deferred: watcher starts after initial scan (see runInitialScan)
      }
      // ── Pull / pull-safe modes: poller handles downloads ─��
      if (poller && !needsLocalWatch) {
        poller.on("snapshot", (snapshot: RemoteSnapshot) => {
          this.handleRemoteChanges(pair.id, snapshot);
        });
        poller.on("error", (err: Error) => {
          if (err.message === "SESSION_EXPIRED") {
            this.setError(rt, "Session expired. Please log in again.");
            this.emitStatus();
          } else if (isRateLimitError(err)) {
            this.pauseForRateLimit(rt, getRetryAfterMs(err));
          }
        });
        poller.start();
      }
      // Initial scan for push modes
      if (needsLocalWatch) {
        this.runInitialScan(pair.id);
      }
    }

    this.emitStatus();
  }

  /**
   * Fall back to periodic full rescans for a pair whose folder is too large to
   * watch live (EMFILE). Cheap compared to polling every path: the scan uses
   * the same mtime/size fast-path the initial scan does.
   */
  private startPeriodicRescan(pairId: string): void {
    const rt = this.runtimes.get(pairId);
    if (!rt || rt.rescanTimer) return;
    rt.rescanTimer = setInterval(() => {
      const cur = this.runtimes.get(pairId);
      if (!cur || this.stopped) return;
      if (cur.status === "paused" || cur.status === "rate-limited" || cur.syncing) return;
      this.runInitialScan(pairId);
    }, DEGRADED_RESCAN_MS);
  }

  private async stopPair(pairId: string): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt) return;
    if (rt.rescanTimer) {
      clearInterval(rt.rescanTimer);
      rt.rescanTimer = null;
    }
    // Signal workers to stop before tearing down
    rt.status = "paused";
    rt.syncing = false;
    rt.watcher?.removeAllListeners();
    rt.watcher?.stop();
    rt.poller?.removeAllListeners();
    rt.poller?.stop();
    if (rt.rateLimitResumeTimer) {
      clearTimeout(rt.rateLimitResumeTimer);
      rt.rateLimitResumeTimer = null;
    }
    // Let workers see the paused status and bail out
    await new Promise<void>(r => setTimeout(r, 100));
    try { await this.safeSaveState(rt.state); } catch {}
    this.runtimes.delete(pairId);
  }

  // ── Reconcile (two-way mode) ──────────────────────────────────────

  private async runReconcile(pairId: string, snapshot: RemoteSnapshot): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt || rt.status === "paused" || rt.status === "rate-limited" || rt.syncing) return;

    rt.syncing = true;
    rt.status = "syncing";
    this.beginSyncCycle(rt);
    this.emitStatus();

    try {
      // Skip expensive local filesystem scan if:
      // 1. Watcher hasn't reported any local changes (localDirty = false)
      // 2. A full scan was done within the last 5 minutes
      // This saves 15+ seconds of I/O on every 30s poll cycle for 150K files.
      const FULL_SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes
      const needsFullScan = rt.localDirty || Date.now() - rt.lastFullLocalScanAt > FULL_SCAN_INTERVAL;

      let actions: SyncAction[];
      if (needsFullScan) {
        rt.statusText = "Scanning for changes...";
        this.emitStatus();
        actions = await reconcile(rt.pair, rt.state, snapshot, (files, folders) => {
          rt.scannedFiles = files;
          rt.scannedFolders = folders;
          this.markProgress(rt, `Scanned ${files.toLocaleString()} local files, ${folders.toLocaleString()} folders...`);
          this.emitStatus();
        });
        rt.localDirty = false;
        rt.lastFullLocalScanAt = Date.now();
      } else {
        // Remote-only diff: only check for new/changed/deleted remote files
        // against stored state. No local filesystem walk.
        actions = await reconcileRemoteOnly(rt.pair, rt.state, snapshot);
      }

      await this.executeActions(rt, actions);

      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      await this.flushSyncFlags();

      rt.status = "idle";
      rt.state.lastFullSyncAt = Date.now();
      rt.state.lastRemotePollAt = Date.now();
      await this.safeSaveState(rt.state);
    } catch (err: any) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
      if (err.message === "SESSION_EXPIRED") {
        this.setError(rt, "Session expired. Please log in again.");
      } else if (isRateLimitError(err)) {
        this.pauseForRateLimit(rt, getRetryAfterMs(err));
        return; // pauseForRateLimit sets syncing = false
      } else {
        this.setError(rt, err.message);
      }
    } finally {
      rt.syncing = false;
      this.emitStatus();
    }
  }

  private async executeActions(rt: PairRuntime, actions: SyncAction[]): Promise<void> {
    let opCount = 0;

    // Count file transfer actions and compute total bytes for progress UI
    const fileActions = actions.filter(a =>
      a.type === "download-new" || a.type === "download-update" ||
      a.type === "upload-new" || a.type === "upload-update"
    );
    let totalBytes = 0;
    for (const a of fileActions) {
      if (a.type === "download-new" || a.type === "download-update") {
        totalBytes += a.remoteFile.size_bytes;
      } else if (a.type === "upload-new") {
        totalBytes += a.stat.sizeBytes;
      } else if (a.type === "upload-update") {
        totalBytes += a.stat.sizeBytes;
      }
    }
    rt.phase = "transferring";
    rt.totalFilesInBatch = fileActions.length;
    rt.completedFilesInBatch = 0;
    rt.totalBytesInBatch = totalBytes;
    rt.completedBytesInBatch = 0;
    rt.batchStartedAt = Date.now();
    if (fileActions.length > 0) {
      rt.statusText = `Syncing ${fileActions.length.toLocaleString()} files...`;
    }
    this.emitStatus();

    // ── Partition actions by type for optimal execution order ──
    // 1. Create local folders (must exist before downloads)
    // 2. Concurrent downloads (8 workers)
    // 3. Create remote folders (must exist before uploads)
    // 4. Concurrent uploads (via uploadLocalFile which uses semaphore)
    // 5. Sequential: moves, deletes, conflicts
    const localFolderActions = actions.filter(a => a.type === "create-local-folder");
    const downloadActions = actions.filter(a => a.type === "download-new" || a.type === "download-update");
    const remoteFolderActions = actions.filter(a => a.type === "create-remote-folder");
    const uploadActions = actions.filter(a => a.type === "upload-new" || a.type === "upload-update");
    const otherActions = actions.filter(a =>
      a.type === "move-local" || a.type === "delete-local" || a.type === "delete-remote" || a.type === "conflict"
    );

    // Step 1: Create local folders (parallel, local I/O only)
    if (localFolderActions.length > 0) {
      rt.statusText = `Creating ${localFolderActions.length} local folders...`;
      this.emitStatus();
      await Promise.all(localFolderActions.map(async (action) => {
        if (action.type !== "create-local-folder") return;
        const folderPath = join(action.localDir, action.name);
        const relPath = toRelPath(rt.pair.localPath, folderPath);
        if (!this.isPathSafe(rt.pair.localPath, relPath)) return;
        await mkdir(longPath(folderPath), { recursive: true });
      }));
    }

    // Step 2: Concurrent downloads via presigned URLs (100 concurrent, direct to R2)
    if (downloadActions.length > 0) {
      // Guard disk space before writing any bytes.
      const dlBytes = downloadActions.reduce(
        (n, a) => n + ((a.type === "download-new" || a.type === "download-update") ? a.remoteFile.size_bytes : 0),
        0,
      );
      await this.ensureDiskSpace(rt.pair.localPath, dlBytes);

      rt.statusText = `Downloading ${downloadActions.length.toLocaleString()} files...`;
      this.emitStatus();

      // Collect file IDs for presigned URL batch request
      const dlFileIds = downloadActions
        .map(a => a.remoteFile.id)
        .filter(Boolean);

      // Get presigned URLs in one batch (500 per request)
      let presignedMap = new Map<string, { url: string; name: string; size: number }>();
      try {
        presignedMap = await this.client.requestDownloadManifest(rt.pair.workspaceId, dlFileIds);
      } catch (err: any) {
        if (err.message === "SESSION_EXPIRED") throw err;
        // Presigned endpoint not available — fall back to Worker-proxied downloads
        this.log(rt.pair.id, "Presigned download not available, using fallback");
      }

      const DOWNLOAD_CONCURRENCY = presignedMap.size > 0 ? this.directTransferConcurrency() : 8;
      let dlIdx = 0;
      let dlFatalErr: Error | null = null;

      const dlWorker = async (): Promise<void> => {
        while (dlIdx < downloadActions.length) {
          if (this.stopped || (rt.status as SyncPairStatus) === "paused" || dlFatalErr) return;
          const i = dlIdx++;
          const action = downloadActions[i];

          let absPath: string;
          let relPath: string;
          if (action.type === "download-new") {
            absPath = join(action.localDir, action.remoteFile.name);
            relPath = toRelPath(rt.pair.localPath, absPath);
          } else if (action.type === "download-update") {
            absPath = action.localPath;
            relPath = toRelPath(rt.pair.localPath, absPath);
          } else continue;

          if (!this.isPathSafe(rt.pair.localPath, relPath)) continue;
          const dlErr = rt.state.fileErrors[relPath];
          if (dlErr?.permanent) continue;
          if (dlErr && dlErr.retryCount >= MAX_FILE_RETRIES) { dlErr.permanent = true; continue; }

          try {
            await mkdir(longPath(dirname(absPath)), { recursive: true });
            const presigned = presignedMap.get(action.remoteFile.id);
            if (presigned) {
              // Direct download from R2 via presigned URL — no Worker proxy
              await this.client.downloadFromPresignedUrl(
                presigned.url, absPath, action.remoteFile.size_bytes,
              );
              // Update state
              const s = await stat(longPath(absPath));
              this.markRecentDownload(absPath);
              rt.state.files[action.remoteFile.id] = {
                remoteId: action.remoteFile.id,
                remoteName: action.remoteFile.name,
                remoteFolderId: action.remoteFile.folder_id,
                remoteSizeBytes: action.remoteFile.size_bytes,
                remoteUpdatedAt: action.remoteFile.updated_at,
                remoteVersion: action.remoteFile.current_version,
                localPath: relPath,
                localSizeBytes: s.size,
                localMtimeMs: s.mtimeMs,
                syncedAt: Date.now(),
              };
              rt.pathIndex.set(relPath, action.remoteFile.id);
            } else {
              // Fallback: download through Worker
              await this.downloadRemoteFile(rt, action.remoteFile, absPath, relPath);
            }
            delete rt.state.fileErrors[relPath];
          } catch (dlE: any) {
            if (dlE.message === "SESSION_EXPIRED") { dlFatalErr = dlE; return; }
            if (isRateLimitError(dlE)) { dlFatalErr = dlE; return; }
            const prev = rt.state.fileErrors[relPath];
            rt.state.fileErrors[relPath] = {
              filePath: relPath, error: dlE.message,
              retryCount: (prev?.retryCount ?? 0) + 1, lastAttemptAt: Date.now(),
              permanent: dlE.message.includes("404") || dlE.message.includes("not found"),
            };
          }
          rt.completedFilesInBatch++;
          rt.completedBytesInBatch += action.remoteFile.size_bytes;
          this.markProgress(rt);
          if (++opCount % STATE_SAVE_INTERVAL === 0) await this.safeSaveState(rt.state);
          this.emitStatus();
        }
      };

      await Promise.all(Array.from({ length: Math.min(DOWNLOAD_CONCURRENCY, downloadActions.length) }, () => dlWorker()));
      if (dlFatalErr) throw dlFatalErr;
    }

    // Step 3: Create remote folders (batch API)
    if (remoteFolderActions.length > 0) {
      rt.statusText = `Creating ${remoteFolderActions.length} remote folders...`;
      this.emitStatus();
      for (const action of remoteFolderActions) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
        if (action.type !== "create-remote-folder") continue;
        const relPath = toRelPath(rt.pair.localPath, action.localPath);
        await this.ensureRemoteFolder(rt, relPath);
      }
    }

    // Step 4: Concurrent uploads
    if (uploadActions.length > 0) {
      rt.statusText = `Uploading ${uploadActions.length.toLocaleString()} files...`;
      this.emitStatus();
      for (const action of uploadActions) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
        if (action.type !== "upload-new" && action.type !== "upload-update") continue;
        const relPath = toRelPath(rt.pair.localPath, action.localPath);
        try {
          await this.uploadLocalFile(rt, action.localPath, relPath);
        } catch (upErr: any) {
          // A single transient upload failure must NOT abort the batch — the
          // deletes queued in otherActions (below) would be dropped, and a
          // dropped remote deletion is permanent data loss. Session/rate-limit
          // errors are fatal for the whole cycle, so re-throw those; everything
          // else is recorded per-file (same shape scanAndUpload uses) and we
          // continue with the next action.
          if (upErr.message === "SESSION_EXPIRED") throw upErr;
          if (isRateLimitError(upErr)) throw upErr;
          console.error(`[sync] upload failed for ${relPath}:`, upErr.message);
          const existing = rt.state.fileErrors[relPath];
          rt.state.fileErrors[relPath] = {
            filePath: relPath,
            error: upErr.message,
            retryCount: (existing?.retryCount ?? 0) + 1,
            lastAttemptAt: Date.now(),
            permanent: upErr.message.includes("permission") || upErr.message.includes("EPERM") || upErr.message.includes("quota"),
          };
        }
        rt.completedFilesInBatch++;
        rt.completedBytesInBatch += action.type === "upload-new" ? action.stat.sizeBytes : action.stat.sizeBytes;
        if (++opCount % STATE_SAVE_INTERVAL === 0) await this.safeSaveState(rt.state);
        this.emitStatus();
      }
    }

    // Step 5: Sequential actions (moves, deletes, conflicts)
    for (const action of otherActions) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
      try {
        switch (action.type) {
          case "move-local": {
            const newRelPath = toRelPath(rt.pair.localPath, action.newLocalPath);
            try {
              await mkdir(longPath(dirname(action.newLocalPath)), { recursive: true });
              const { rename: fsRename } = await import("fs/promises");
              await fsRename(longPath(action.oldLocalPath), longPath(action.newLocalPath));
              rt.pathIndex.delete(action.record.localPath);
              action.record.localPath = newRelPath;
              action.record.remoteName = action.remoteFile.name;
              action.record.remoteFolderId = action.remoteFile.folder_id;
              rt.pathIndex.set(newRelPath, action.record.remoteId);
              this.markRecentDownload(action.newLocalPath);
            } catch {
              await mkdir(longPath(dirname(action.newLocalPath)), { recursive: true });
              await this.downloadRemoteFile(rt, action.remoteFile, action.newLocalPath, newRelPath);
            }
            break;
          }
          case "delete-local": {
            await unlink(longPath(action.localPath)).catch(() => {});
            delete rt.state.files[action.record.remoteId];
            rt.pathIndex.delete(action.record.localPath);
            break;
          }
          case "delete-remote": {
            await this.client.deleteFile(action.remoteId).catch(() => {});
            delete rt.state.files[action.remoteId];
            rt.pathIndex.delete(action.record.localPath);
            console.log(`[sync] Deleted remote: ${action.record.localPath}`);
            break;
          }
          case "conflict": {
            this.conflicts.push(action.conflict);
            this.emit("conflict-detected", action.conflict);
            console.log(`[sync] Conflict detected: ${action.conflict.remoteName}`);
            break;
          }
        }

        // Save state periodically (not just at end of batch)
        opCount++;
        if (opCount % STATE_SAVE_INTERVAL === 0) {
          await this.safeSaveState(rt.state);
        }
      } catch (err: any) {
        if (err.message === "SESSION_EXPIRED") throw err;
        // Propagate rate limit errors to break out of the action loop
        if (isRateLimitError(err)) throw err;
        console.error(`[sync] Action ${action.type} failed:`, err.message);
      }
    }
  }

  // ── Initial scan: upload all local files not yet tracked ──────────

  private async runInitialScan(pairId: string): Promise<void> {
    const rt = this.runtimes.get(pairId);
    // Also bail while stopped or paused: a trigger racing a logout/pause
    // must not flip the pair back to "syncing" mid-teardown.
    if (!rt || this.stopped || rt.syncing || rt.status === "paused" || rt.status === "rate-limited") return;
    console.log("[sync] runInitialScan:", pairId);

    // Check if the server still has sync enabled for this folder
    rt.statusText = "Connecting to server...";
    this.emitStatus();
    if (rt.pair.remoteFolderId) {
      try {
        const isStillSynced = await this.client.getFolderSyncFlag(rt.pair.remoteFolderId);
        if (!isStillSynced) {
          console.log("[sync] Sync disabled from web for pair:", pairId);
          this.setError(rt, "Sync was disabled from the web. Remove and re-add to resume.");
          rt.watcher?.stop();
          rt.poller?.stop();
          this.emitStatus();
          return;
        }
      } catch (err: any) {
        if (err.message === "SESSION_EXPIRED") {
          this.setError(rt, "Session expired. Please log in again.");
          this.emitStatus();
          return;
        }
        if (isRateLimitError(err)) {
          this.pauseForRateLimit(rt, getRetryAfterMs(err));
          return;
        }
      }
    }

    rt.syncing = true;
    rt.status = "syncing";
    this.beginSyncCycle(rt);
    this.emitStatus();

    try {
      await this.scanAndUpload(rt);

      // If the pair was paused/stopped while we were scanning, don't
      // overwrite its status or start the watcher — just bail out.
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") {
        return;
      }

      // Batch-set sync flags for all uploaded files (instead of per-file API calls)
      await this.flushSyncFlags();
      // Now that the scan is done, start the watcher for ongoing changes.
      // Deferred from startPair() to avoid double-walking the tree.
      if (rt.watcher && !rt.watcher.isWatching()) {
        rt.watcher.start();
      }
      rt.status = "idle";
      rt.totalFilesInBatch = 0;
      rt.completedFilesInBatch = 0;
      rt.totalBytesInBatch = 0;
      rt.completedBytesInBatch = 0;
      rt.batchStartedAt = 0;
      rt.phase = null;
      rt.scannedFiles = 0;
      // Prune stale file errors older than 7 days to prevent unbounded growth
      const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      for (const [path, err] of Object.entries(rt.state.fileErrors)) {
        if (err.lastAttemptAt < weekAgo) delete rt.state.fileErrors[path];
      }
      rt.scannedFolders = 0;
      rt.statusText = "";
      rt.state.lastFullSyncAt = Date.now();
      await this.safeSaveState(rt.state);
      this.log(pairId, "Sync complete");
    } catch (err: any) {
      // If paused/stopped during sync, don't set error state
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") {
        return;
      }
      console.error("[sync] Initial scan failed:", pairId, err.message);
      if (err.message === "SESSION_EXPIRED") {
        this.setError(rt, "Session expired. Please log in again.");
      } else if (isRateLimitError(err)) {
        this.pauseForRateLimit(rt, getRetryAfterMs(err));
        return; // pauseForRateLimit sets syncing = false
      } else {
        this.setError(rt, err.message);
      }
    } finally {
      // Reset batch counters unless rate-limited (will resume later).
      // Cast needed because TS narrows rt.status from the try/catch branches
      // but pauseForRateLimit sets it to "rate-limited" externally.
      if ((rt.status as SyncPairStatus) !== "rate-limited") {
        rt.totalFilesInBatch = 0;
        rt.completedFilesInBatch = 0;
        rt.totalBytesInBatch = 0;
        rt.completedBytesInBatch = 0;
        rt.batchStartedAt = 0;
        rt.phase = null;
        rt.scannedFiles = 0;
        rt.scannedFolders = 0;
        rt.statusText = "";
      }
      rt.syncing = false;
      this.emitStatus();
    }
  }

  private async scanAndUpload(rt: PairRuntime): Promise<void> {
    const { pair, state } = rt;

    // NOTE: no disk-space check here — this is the UPLOAD path and uploads
    // don't consume local disk. Backing up from a nearly-full disk must work.
    // Disk space is guarded on the download paths via ensureDiskSpace().

    // Pre-populate state from remote if empty (reinstall / fresh pair)
    try {
      await this.prePopulateStateFromRemote(rt);
    } catch {
      // Continue with empty state — files will be uploaded as new (safe, just slower)
    }

    // Phase 1: Walk the tree and collect files + new directories.
    // No API calls here — just filesystem reads. Yields to the event loop
    // every YIELD_INTERVAL entries to prevent blocking UI/IPC.
    const YIELD_INTERVAL = 200;
    const STAT_BATCH_SIZE = 50;
    const toUpload: { absPath: string; relPath: string; isNew: boolean; sizeBytes: number }[] = [];
    const needsHash: { absPath: string; relPath: string; sizeBytes: number; record: import("./types").SyncFileRecord }[] = [];
    const newFolders: string[] = [];
    let walkCount = 0;

    // ── Scanning phase: walk the tree, report discovered counts to the UI ──
    rt.phase = "scanning";
    rt.scannedFiles = 0;
    rt.scannedFolders = 0;
    rt.statusText = "Scanning local files...";
    this.log(pair.id, "Scanning local folder for changes...");
    this.emitStatus();

    const walk = async (dir: string): Promise<void> => {
      if (this.stopped || rt.status === "paused") return;
      let entries;
      try { entries = await readdir(longPath(dir), { withFileTypes: true }); } catch { return; }

      const fileEntries: { absPath: string; relPath: string }[] = [];

      for (const entry of entries) {
        if (shouldIgnoreEntry(entry.name, entry.isDirectory(), pair.excludedPatterns)) continue;

        const absPath = join(dir, entry.name);
        const relPath = toRelPath(pair.localPath, absPath);

        if (entry.isDirectory()) {
          if (!state.folders[relPath]) {
            newFolders.push(relPath);
          }
          rt.scannedFolders++;
          if (++walkCount % YIELD_INTERVAL === 0) {
            this.markProgress(rt, `Scanned ${rt.scannedFiles.toLocaleString()} local files, ${rt.scannedFolders.toLocaleString()} folders...`);
            this.emitStatus();
            await new Promise<void>(r => setImmediate(r));
          }
          await walk(absPath);
        } else if (entry.isFile()) {
          fileEntries.push({ absPath, relPath });
        }
        // Symlinks, sockets, FIFOs, device nodes, and FUSE/snap entries
        // that misreport their type are silently skipped.
      }

      for (let i = 0; i < fileEntries.length; i += STAT_BATCH_SIZE) {
        const batch = fileEntries.slice(i, i + STAT_BATCH_SIZE);
        const stats = await Promise.all(
          batch.map(f => stat(longPath(f.absPath)).catch(() => null)),
        );
        for (let j = 0; j < batch.length; j++) {
          const s = stats[j];
          // Skip non-regular files (dirs, symlinks, sockets, FIFOs)
          // and files with bogus sizes (Linux /proc, /sys report TB+ sizes)
          if (!s || !s.isFile() || s.size > 100 * 1024 * 1024 * 1024) continue;
          const { relPath, absPath } = batch[j];
          rt.scannedFiles++;
          const existing = this.lookupByPath(rt, relPath);
          if (!existing) {
            toUpload.push({ absPath, relPath, isNew: true, sizeBytes: s.size });
          } else if (existing.record.localMtimeMs === 0 && s.size === existing.record.localSizeBytes) {
            // Pre-populated from remote snapshot (reinstall). Size matches.
            existing.record.localMtimeMs = s.mtimeMs;
            existing.record.localSizeBytes = s.size;
          } else if (s.size !== existing.record.localSizeBytes) {
            // Size changed — definitely modified, no need to hash
            toUpload.push({ absPath, relPath, isNew: false, sizeBytes: s.size });
          } else if (s.mtimeMs !== existing.record.localMtimeMs) {
            // mtime changed but size same — hash to check if content actually changed.
            // This catches editors that touch mtime without modifying content,
            // git checkout, rsync --times, backup restores, etc.
            needsHash.push({ absPath, relPath, sizeBytes: s.size, record: existing.record });
          }
        }
        // Yield between stat batches
        if (++walkCount % YIELD_INTERVAL === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
      }
    };

    await walk(pair.localPath);

    this.log(pair.id, `Scan complete: ${toUpload.filter(f => f.isNew).length.toLocaleString()} new, ${toUpload.filter(f => !f.isNew).length.toLocaleString()} modified, ${needsHash.length.toLocaleString()} to verify, ${newFolders.length.toLocaleString()} new folders`);

    // ── Hash phase: check files where mtime changed but size didn't ──
    // Only these files get hashed — not all 150K. Typically ~1-2% of files.
    if (needsHash.length > 0) {
      this.log(pair.id, `Verifying ${needsHash.length.toLocaleString()} files (mtime changed, checking content)...`);
      rt.statusText = `Checking ${needsHash.length} changed files...`;
      this.emitStatus();
      const HASH_CONCURRENCY = 10;
      let hashIdx = 0;
      const hashWorker = async () => {
        while (hashIdx < needsHash.length) {
          if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
          const i = hashIdx++;
          const entry = needsHash[i];
          try {
            const hash = await hashFile(longPath(entry.absPath));
            if (hash !== entry.record.contentHash) {
              // Content actually changed — queue for upload
              toUpload.push({ absPath: entry.absPath, relPath: entry.relPath, isNew: false, sizeBytes: entry.sizeBytes });
            } else {
              // Content identical — just update mtime in state so we don't re-hash next time
              const s = await stat(longPath(entry.absPath)).catch(() => null);
              if (s) entry.record.localMtimeMs = s.mtimeMs;
            }
          } catch {
            // Can't hash (permission error, etc.) — treat as changed to be safe
            toUpload.push({ absPath: entry.absPath, relPath: entry.relPath, isNew: false, sizeBytes: entry.sizeBytes });
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, needsHash.length) }, () => hashWorker()));
      const actuallyChanged = toUpload.filter(f => !f.isNew).length;
      const skippedByHash = needsHash.length - actuallyChanged;
      this.log(pair.id, `Verification done: ${actuallyChanged} actually changed, ${skippedByHash} unchanged (content identical)`);
    }

    // Phase 2: Create remote folders via batch API, one depth level at a time.
    // The server assigns IDs only when a batch returns, so a folder can never
    // share a request with its own parent — the parent's ID wouldn't exist yet
    // to send. Grouping by depth guarantees every parent was created (and its
    // ID recorded in state.folders) by an earlier level's request. Chunking
    // the whole depth-sorted list instead flattens the tree: any folder whose
    // parent sat in the same chunk of 500 silently fell back to the pair root.
    // For 29K folders: requests = depth levels + ~58 chunk requests.
    newFolders.sort((a, b) => a.split("/").length - b.split("/").length);
    const FOLDER_BATCH_SIZE = 500;

    if (newFolders.length > 0) {
      rt.statusText = `Creating ${newFolders.length.toLocaleString()} folders on server...`;
      this.log(pair.id, `Creating ${newFolders.length.toLocaleString()} folders on server...`);
      this.emitStatus();
    }

    let foldersCreated = 0;
    // Folders whose parent has no recorded ID even in level order (the server
    // skipped the parent, e.g. over-length name). Created individually below —
    // never batched with a guessed parent, which is what flattened trees.
    const deferred: string[] = [];
    let levelStart = 0;
    while (levelStart < newFolders.length) {
      const depth = newFolders[levelStart].split("/").length;
      let levelEnd = levelStart;
      while (levelEnd < newFolders.length && newFolders[levelEnd].split("/").length === depth) levelEnd++;

      for (let i = levelStart; i < levelEnd; i += FOLDER_BATCH_SIZE) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

        const chunk = newFolders.slice(i, Math.min(i + FOLDER_BATCH_SIZE, levelEnd));

        // Build the batch request: resolve parent IDs from already-created folders
        const batchEntries: { name: string; parent_id: string | null }[] = [];
        const batchRelPaths: string[] = [];
        for (const relPath of chunk) {
          const parts = relPath.split("/");
          const folderName = parts[parts.length - 1];
          const parentRelPath = parts.slice(0, -1).join("/");
          if (parentRelPath && !state.folders[parentRelPath]) {
            deferred.push(relPath);
            continue;
          }
          batchEntries.push({
            name: folderName,
            parent_id: parentRelPath ? state.folders[parentRelPath].remoteId : pair.remoteFolderId,
          });
          batchRelPaths.push(relPath);
        }
        if (batchEntries.length === 0) continue;

        try {
          const resultMap = await this.client.createFoldersBatch(pair.workspaceId, batchEntries);
          foldersCreated += batchEntries.length;
          rt.statusText = `Creating folders... ${foldersCreated.toLocaleString()} of ${newFolders.length.toLocaleString()}`;
          this.emitStatus();

          // Update local state with created folder IDs
          for (let j = 0; j < batchEntries.length; j++) {
            const relPath = batchRelPaths[j];
            const entry = batchEntries[j];
            const key = `${entry.parent_id ?? "null"}:${entry.name}`;
            const folderId = resultMap.get(key);
            if (folderId) {
              state.folders[relPath] = {
                remoteId: folderId,
                remoteName: entry.name,
                remoteParentId: entry.parent_id,
                localPath: relPath,
                syncedAt: Date.now(),
              };
            }
          }
        } catch (err: any) {
          if (err.message === "SESSION_EXPIRED") throw err;
          if (isRateLimitError(err)) throw err;
          // Batch failed — fall back to individual creation for this chunk
          console.error("[sync] Batch folder creation failed, falling back to individual:", err.message);
          for (const relPath of batchRelPaths) {
            if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
            await this.ensureRemoteFolder(rt, relPath);
          }
        }
      }
      levelStart = levelEnd;
    }
    for (const relPath of deferred) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
      await this.ensureRemoteFolder(rt, relPath);
      foldersCreated++;
    }
    if (foldersCreated > 0) {
      this.log(pair.id, `Created ${foldersCreated.toLocaleString()} folders on server`);
    }
    // Free folder list — no longer needed
    newFolders.length = 0;

    // ── Transferring phase ──
    // Small files use presigned URLs (direct to R2, bypassing the Worker).
    // Large files use individual streaming uploads through the Worker.
    toUpload.sort((a, b) => a.sizeBytes - b.sizeBytes);

    const BATCH_THRESHOLD = RemoteClient.BATCH_FILE_MAX;
    const smallFiles = toUpload.filter(f => f.sizeBytes <= BATCH_THRESHOLD);
    const largeFiles = toUpload.filter(f => f.sizeBytes > BATCH_THRESHOLD);

    // Compute totals, then release toUpload — keeping it alongside
    // smallFiles/largeFiles is a needless third full-size copy at 1M files.
    const totalFiles = toUpload.length;
    let totalBytes = 0;
    for (const f of toUpload) totalBytes += f.sizeBytes;
    toUpload.length = 0;

    rt.phase = "transferring";
    rt.statusText = `Uploading ${totalFiles.toLocaleString()} files...`;
    if (totalFiles > 0) {
      const totalMB = Math.round(totalBytes / 1024 / 1024);
      this.log(pair.id, `Starting upload: ${totalFiles.toLocaleString()} files (${totalMB.toLocaleString()} MB) — ${smallFiles.length.toLocaleString()} small, ${largeFiles.length.toLocaleString()} large`);
    } else {
      this.log(pair.id, "Everything up to date — nothing to upload");
    }
    rt.totalFilesInBatch = totalFiles;
    rt.completedFilesInBatch = 0;
    rt.totalBytesInBatch = totalBytes;
    rt.completedBytesInBatch = 0;
    rt.batchStartedAt = Date.now();
    this.emitStatus();

    let opCount = 0;

    // ── Phase 3a: Presigned URL upload for small files ──
    // Client → Worker (get presigned URLs) → Client → R2 directly (bounded)
    // → Client → Worker (commit DB records). Worker never touches file bytes.
    const MANIFEST_BATCH = 5000; // files per manifest request (Worker CPU limit)
    const UPLOAD_CONCURRENCY = this.directTransferConcurrency(); // concurrent direct-to-R2 uploads (bounded)
    const COMMIT_BATCH = 5000; // files per commit request

    // Build + process manifest chunks LAZILY from smallFiles. The old code
    // copied the whole small-file set twice (eligibleSmall + manifestEntries);
    // here each request only materializes a ≤MANIFEST_BATCH window, so peak
    // memory doesn't scale with total file count.
    let smallIdx = 0;
    let batchNo = 0;
    while (smallIdx < smallFiles.length) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      const mChunk: { relPath: string; name: string; size: number; folder_id: string | null; absPath: string }[] = [];
      while (smallIdx < smallFiles.length && mChunk.length < MANIFEST_BATCH) {
        const f = smallFiles[smallIdx++];
        const err = state.fileErrors[f.relPath];
        if (err?.permanent) continue;
        if (err && err.retryCount >= MAX_FILE_RETRIES) { state.fileErrors[f.relPath].permanent = true; continue; }
        const parentRelPath = f.relPath.split("/").slice(0, -1).join("/");
        const folderId = parentRelPath
          ? (state.folders[parentRelPath]?.remoteId ?? pair.remoteFolderId)
          : pair.remoteFolderId;
        mChunk.push({ relPath: f.relPath, name: basename(f.absPath), size: f.sizeBytes, folder_id: folderId, absPath: f.absPath });
      }
      if (mChunk.length === 0) continue;
      batchNo++;

      rt.statusText = `Preparing upload batch ${batchNo}...`;
      this.emitStatus();

      let manifest: Awaited<ReturnType<typeof this.client.requestManifest>>;
      try {
        manifest = await this.client.requestManifest(
          pair.workspaceId,
          pair.remoteFolderId,
          pair.region,
          mChunk.map(f => ({ relPath: f.relPath, name: f.name, size: f.size, folder_id: f.folder_id })),
        );
      } catch (err: any) {
        if (err.message === "SESSION_EXPIRED") throw err;
        if (isRateLimitError(err)) throw err;
        // Manifest failed — fall back to old batch upload for this chunk
        console.error("[sync] Presigned manifest failed, falling back to batch:", err.message);
        // Mark these files for individual upload by pushing to largeFiles
        for (const f of mChunk) largeFiles.push({ absPath: f.absPath, relPath: f.relPath, isNew: true, sizeBytes: f.size });
        continue;
      }

      // Count skipped (already exist on server)
      rt.completedFilesInBatch += manifest.skipped;
      rt.completedBytesInBatch += mChunk
        .filter(f => !manifest.uploads.find(u => u.relPath === f.relPath))
        .reduce((s, f) => s + f.size, 0);
      this.emitStatus();

      if (manifest.uploads.length === 0) continue;

      // Upload directly to R2 via presigned URLs — 100 concurrent
      const uploaded: typeof manifest.uploads = [];
      let uploadIdx = 0;
      let uploadFatalErr: Error | null = null;

      const uploadWorker = async (): Promise<void> => {
        while (uploadIdx < manifest.uploads.length) {
          if (this.stopped || (rt.status as SyncPairStatus) === "paused" || uploadFatalErr) return;

          const i = uploadIdx++;
          const upload = manifest.uploads[i];
          const entry = mChunk.find(f => f.relPath === upload.relPath);
          if (!entry) continue;

          try {
            await this.client.uploadToPresignedUrl(
              upload.url,
              entry.absPath,
              upload.size,
              upload.contentType,
            );
            uploaded.push(upload);

            // Update progress
            rt.completedFilesInBatch++;
            rt.completedBytesInBatch += upload.size;
            this.markProgress(rt);
            this.emitStatus();
          } catch (err: any) {
            console.error(`[sync] Presigned upload failed for ${upload.relPath}:`, err.message);
            const existing = state.fileErrors[upload.relPath];
            state.fileErrors[upload.relPath] = {
              filePath: upload.relPath,
              error: err.message,
              retryCount: (existing?.retryCount ?? 0) + 1,
              lastAttemptAt: Date.now(),
              permanent: false,
            };
          }
        }
      };

      await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, manifest.uploads.length) }, () => uploadWorker()));

      // Commit uploaded files to DB in batches
      if (uploaded.length > 0) {
        for (let cStart = 0; cStart < uploaded.length; cStart += COMMIT_BATCH) {
          if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

          const cChunk = uploaded.slice(cStart, cStart + COMMIT_BATCH);
          try {
            const commitRes = await this.client.commitUploads(
              pair.workspaceId,
              pair.region,
              cChunk.map(u => ({
                file_id: u.fileId,
                r2_key: u.r2Key,
                name: u.name,
                size: u.size,
                folder_id: u.folderId,
                content_type: u.contentType,
                ext: u.ext,
              })),
            );

            // Update local state (prefer server-authoritative version/updated_at)
            for (const u of cChunk) {
              const entry = mChunk.find(f => f.relPath === u.relPath);
              const s = entry ? await stat(entry.absPath).catch(() => null) : null;
              const srv = commitRes.results.get(u.fileId);
              state.files[u.fileId] = {
                remoteId: u.fileId,
                remoteName: u.name,
                remoteFolderId: u.folderId,
                remoteSizeBytes: u.size,
                remoteUpdatedAt: srv?.updatedAt ?? Math.floor(Date.now() / 1000),
                remoteVersion: srv?.version ?? 1,
                localPath: u.relPath,
                localSizeBytes: s?.size ?? u.size,
                localMtimeMs: s?.mtimeMs ?? Date.now(),
                syncedAt: Date.now(),
              };
              rt.pathIndex.set(u.relPath, u.fileId);
              delete state.fileErrors[u.relPath];
            }
          } catch (err: any) {
            if (err.message === "SESSION_EXPIRED") throw err;
            console.error("[sync] Commit failed:", err.message);
          }
        }
      }

      opCount += mChunk.length;
      if (opCount % STATE_SAVE_INTERVAL === 0) {
        await this.safeSaveState(rt.state);
      }
    }

    // ── Phase 3b: Upload large files individually with streaming ──
    let rateLimitErr: Error | null = null;
    let sessionExpiredErr: Error | null = null;

    let fileIdx = 0;
    const paused = () => rt.status === "paused";
    const worker = async (): Promise<void> => {
      while (fileIdx < largeFiles.length) {
        if (this.stopped || paused() || rateLimitErr || sessionExpiredErr) return;

        const idx = fileIdx++;
        const file = largeFiles[idx];
        largeFiles[idx] = null as any;

        const fileError = state.fileErrors[file.relPath];
        if (fileError && fileError.permanent) continue;
        if (fileError && fileError.retryCount >= MAX_FILE_RETRIES) {
          state.fileErrors[file.relPath].permanent = true;
          continue;
        }

        try {
          await this.uploadLocalFile(rt, file.absPath, file.relPath);
          delete state.fileErrors[file.relPath];
          rt.completedFilesInBatch++;
          rt.completedBytesInBatch += file.sizeBytes;
          this.emitStatus();
        } catch (err: any) {
          if (err.message === "SESSION_EXPIRED") {
            sessionExpiredErr = err;
            return;
          }
          if (isRateLimitError(err)) {
            rateLimitErr = err;
            const remaining = largeFiles.length - idx - 1;
            console.log(`[sync] Rate limited during large file upload. ${remaining} files remaining.`);
            return;
          }
          console.error(`[sync] upload failed for ${file.relPath}:`, err.message);
          const existing = state.fileErrors[file.relPath];
          state.fileErrors[file.relPath] = {
            filePath: file.relPath,
            error: err.message,
            retryCount: (existing?.retryCount ?? 0) + 1,
            lastAttemptAt: Date.now(),
            permanent: err.message.includes("permission") || err.message.includes("EPERM") || err.message.includes("quota"),
          };
        }

        // Save state periodically
        if (++opCount % STATE_SAVE_INTERVAL === 0) {
          await this.safeSaveState(rt.state);
        }
      }
    };

    // Auto-scale concurrency for large batches. The user-configured value
    // is the baseline, but for initial syncs with thousands of files we
    // scale up so API round-trip latency doesn't bottleneck the sync.
    // The server exempts desktop sync from rate limits, so this is safe.
    const baseConcurrency = this.config?.maxConcurrentTransfers || 3;
    if (largeFiles.length > 0) {
      const concurrency = largeFiles.length > 100 ? Math.max(baseConcurrency, 8)
                         : largeFiles.length > 10  ? Math.max(baseConcurrency, 5)
                         : baseConcurrency;
      this.transferSemaphore.updateMax(concurrency);
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
      this.transferSemaphore.updateMax(baseConcurrency);
    }

    // Propagate fatal errors after all workers finish
    if (sessionExpiredErr) throw sessionExpiredErr;
    if (rateLimitErr) {
      await this.safeSaveState(rt.state);
      throw rateLimitErr;
    }
  }

  // ── Handle live local changes (push / push-safe modes) ────────────

  private async handleLocalChanges(pairId: string, events: WatchEvent[]): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt || rt.status === "paused" || rt.status === "rate-limited") return;

    if (rt.syncing) {
      // Buffer events (deduped by path) to process AFTER the current sync so
      // deletes and moves aren't lost — a plain rescan only re-finds additions.
      const QUEUE_CAP = 200_000;
      for (const ev of events) rt.queuedEvents.set(ev.path, ev);
      if (rt.queuedEvents.size > QUEUE_CAP) {
        // Too many buffered changes — drop detail, fall back to full rescan
        // (bounded memory). Two-way reconcile still catches deletes.
        rt.queuedEvents.clear();
        rt.queuedOverflow = true;
      }
      rt.queuedSync = true;
      return;
    }

    rt.syncing = true;
    rt.status = "syncing";
    this.beginSyncCycle(rt);
    this.emitStatus();

    let opCount = 0;

    try {
      // ── Move/rename detection (safe) ──
      // A local rename shows up as unlink(A) + add(B). Relocating the cloud
      // object beats re-uploading B and deleting A. But pairing purely by byte
      // size is dangerous: two unrelated files of equal size (extremely common
      // for 0-byte or round-sized files) get mis-paired — moving the WRONG
      // cloud object and never uploading B's real bytes (silent corruption),
      // and in push-safe silently breaking the "never lose cloud data" promise.
      // So we only treat unlink+add as a move when identity is PROVEN:
      //   • content-hash match (when a hash was recorded for A), or
      //   • an unambiguous 1:1 size pairing at a non-trivial file size.
      // Anything ambiguous falls back to the safe delete + re-upload path.
      const MIN_MOVE_SIZE = 4096;               // below this, just re-upload
      const MOVE_HASH_LIMIT = 64 * 1024 * 1024; // cap per-file hashing cost

      const unlinkEvents = new Map<string, WatchEvent>(); // relPath → event
      const addEvents = new Map<string, WatchEvent>();
      for (const event of events) {
        const relPath = toRelPath(rt.pair.localPath, event.path);
        if (event.type === "unlink") unlinkEvents.set(relPath, event);
        else if (event.type === "add") addEvents.set(relPath, event);
      }

      // Index adds by size ONCE (O(n)). The old code hashed a size-match search
      // inside a nested unlink×add loop, which turned a large-folder rename
      // (10k unlink + 10k add events) into ~10^8 stat() calls and froze the app.
      const addsBySize = new Map<number, { relPath: string; path: string }[]>();
      const trackedUnlinkBySize = new Map<number, number>();
      const trackedUnlinks: { oldRel: string; record: import("./types").SyncFileRecord; remoteId: string; size: number }[] = [];
      for (const [newRel, addEv] of addEvents) {
        const s = await stat(longPath(addEv.path)).catch(() => null);
        if (!s || !s.isFile()) continue;
        const list = addsBySize.get(s.size);
        if (list) list.push({ relPath: newRel, path: addEv.path });
        else addsBySize.set(s.size, [{ relPath: newRel, path: addEv.path }]);
      }
      for (const [oldRel] of unlinkEvents) {
        const existing = this.lookupByPath(rt, oldRel);
        if (!existing) continue;
        const size = existing.record.localSizeBytes;
        trackedUnlinks.push({ oldRel, record: existing.record, remoteId: existing.remoteId, size });
        trackedUnlinkBySize.set(size, (trackedUnlinkBySize.get(size) ?? 0) + 1);
      }

      const moves = new Map<string, string>(); // oldRelPath → newRelPath
      const handledPaths = new Set<string>();
      const claimedAdds = new Set<string>();
      for (const u of trackedUnlinks) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") break;
        const candidates = (addsBySize.get(u.size) ?? []).filter(c => !claimedAdds.has(c.relPath));
        if (candidates.length === 0) continue;

        let matched: { relPath: string; path: string } | null = null;
        if (u.record.contentHash && u.size <= MOVE_HASH_LIMIT) {
          // Prove identity by streaming content hash (low RAM) — safe at any
          // size, so small hashed files still get clean moves.
          for (const c of candidates) {
            const h = await hashFile(longPath(c.path)).catch(() => null);
            if (h && h === u.record.contentHash) { matched = c; break; }
          }
        } else if (
          u.size >= MIN_MOVE_SIZE &&
          candidates.length === 1 &&
          trackedUnlinkBySize.get(u.size) === 1
        ) {
          // No recorded hash (large or previously-downloaded file): accept only
          // a strictly unambiguous 1:1 pairing at a non-trivial size, where a
          // coincidental same-size collision is very unlikely.
          matched = candidates[0];
        }

        if (matched) {
          moves.set(u.oldRel, matched.relPath);
          claimedAdds.add(matched.relPath);
          handledPaths.add(matched.relPath);
          handledPaths.add(u.oldRel);
        }
      }

      // Process detected moves via server move API
      for (const [oldRel, newRel] of moves) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") break;
        const existing = this.lookupByPath(rt, oldRel);
        if (!existing) continue;

        const newParentRelPath = newRel.split("/").slice(0, -1).join("/");
        const newFolderId = newParentRelPath
          ? (rt.state.folders[newParentRelPath]?.remoteId ?? rt.pair.remoteFolderId)
          : rt.pair.remoteFolderId;
        const newFileName = newRel.split("/").pop()!;

        try {
          // Move to new folder
          await this.client.moveFile(existing.remoteId, newFolderId);
          // Rename if name changed
          const oldFileName = oldRel.split("/").pop()!;
          if (oldFileName !== newFileName) {
            await this.client.renameFile(existing.remoteId, newFileName);
          }
          // Update local state
          existing.record.localPath = newRel;
          existing.record.remoteFolderId = newFolderId;
          existing.record.remoteName = newFileName;
          rt.pathIndex.delete(oldRel);
          rt.pathIndex.set(newRel, existing.remoteId);
          this.log(rt.pair.id, `Moved: ${oldRel} → ${newRel}`);
        } catch (e: any) {
          if (e.message === "SESSION_EXPIRED") throw e;
          if (isRateLimitError(e)) throw e;
          // Move failed — fall through to delete+re-upload in the normal event loop
          handledPaths.delete(oldRel);
          handledPaths.delete(newRel);
          moves.delete(oldRel);
        }
      }

      for (const event of events) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") break;
        const relPath = toRelPath(rt.pair.localPath, event.path);
        const fileName = relPath.split("/").pop()!;

        // Skip events already handled as moves
        if (handledPaths.has(relPath)) continue;

        // Use shared ignore filter
        if (shouldIgnoreEntry(fileName, event.type === "addDir" || event.type === "unlinkDir", rt.pair.excludedPatterns)) continue;

        const mode = rt.pair.syncMode || "push-safe";

        if (event.type === "addDir") {
          await this.ensureRemoteFolder(rt, relPath);
        } else if (event.type === "add" || event.type === "change") {
          // FIX: Suppress events triggered by our own downloads to prevent
          // download → re-upload → re-download infinite loop.
          if (this.isRecentDownload(event.path)) {
            continue;
          }

          // FIX: Also check if file matches stored state (mtime + size unchanged).
          // This catches cases where the TTL expired but the file is still our download.
          const existing = this.lookupByPath(rt, relPath);
          if (existing) {
            const s = await stat(longPath(event.path)).catch(() => null);
            if (s && s.mtimeMs === existing.record.localMtimeMs && s.size === existing.record.localSizeBytes) {
              continue; // File unchanged — event was triggered by our own write or metadata touch
            }
          }

          // Skip files that are still being written (a later change event will
          // re-trigger once they settle) — avoids backing up partial content.
          if (!(await this.isFileStable(event.path))) continue;

          try {
            await this.uploadLocalFile(rt, event.path, relPath);
          } catch (upErr: any) {
            // Don't let one file's transient upload failure abandon the rest of
            // the batch — later unlink/delete events in this same event list
            // would be silently dropped. Session/rate-limit errors are fatal
            // for the cycle (re-throw so the outer handler pauses the pair);
            // everything else is recorded per-file and we move on.
            if (upErr.message === "SESSION_EXPIRED") throw upErr;
            if (isRateLimitError(upErr)) throw upErr;
            console.error(`[sync] upload failed for ${relPath}:`, upErr.message);
            const existing = rt.state.fileErrors[relPath];
            rt.state.fileErrors[relPath] = {
              filePath: relPath,
              error: upErr.message,
              retryCount: (existing?.retryCount ?? 0) + 1,
              lastAttemptAt: Date.now(),
              permanent: upErr.message.includes("permission") || upErr.message.includes("EPERM") || upErr.message.includes("quota"),
            };
          }
        } else if (event.type === "unlink" && (mode === "two-way" || mode === "push")) {
          // Delete from cloud only in full sync or push mode (not push-safe/backup)
          const found = this.lookupByPath(rt, relPath);
          if (found) {
            try {
              await this.client.deleteFile(found.remoteId);
              delete rt.state.files[found.remoteId];
              rt.pathIndex.delete(relPath);
              console.log(`[sync] Deleted remote: ${relPath}`);
            } catch (e: any) {
              if (isRateLimitError(e)) throw e;
              console.error(`[sync] Delete remote failed: ${e.message}`);
            }
          }
        } else if (event.type === "unlinkDir" && (mode === "two-way" || mode === "push")) {
          // FIX: Handle folder deletion — delete remote folder contents.
          // Find all tracked files under this folder and delete them remotely.
          const prefix = relPath + "/";
          const toDelete: { remoteId: string; localPath: string }[] = [];
          for (const [remoteId, record] of Object.entries(rt.state.files)) {
            if (record.localPath === relPath || record.localPath.startsWith(prefix)) {
              toDelete.push({ remoteId, localPath: record.localPath });
            }
          }
          // Batch delete — 500 files per request instead of 1 per file
          if (toDelete.length > 0) {
            try {
              await this.client.deleteFilesBatch(rt.pair.workspaceId, toDelete.map(d => d.remoteId));
              for (const { remoteId, localPath } of toDelete) {
                delete rt.state.files[remoteId];
                rt.pathIndex.delete(localPath);
              }
              this.log(rt.pair.id, `Deleted ${toDelete.length} files remotely (folder removed)`);
            } catch (e: any) {
              if (isRateLimitError(e)) throw e;
              if (e.message === "SESSION_EXPIRED") throw e;
              console.error(`[sync] Batch delete failed: ${e.message}`);
            }
          }
          // Clean up folder state
          for (const folderRelPath of Object.keys(rt.state.folders)) {
            if (folderRelPath === relPath || folderRelPath.startsWith(prefix)) {
              delete rt.state.folders[folderRelPath];
            }
          }
        }
        // push-safe: skip deletes (backup mode — never delete from cloud)

        // Save state periodically
        opCount++;
        if (opCount % STATE_SAVE_INTERVAL === 0) {
          await this.safeSaveState(rt.state);
        }
      }

      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      rt.status = "idle";
      rt.state.lastFullSyncAt = Date.now();
      await this.safeSaveState(rt.state);
    } catch (err: any) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
      if (err.message === "SESSION_EXPIRED") {
        this.setError(rt, "Session expired. Please log in again.");
      } else if (isRateLimitError(err)) {
        this.pauseForRateLimit(rt, getRetryAfterMs(err));
        return;
      } else {
        this.setError(rt, err.message);
      }
    } finally {
      rt.syncing = false;
      this.emitStatus();

      // Don't re-trigger scan if paused, stopped, rate-limited, or in error
      const canRescan = !this.stopped
        && (rt.status as SyncPairStatus) !== "paused"
        && (rt.status as SyncPairStatus) !== "rate-limited"
        && (rt.status as SyncPairStatus) !== "error";
      if (rt.queuedSync && canRescan) {
        rt.queuedSync = false;
        if (rt.queuedOverflow || rt.queuedEvents.size === 0) {
          // Overflowed (or nothing precise buffered) → full rescan.
          rt.queuedOverflow = false;
          rt.queuedEvents.clear();
          this.runInitialScan(pairId);
        } else {
          // Replay the exact buffered events so deletes/moves are honored.
          const drained = Array.from(rt.queuedEvents.values());
          rt.queuedEvents.clear();
          this.handleLocalChanges(pairId, drained);
        }
      }
    }
  }

  // ── Handle remote changes (pull / pull-safe modes) ────────────────

  private async handleRemoteChanges(pairId: string, snapshot: RemoteSnapshot): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt || rt.status === "paused" || rt.status === "rate-limited" || rt.syncing) return;

    const mode = rt.pair.syncMode || "push-safe";
    if (!["pull", "pull-safe"].includes(mode)) return;

    rt.syncing = true;
    rt.status = "syncing";
    this.beginSyncCycle(rt);
    this.emitStatus();

    let opCount = 0;

    try {
      // Build path map from remote files
      const folderPaths = new Map<string, string>();
      // Cycle/depth guard: a corrupt or cyclic parent_id chain would otherwise
      // recurse until the stack overflows (matches reconciler.buildRemotePaths).
      const buildingFolder = new Set<string>();
      const MAX_REMOTE_FOLDER_DEPTH = 100;
      for (const [id] of snapshot.folders) {
        const buildPath = (fid: string, depth: number): string => {
          if (folderPaths.has(fid)) return folderPaths.get(fid)!;
          if (buildingFolder.has(fid) || depth > MAX_REMOTE_FOLDER_DEPTH) return ""; // cycle or runaway depth
          buildingFolder.add(fid);
          const f = snapshot.folders.get(fid);
          if (!f) return "";
          if (!f.parent_id || f.parent_id === rt.pair.remoteFolderId) {
            folderPaths.set(fid, f.name);
            return f.name;
          }
          const parentPath = buildPath(f.parent_id, depth + 1);
          const p = parentPath ? `${parentPath}/${f.name}` : f.name;
          folderPaths.set(fid, p);
          return p;
        };
        buildPath(id, 0);
      }

      // Guard disk space up-front — pull can otherwise fill the volume.
      let neededBytes = 0;
      for (const [remoteId, file] of snapshot.files) {
        const existing = rt.state.files[remoteId];
        if (!existing || file.updated_at !== existing.remoteUpdatedAt || file.size_bytes !== existing.remoteSizeBytes) {
          neededBytes += file.size_bytes;
        }
      }
      await this.ensureDiskSpace(rt.pair.localPath, neededBytes);

      // Download new/changed remote files
      for (const [remoteId, file] of snapshot.files) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") break;
        const folderId = file.folder_id;
        let relDir = "";
        if (folderId && folderId !== rt.pair.remoteFolderId) {
          relDir = folderPaths.get(folderId) ?? "";
        }
        const relPath = normalizeRel(relDir ? `${relDir}/${file.name}` : file.name);

        // FIX: Path traversal validation
        if (!this.isPathSafe(rt.pair.localPath, relPath)) {
          console.error("[sync] Path traversal blocked:", relPath);
          continue;
        }

        const absPath = join(rt.pair.localPath, relPath);
        const existing = rt.state.files[remoteId];

        if (!existing) {
          await mkdir(longPath(dirname(absPath)), { recursive: true });
          await this.downloadRemoteFile(rt, file, absPath, relPath);
        } else if (
          file.updated_at !== existing.remoteUpdatedAt ||
          file.size_bytes !== existing.remoteSizeBytes
        ) {
          await this.downloadRemoteFile(rt, file, absPath, relPath);
        }

        opCount++;
        if (opCount % STATE_SAVE_INTERVAL === 0) {
          await this.safeSaveState(rt.state);
        }
      }

      // Handle remote deletions (only in pull, not pull-safe).
      // Safety check: if the snapshot has significantly fewer files than stored
      // state, skip deletions to avoid data loss from incomplete snapshots
      // (e.g., API pagination errors or network interruptions).
      if (mode === "pull") {
        const remoteIds = new Set(snapshot.files.keys());
        const storedCount = Object.keys(rt.state.files).length;
        const missingCount = [...Object.keys(rt.state.files)].filter(id => !remoteIds.has(id)).length;

        // If more than 50% of tracked files are missing from the snapshot
        // and there are more than 5 missing, assume the snapshot is incomplete.
        const snapshotLooksIncomplete = storedCount > 10 && missingCount > 5 && missingCount > storedCount * 0.5;

        if (snapshotLooksIncomplete) {
          console.warn(
            `[sync] Skipping pull deletions: ${missingCount}/${storedCount} files missing from snapshot. ` +
            `This likely indicates an incomplete remote snapshot.`,
          );
        } else {
          for (const [id, record] of Object.entries(rt.state.files)) {
            if (!remoteIds.has(id)) {
              const absPath = join(rt.pair.localPath, record.localPath);
              try {
                await unlink(longPath(absPath));
                delete rt.state.files[id];
                rt.pathIndex.delete(record.localPath);
                console.log(`[sync] Deleted local: ${record.localPath}`);
              } catch {
                delete rt.state.files[id];
                rt.pathIndex.delete(record.localPath);
              }
            }
          }
        }
      }

      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      rt.status = "idle";
      rt.state.lastFullSyncAt = Date.now();
      rt.state.lastRemotePollAt = Date.now();
      await this.safeSaveState(rt.state);
    } catch (err: any) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
      if (err.message === "SESSION_EXPIRED") {
        this.setError(rt, "Session expired. Please log in again.");
      } else if (isRateLimitError(err)) {
        this.pauseForRateLimit(rt, getRetryAfterMs(err));
        return;
      } else {
        this.setError(rt, err.message);
      }
    } finally {
      rt.syncing = false;
      this.emitStatus();
    }
  }

  /**
   * Best-effort check that a file isn't still being written. Only files
   * touched in the last ~2s pay a small delay; everything else returns
   * immediately. Cheap insurance against uploading a half-written file when
   * a large copy outruns the watcher debounce (awaitWriteFinish is disabled
   * for memory reasons, so this is our stability gate).
   */
  private async isFileStable(absPath: string): Promise<boolean> {
    const p = longPath(absPath);
    const s1 = await stat(p).catch(() => null);
    if (!s1) return false;
    if (Date.now() - s1.mtimeMs > 2000) return true; // at rest already
    await new Promise((r) => setTimeout(r, 400));
    const s2 = await stat(p).catch(() => null);
    if (!s2) return false;
    return s2.size === s1.size && s2.mtimeMs === s1.mtimeMs;
  }

  // ── Disk-space guard (downloads only) ─────────────────────────────

  /**
   * Throw if the destination volume can't hold `neededBytes` plus a safety
   * margin. Downloads are the only operation that consumes local disk, so
   * this guards the download/pull paths — uploads never call it (a backup
   * FROM a nearly-full disk must still be able to upload).
   */
  private async ensureDiskSpace(localPath: string, neededBytes: number): Promise<void> {
    let freeBytes: number | null = null;
    try {
      const s = await statfs(localPath);
      freeBytes = s.bavail * s.bsize;
    } catch {
      freeBytes = null; // statfs unavailable (some network drives) — allow
    }
    if (freeBytes === null) return;
    const MARGIN = 256 * 1024 * 1024; // keep 256 MB headroom
    if (freeBytes < neededBytes + MARGIN) {
      const freeMB = Math.round(freeBytes / (1024 * 1024));
      const needMB = Math.round((neededBytes + MARGIN) / (1024 * 1024));
      throw new Error(`Low disk space: ${freeMB.toLocaleString()} MB free, need ~${needMB.toLocaleString()} MB. Free up space to continue syncing.`);
    }
  }

  // ── Download a single remote file ────────��────────────────────────

  private async downloadRemoteFile(
    rt: PairRuntime,
    file: RemoteFileInfo,
    absPath: string,
    relPath: string,
  ): Promise<void> {
    if (this.stopped) return;
    await this.transferSemaphore.acquire();
    if (this.stopped) { this.transferSemaphore.release(); return; }

    const transfer: ActiveTransfer = {
      pairId: rt.pair.id,
      filePath: relPath,
      fileName: file.name,
      direction: "download",
      bytesTotal: file.size_bytes,
      bytesTransferred: 0,
      startedAt: Date.now(),
    };
    this.activeTransfers.add(transfer);
    this.emitStatus();

    try {
      let lastProgressEmit = 0;
      await this.client.downloadFile(
        file.id,
        absPath,
        file.size_bytes,
        (bytes) => {
          transfer.bytesTransferred = bytes;
          // Throttle progress updates to avoid flooding IPC on large files
          const now = Date.now();
          if (now - lastProgressEmit > 500) {
            lastProgressEmit = now;
            this.markProgress(rt); // bytes flowing = progress (keeps watchdog quiet)
            this.emitStatus();
          }
        },
      );

      const s = await stat(longPath(absPath));

      // Mark as recently downloaded to suppress watcher re-upload
      this.markRecentDownload(absPath);

      rt.state.files[file.id] = {
        remoteId: file.id,
        remoteName: file.name,
        remoteFolderId: file.folder_id,
        remoteSizeBytes: file.size_bytes,
        remoteUpdatedAt: file.updated_at,
        remoteVersion: file.current_version,
        localPath: relPath,
        localSizeBytes: s.size,
        localMtimeMs: s.mtimeMs,
        syncedAt: Date.now(),
      };
      rt.pathIndex.set(relPath, file.id);

      delete rt.state.fileErrors[relPath];
    } finally {
      this.activeTransfers.delete(transfer);
      this.transferSemaphore.release();
      this.emitStatus();
    }
  }

  // ── Upload a single file ──────��───────────────────────────────────

  private async uploadLocalFile(rt: PairRuntime, absPath: string, relPath: string): Promise<void> {
    if (this.stopped) return;
    await this.transferSemaphore.acquire();

    // Everything after acquire() runs inside try/finally so the permit is
    // ALWAYS released. Previously `stat()` (below) ran before the try — when it
    // threw (file deleted/renamed/permission-denied between scan and upload, a
    // routine event mid-sync) the permit leaked. After enough leaks the
    // semaphore's capacity hit zero and every upload worker blocked on
    // acquire() forever, freezing the pair at "syncing" with no more uploads.
    let transfer: ActiveTransfer | null = null;
    try {
      if (this.stopped) return;

      const fileName = relPath.split("/").pop()!;
      const s = await stat(longPath(absPath));

      // Find the remote folder ID for this file's parent directory
      const parentRelPath = relPath.split("/").slice(0, -1).join("/");
      const remoteFolderId = parentRelPath
        ? (rt.state.folders[parentRelPath]?.remoteId ?? rt.pair.remoteFolderId)
        : rt.pair.remoteFolderId;

      const t: ActiveTransfer = {
        pairId: rt.pair.id,
        filePath: relPath,
        fileName,
        direction: "upload",
        bytesTotal: s.size,
        bytesTransferred: 0,
        startedAt: Date.now(),
      };
      transfer = t;
      this.activeTransfers.add(t);
      this.emitStatus();

      const existing = this.lookupByPath(rt, relPath);
      const existingFileId = existing?.remoteId ?? null;

      let lastUploadEmit = 0;
      const result = await this.client.uploadFile(
        absPath,
        rt.pair.workspaceId,
        remoteFolderId,
        rt.pair.region,
        existingFileId,
        (bytes) => {
          t.bytesTransferred = bytes;
          const now = Date.now();
          if (now - lastUploadEmit > 500) {
            lastUploadEmit = now;
            this.markProgress(rt); // bytes flowing = progress (keeps watchdog quiet)
            this.emitStatus();
          }
        },
      );

      // Re-stat after upload to get the actual mtime (file may have been modified during upload)
      const postStat = await stat(longPath(absPath)).catch(() => s);

      // Prefer the server's authoritative version/updated_at when returned;
      // fall back to a client estimate only if the endpoint omitted them.
      // Guessing these is a source of spurious download-update churn.
      const version = result.version ?? (existing ? existing.record.remoteVersion + 1 : 1);
      const remoteUpdatedAt = result.updatedAt ?? Math.floor(Date.now() / 1000);

      // Clean up old entry if fileId changed
      if (existingFileId && existingFileId !== result.fileId) {
        delete rt.state.files[existingFileId];
      }

      // Compute content hash for future dedup (mtime change without content change).
      // Skip hashing for large files (>50MB) — the hash would require re-reading
      // the entire file from disk after just uploading it. For a 1.5GB file that's
      // another 1.5GB of I/O. Large files rarely get false-positive mtime changes
      // and the size check alone is sufficient for them.
      const HASH_SIZE_LIMIT = 50 * 1024 * 1024; // 50 MB
      const fileHash = postStat.size <= HASH_SIZE_LIMIT
        ? await hashFile(longPath(absPath)).catch(() => undefined)
        : undefined;

      rt.state.files[result.fileId] = {
        remoteId: result.fileId,
        remoteName: result.name,
        remoteFolderId: remoteFolderId,
        remoteSizeBytes: postStat.size,
        remoteUpdatedAt,
        remoteVersion: version,
        localPath: relPath,
        localSizeBytes: postStat.size,
        localMtimeMs: postStat.mtimeMs,
        syncedAt: Date.now(),
        contentHash: fileHash,
      };
      rt.pathIndex.set(relPath, result.fileId);

      // Collect file ID for batched sync-flag call (done at end of scan, not per-file).
      // For individual watcher events, set the flag inline.
      if (rt.totalFilesInBatch > 0) {
        this.pendingSyncFlagIds.push(result.fileId);
      } else if (!this.stopped) {
        this.client.setFileSyncFlag(result.fileId, true).catch(() => {});
      }

      delete rt.state.fileErrors[relPath];
    } finally {
      if (transfer) this.activeTransfers.delete(transfer);
      this.transferSemaphore.release();
      this.emitStatus();
    }
  }

  /**
   * Flush accumulated sync-flag IDs in one batched burst.
   * Called at the end of scan/reconcile instead of after every file upload.
   */
  private async flushSyncFlags(): Promise<void> {
    if (this.pendingSyncFlagIds.length === 0 || this.stopped) return;
    const ids = this.pendingSyncFlagIds.splice(0);
    console.log(`[sync] Setting sync flag on ${ids.length} files`);
    try {
      await this.client.batchSetFileSyncFlags(ids, true);
    } catch (err: any) {
      if (err.message !== "SESSION_EXPIRED") {
        console.error("[sync] Batch sync-flag failed:", err.message);
      }
    }
  }

  // ── Ensure remote folder exists ───────────────────────────────────

  private async ensureRemoteFolder(rt: PairRuntime, relPath: string): Promise<string> {
    if (rt.state.folders[relPath]) {
      return rt.state.folders[relPath].remoteId;
    }

    const parts = relPath.split("/");
    let parentRemoteId = rt.pair.remoteFolderId;

    for (let i = 0; i < parts.length; i++) {
      const partialPath = parts.slice(0, i + 1).join("/");

      if (rt.state.folders[partialPath]) {
        parentRemoteId = rt.state.folders[partialPath].remoteId;
        continue;
      }

      const folderId = await this.client.createFolder(
        rt.pair.workspaceId,
        parts[i],
        parentRemoteId,
      );

      rt.state.folders[partialPath] = {
        remoteId: folderId,
        remoteName: parts[i],
        remoteParentId: parentRemoteId,
        localPath: partialPath,
        syncedAt: Date.now(),
      };

      try {
        await this.client.setFolderSyncFlag(folderId, true);
      } catch (e: any) {
        console.error(`[sync] Failed to set folder sync flag: ${e.message}`);
      }

      parentRemoteId = folderId;
      console.log(`[sync] Created remote folder: ${partialPath} → ${folderId}`);
    }

    return parentRemoteId!;
  }

  // ── Public API ────────────────────────────────────────────────────

  async getConfig(): Promise<SyncConfig> {
    if (!this.config) this.config = await loadConfig();
    return this.config;
  }

  async saveGlobalConfig(updates: Partial<SyncConfig>): Promise<void> {
    return this.withConfigLock(() => this.saveGlobalConfigLocked(updates));
  }

  private async saveGlobalConfigLocked(updates: Partial<SyncConfig>): Promise<void> {
    // Reload fresh inside the lock — like addPair/updatePair/removePair — so a
    // racing pair mutation (each does this.config = await loadConfig()) can't
    // silently revert the global setting we're about to change.
    this.config = await loadConfig();
    // Update concurrency limit if changed
    if (typeof updates.maxConcurrentTransfers === "number" && updates.maxConcurrentTransfers > 0) {
      this.transferSemaphore.updateMax(updates.maxConcurrentTransfers);
    }
    Object.assign(this.config, updates);
    // Apply bandwidth caps live (0 = unlimited).
    if (updates.maxUploadBytesPerSec !== undefined || updates.maxDownloadBytesPerSec !== undefined) {
      this.client.setBandwidthLimits(this.config.maxUploadBytesPerSec || 0, this.config.maxDownloadBytesPerSec || 0);
    }
    await saveConfig(this.config);
  }

  getStatus(): SyncStatus {
    const pairs: SyncPairRuntimeStatus[] = [];
    for (const [, rt] of this.runtimes) {
      pairs.push({
        pairId: rt.pair.id,
        workspaceId: rt.pair.workspaceId,
        workspaceName: rt.pair.workspaceName,
        remoteFolderName: rt.pair.remoteFolderName,
        localPath: rt.pair.localPath,
        syncMode: rt.pair.syncMode || "push-safe",
        status: rt.status,
        lastSyncedAt: rt.state.lastFullSyncAt || null,
        errorMessage: rt.errorMessage,
        filesInQueue: 0,
        totalFilesInBatch: rt.totalFilesInBatch,
        completedFilesInBatch: rt.completedFilesInBatch,
        totalBytesInBatch: rt.totalBytesInBatch,
        completedBytesInBatch: rt.completedBytesInBatch,
        batchStartedAt: rt.batchStartedAt,
        syncStartedAt: rt.syncStartedAt,
        phase: rt.phase,
        scannedFiles: rt.scannedFiles,
        scannedFolders: rt.scannedFolders,
        statusText: rt.statusText,
      });
    }
    return {
      pairs,
      globalPaused: this.config?.pausedGlobally ?? false,
      activeTransfers: [...this.activeTransfers],
      unresolvedConflicts: this.conflicts,
      recentLogs: this.logs.slice(-50),
    };
  }

  async addPair(pair: SyncPair): Promise<void> {
    return this.withConfigLock(() => this.addPairLocked(pair));
  }

  private async addPairLocked(pair: SyncPair): Promise<void> {
    // Sync only works while logged in — refuse before persisting anything.
    // (If a session exists but the engine hasn't started yet — the delayed
    // boot start — the pair is saved and picked up when start() runs.)
    if (!(await this.client.hasSession())) {
      throw new Error("You must be logged in to add a sync folder.");
    }
    this.config = await loadConfig();

    // Prevent overlapping sync pairs — two pairs watching the same or nested
    // local paths would race on watcher events and double-upload.
    // Compare on normalized keys: on macOS/Windows "/Users/x/Docs" and
    // "/users/x/docs" are the SAME folder, and a case-sensitive compare would
    // let the very overlap this guard exists to prevent slip through.
    const newKey = absKey(resolve(pair.localPath));
    for (const existing of this.config.pairs) {
      const existingKey = absKey(resolve(existing.localPath));
      const isSame = newKey === existingKey;
      const isInside = newKey.startsWith(existingKey + sep);
      const contains = existingKey.startsWith(newKey + sep);
      if (isSame || isInside || contains) {
        // Name the conflicting LOCAL path — that's what the user has to act on.
        const relation = isSame ? "is already being synced"
          : isInside ? "is inside a folder that's already synced"
          : "contains a folder that's already synced";
        throw new Error(
          `This folder ${relation}: "${existing.localPath}" → "${existing.remoteFolderName}". ` +
          `Remove that sync folder first, or choose a different one.`,
        );
      }
    }

    if (this.config.pausedGlobally) {
      this.config.pausedGlobally = false;
    }

    this.config.pairs.push(pair);
    await saveConfig(this.config);

    if (pair.remoteFolderId) {
      try {
        await this.client.setFolderSyncFlag(pair.remoteFolderId, true);
      } catch (e: any) {
        console.error("[sync] Failed to set sync flag on add:", e.message);
      }
    }

    if (pair.enabled) {
      console.log("[sync] Starting pair:", pair.id, pair.localPath);
      await this.startPair(pair);
    }
  }

  async removePair(pairId: string): Promise<void> {
    return this.withConfigLock(() => this.removePairLocked(pairId));
  }

  private async removePairLocked(pairId: string): Promise<void> {
    this.config = await loadConfig();
    const pair = this.config.pairs.find(p => p.id === pairId);

    if (pair?.remoteFolderId) {
      try {
        await this.client.setFolderSyncFlag(pair.remoteFolderId, false);
      } catch (e: any) {
        console.error("[sync] Failed to clear sync flag on remove:", e.message);
      }
    }

    await this.stopPair(pairId);
    this.config.pairs = this.config.pairs.filter(p => p.id !== pairId);
    await saveConfig(this.config);
    await deletePairState(pairId);
    // Remove any conflicts for this pair
    this.conflicts = this.conflicts.filter(c => c.pairId !== pairId);
    this.emitStatus();
  }

  async updatePair(pairId: string, updates: Partial<SyncPair>): Promise<void> {
    return this.withConfigLock(() => this.updatePairLocked(pairId, updates));
  }

  private async updatePairLocked(pairId: string, updates: Partial<SyncPair>): Promise<void> {
    this.config = await loadConfig();
    const idx = this.config.pairs.findIndex(p => p.id === pairId);
    if (idx === -1) throw new Error("Pair not found");
    this.config.pairs[idx] = { ...this.config.pairs[idx], ...updates };
    await saveConfig(this.config);
    await this.stopPair(pairId);
    if (this.config.pairs[idx].enabled && !this.config.pausedGlobally) {
      await this.startPair(this.config.pairs[idx]);
    }
    this.emitStatus();
  }

  async pausePair(pairId: string): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (rt) {
      rt.watcher?.stop();
      rt.poller?.stop();
      if (rt.rateLimitResumeTimer) {
        clearTimeout(rt.rateLimitResumeTimer);
        rt.rateLimitResumeTimer = null;
      }
      // Set paused FIRST — in-flight workers check this and bail out.
      rt.status = "paused";
      rt.errorMessage = null;
      rt.syncing = false;
      rt.totalFilesInBatch = 0;
      rt.completedFilesInBatch = 0;
      rt.totalBytesInBatch = 0;
      rt.completedBytesInBatch = 0;
      rt.batchStartedAt = 0;
      rt.phase = null;
      rt.scannedFiles = 0;
      rt.scannedFolders = 0;
      rt.statusText = "";
      // Save state so already-uploaded files aren't re-uploaded on resume.
      await this.safeSaveState(rt.state);
      this.emitStatus();
    }
  }

  async resumePair(pairId: string): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (rt) {
      if (rt.rateLimitResumeTimer) {
        clearTimeout(rt.rateLimitResumeTimer);
        rt.rateLimitResumeTimer = null;
      }
      // Rebuild path index from persisted state in case it drifted during pause
      this.rebuildPathIndex(rt);
      rt.watcher?.start();
      rt.poller?.start();
      rt.status = "idle";
      this.emitStatus();
      const mode = rt.pair.syncMode || "push-safe";
      if (["two-way", "push", "push-safe"].includes(mode)) this.runInitialScan(pairId);
    }
  }

  async pauseAll(): Promise<void> {
    // Any manual pause cancels a pending timed auto-resume.
    if (this.pauseResumeTimer) { clearTimeout(this.pauseResumeTimer); this.pauseResumeTimer = null; }
    this.config = await loadConfig();
    this.config.pausedGlobally = true;
    await saveConfig(this.config);
    for (const [id] of this.runtimes) await this.pausePair(id);
  }

  /** Pause everything, then auto-resume after `ms` (a "snooze"). */
  async pauseAllFor(ms: number): Promise<void> {
    await this.pauseAll(); // clears any existing timer first
    if (ms > 0) {
      this.pauseResumeTimer = setTimeout(() => {
        this.pauseResumeTimer = null;
        this.resumeAll().catch(() => {});
      }, ms);
    }
  }

  async resumeAll(): Promise<void> {
    if (this.pauseResumeTimer) { clearTimeout(this.pauseResumeTimer); this.pauseResumeTimer = null; }
    this.config = await loadConfig();
    this.config.pausedGlobally = false;
    await saveConfig(this.config);
    for (const [id] of this.runtimes) await this.resumePair(id);
  }

  syncNow(pairId: string): void {
    const rt = this.runtimes.get(pairId);
    if (!rt) return;
    const mode = rt.pair.syncMode || "push-safe";
    if (mode === "two-way" && rt.poller) {
      // For two-way mode, trigger the reconciler via the poller
      rt.poller.triggerNow();
    } else {
      this.runInitialScan(pairId);
    }
  }

  async resolveConflict(conflictId: string, resolution: "keep-local" | "keep-remote" | "keep-both"): Promise<void> {
    const idx = this.conflicts.findIndex(c => c.id === conflictId);
    if (idx === -1) return;

    const conflict = this.conflicts[idx];
    const rt = this.runtimes.get(conflict.pairId);
    if (!rt) {
      this.conflicts.splice(idx, 1);
      this.emitStatus();
      return;
    }

    // Remove from list immediately to prevent double-resolution
    this.conflicts.splice(idx, 1);
    this.emitStatus();

    // Resolve asynchronously — awaited so IPC handler propagates errors
    try {
      if (resolution === "keep-local") {
        const relPath = toRelPath(rt.pair.localPath, conflict.localPath);
        await this.uploadLocalFile(rt, conflict.localPath, relPath);
      } else if (resolution === "keep-remote") {
        // Delete local state so the next reconcile treats the remote file as new and downloads it.
        const existing = rt.state.files[conflict.remoteId];
        if (existing) {
          // Delete the local file so the download doesn't think it's unchanged
          await unlink(longPath(conflict.localPath)).catch(() => {});
          delete rt.state.files[conflict.remoteId];
          rt.pathIndex.delete(existing.localPath);
        }
        // Trigger immediate poll instead of waiting up to 30s
        if (rt.poller) rt.poller.triggerNow();
      } else if (resolution === "keep-both") {
        // Derive the extension from the file NAME only. Scanning the whole
        // absolute path would pick up a dot from a parent directory (e.g.
        // "/a/my.dir/README" → ".dir/README"), mangling an extensionless file.
        // dotIdx > 0 also guards dotfiles (".env") and no-extension names.
        const fileName = basename(conflict.localPath);
        const dotIdx = fileName.lastIndexOf(".");
        const ext = dotIdx > 0 ? fileName.substring(dotIdx) : "";
        const base = conflict.localPath.substring(0, conflict.localPath.length - ext.length);
        const dateStr = new Date().toISOString().slice(0, 10);
        const conflictPath = `${base} (conflict ${dateStr})${ext}`;

        const { rename: fsRename } = await import("fs/promises");
        await fsRename(longPath(conflict.localPath), longPath(conflictPath));

        const conflictRelPath = toRelPath(rt.pair.localPath, conflictPath);
        await this.uploadLocalFile(rt, conflictPath, conflictRelPath);
      }

      await this.safeSaveState(rt.state);
      console.log(`[sync] Conflict resolved (${resolution}): ${conflict.remoteName}`);
    } catch (err: any) {
      console.error(`[sync] Failed to resolve conflict: ${err.message}`);
      // Re-add conflict if resolution failed so user can retry
      this.conflicts.push(conflict);
      this.emitStatus();
    }
  }

  getConflicts(): SyncConflict[] {
    return [...this.conflicts];
  }

  isRunning(): boolean {
    return this.started;
  }

  /** Notify sync engine that the app window visibility changed.
   *  When hidden (tray), pollers slow down to save API calls. */
  setAppVisible(visible: boolean): void {
    for (const [, rt] of this.runtimes) {
      rt.poller?.setAppVisible(visible);
    }
  }

  getClient(): RemoteClient {
    return this.client;
  }

  /**
   * Pre-populate sync state from a remote snapshot when state is empty.
   * Matches remote files to local files by name+size so the reconciler
   * or scanner can skip files that already exist identically on both sides.
   * Used by both push-mode (scanAndUpload) and two-way (runInitialReconcile).
   */
  private async prePopulateStateFromRemote(rt: PairRuntime): Promise<RemoteSnapshot | null> {
    const { pair, state } = rt;
    if (Object.keys(state.files).length > 0 || !pair.remoteFolderId) return null;

    rt.statusText = "Comparing with server...";
    this.log(pair.id, "Fetching remote file list...");
    this.emitStatus();

    const fast = await this.client.fetchSnapshotFast(
      pair.workspaceId,
      pair.remoteFolderId,
      undefined,
      (filesSoFar) => {
        rt.statusText = `Comparing with server... ${filesSoFar.toLocaleString()} remote files`;
        this.markProgress(rt, `Fetched ${filesSoFar.toLocaleString()} remote files so far...`);
        this.emitStatus();
      },
    );
    if (!fast) return null;

    const snapshot: RemoteSnapshot = {
      files: new Map(fast.files.map(f => [f.id, f] as const)),
      folders: new Map(fast.folders.map(f => [f.id, f] as const)),
    };

    // Build folder path map
    const folderPaths = new Map<string, string>();
    // Cycle/depth guard: a corrupt or cyclic parent_id chain would otherwise
    // recurse until the stack overflows (matches reconciler.buildRemotePaths).
    const buildingFolder = new Set<string>();
    const MAX_REMOTE_FOLDER_DEPTH = 100;
    for (const [id] of snapshot.folders) {
      const buildPath = (fid: string, depth: number): string => {
        if (folderPaths.has(fid)) return folderPaths.get(fid)!;
        if (buildingFolder.has(fid) || depth > MAX_REMOTE_FOLDER_DEPTH) return ""; // cycle or runaway depth
        buildingFolder.add(fid);
        const folder = snapshot.folders.get(fid);
        if (!folder) return "";
        const name = normalizeRel(folder.name);
        if (!folder.parent_id || folder.parent_id === pair.remoteFolderId) {
          folderPaths.set(fid, name);
          return name;
        }
        const parentPath = buildPath(folder.parent_id, depth + 1);
        const p = parentPath ? `${parentPath}/${name}` : name;
        folderPaths.set(fid, p);
        return p;
      };
      buildPath(id, 0);
    }

    // Pre-populate folder state
    for (const [id, f] of snapshot.folders) {
      const relPath = folderPaths.get(id);
      if (relPath) {
        state.folders[relPath] = {
          remoteId: id, remoteName: f.name, remoteParentId: f.parent_id,
          localPath: relPath, syncedAt: Date.now(),
        };
      }
    }

    // Pre-populate file state with localMtimeMs=0 sentinel
    for (const [id, f] of snapshot.files) {
      const dir = f.folder_id && f.folder_id !== pair.remoteFolderId
        ? folderPaths.get(f.folder_id) ?? "" : "";
      const relPath = normalizeRel(dir ? `${dir}/${f.name}` : f.name);
      state.files[id] = {
        remoteId: id, remoteName: f.name, remoteFolderId: f.folder_id,
        remoteSizeBytes: f.size_bytes, remoteUpdatedAt: f.updated_at,
        remoteVersion: f.current_version, localPath: relPath,
        localSizeBytes: f.size_bytes, localMtimeMs: 0, syncedAt: Date.now(),
      };
      rt.pathIndex.set(relPath, id);
    }

    this.log(pair.id, `Found ${snapshot.files.size.toLocaleString()} files and ${snapshot.folders.size.toLocaleString()} folders on server`);
    await this.safeSaveState(state);
    return snapshot;
  }

  /**
   * Initial reconcile for two-way mode.
   * Fetches remote snapshot, pre-populates state, runs reconciler,
   * and executes download/upload actions — all before the poller starts.
   */
  private async runInitialReconcile(pairId: string): Promise<void> {
    const rt = this.runtimes.get(pairId);
    // Also bail while stopped or paused: a trigger racing a logout/pause
    // must not flip the pair back to "syncing" mid-teardown.
    if (!rt || this.stopped || rt.syncing || rt.status === "paused" || rt.status === "rate-limited") return;

    rt.syncing = true;
    rt.status = "syncing";
    rt.phase = "scanning";
    rt.statusText = "Connecting to server...";
    this.beginSyncCycle(rt);
    this.log(pairId, "Starting initial sync...");
    this.emitStatus();

    try {
      // Pre-populate state from remote if empty
      let snapshot = await this.prePopulateStateFromRemote(rt);

      // If we didn't get a snapshot from pre-populate (state wasn't empty), fetch one now
      if (!snapshot) {
        rt.statusText = "Checking for changes...";
        this.emitStatus();
        const fast = await this.client.fetchSnapshotFast(
          rt.pair.workspaceId,
          rt.pair.remoteFolderId,
          undefined,
          (filesSoFar) => {
            rt.statusText = `Checking for changes... ${filesSoFar.toLocaleString()} remote files`;
            this.markProgress(rt, `Fetched ${filesSoFar.toLocaleString()} remote files so far...`);
            this.emitStatus();
          },
        );
        if (fast) {
          snapshot = {
            files: new Map(fast.files.map(f => [f.id, f] as const)),
            folders: new Map(fast.folders.map(f => [f.id, f] as const)),
          };
        }
      }

      if (!snapshot) {
        this.log(pairId, "Could not fetch remote state — will retry on next poll");
        rt.status = "idle";
        return;
      }

      // Run reconciler
      rt.statusText = "Scanning local files...";
      this.emitStatus();
      const actions = await reconcile(rt.pair, rt.state, snapshot, (files, folders) => {
        rt.scannedFiles = files;
        rt.scannedFolders = folders;
        rt.statusText = `Scanning local files... ${files.toLocaleString()} files, ${folders.toLocaleString()} folders`;
        this.markProgress(rt, `Scanned ${files.toLocaleString()} local files, ${folders.toLocaleString()} folders...`);
        this.emitStatus();
      });

      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      if (actions.length === 0) {
        this.log(pairId, "Everything up to date");
      } else {
        const downloads = actions.filter(a => a.type === "download-new" || a.type === "download-update").length;
        const uploads = actions.filter(a => a.type === "upload-new" || a.type === "upload-update").length;
        const deletes = actions.filter(a => a.type === "delete-local" || a.type === "delete-remote").length;
        this.log(pairId, `Reconcile: ${downloads} downloads, ${uploads} uploads, ${deletes} deletes`);
      }

      await this.executeActions(rt, actions);
      await this.flushSyncFlags();

      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      rt.status = "idle";
      rt.state.lastFullSyncAt = Date.now();
      rt.state.lastRemotePollAt = Date.now();
      await this.safeSaveState(rt.state);
      this.log(pairId, "Initial sync complete");
    } catch (err: any) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
      if (err.message === "SESSION_EXPIRED") {
        this.setError(rt, "Session expired. Please log in again.");
      } else if (isRateLimitError(err)) {
        this.pauseForRateLimit(rt, getRetryAfterMs(err));
        return;
      } else {
        this.setError(rt, err.message);
      }
    } finally {
      if ((rt.status as SyncPairStatus) !== "rate-limited") {
        rt.totalFilesInBatch = 0;
        rt.completedFilesInBatch = 0;
        rt.totalBytesInBatch = 0;
        rt.completedBytesInBatch = 0;
        rt.batchStartedAt = 0;
        rt.phase = null;
        rt.scannedFiles = 0;
        rt.scannedFolders = 0;
        rt.statusText = "";
      }
      rt.syncing = false;
      this.emitStatus();
    }
  }

  /** Clean up orphaned .dosya-sync-tmp files left by crashed downloads. */
  private async cleanupTempFiles(dir: string): Promise<void> {
    let entries;
    try { entries = await readdir(longPath(dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith(".dosya-sync-tmp") || entry.name.endsWith(".dosya-sync-tmp.meta"))) {
        await unlink(longPath(fullPath)).catch(() => {});
      } else if (entry.isDirectory() && !shouldIgnoreEntry(entry.name, true)) {
        await this.cleanupTempFiles(fullPath);
      }
    }
  }

  /** Add a log entry visible in the UI Activity tab. */
  private log(pairId: string, message: string): void {
    this.logs.push({ timestamp: Date.now(), pairId, message });
    if (this.logs.length > SyncEngine.MAX_LOGS) {
      this.logs = this.logs.slice(-SyncEngine.MAX_LOGS);
    }
  }

  private emitStatus(): void {
    // Guard: don't emit after engine is torn down (listeners may be gone)
    if (!this.started && this.runtimes.size === 0) return;

    // Throttle: during large batch operations (scans, reconciles), status
    // events fire on every file. Coalesce them into at most one emission
    // per 500ms to avoid flooding IPC and burning CPU on serialization.
    if (this.statusTimer) {
      this.statusDirty = true;
      return;
    }
    this.emit("status-changed", this.getStatus());
    this.statusTimer = setTimeout(() => {
      this.statusTimer = null;
      if (this.statusDirty) {
        this.statusDirty = false;
        if (!this.started && this.runtimes.size === 0) return;
        this.emit("status-changed", this.getStatus());
      }
    }, 500);
  }
}
