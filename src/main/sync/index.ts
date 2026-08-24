import { EventEmitter } from "events";
import { access, readdir, stat, statfs, unlink, mkdir } from "fs/promises";
import { join, resolve, sep, basename, dirname } from "path";
import { toRelPath, normalizeRel, pathKey, absKey, longPath, isPathWithinRoot } from "./paths";
import { loadConfig, saveConfig, loadPairState, deletePairState, openSyncIndex, syncStateDir, setSyncDataDir } from "./config";
import type { SyncIndex, PairMeta } from "./index-db";
import { migrateJsonStateIfNeeded } from "./index-migrate";
import { mergeStatusPairs } from "./status-merge";
import { plan, filterOpsForMode, type BaseView, type LocalFile, type PlanOp } from "./planner";
import { Backpressure } from "./async-queue";
import type { QueuedOp } from "./index-db";
import { forbiddenSyncRootReason } from "./system-paths";
import { homedir, tmpdir, hostname } from "os";
import { RemoteClient, RateLimitError } from "./remote-client";
import { directConcurrencyFor } from "./transfer-concurrency";
import { LocalWatcher, type WatchEvent, shouldIgnoreEntry, ignoreReason } from "./local-watcher";
import { RemotePoller, type RemoteSnapshot } from "./remote-poller";
import { reconcile, reconcileRemoteOnly } from "./reconciler";
import { hashFile } from "./hash";
import { chunkFile } from "./chunker";
import { blockTrackingApplies, shouldAttemptDelta, deltaIsWorthIt } from "./delta-eligibility";
import { conflictCopyName } from "./conflict-name";
import type { EnvProvider } from "./env-provider";
import { createElectronEnv } from "./electron-env";
import { existsSync } from "fs";
import type {
  SyncConfig,
  SyncPair,
  SyncPairState,
  SyncStatus,
  SyncPairRuntimeStatus,
  SyncNotice,
  SyncPairStatus,
  ActiveTransfer,
  SyncConflict,
  SyncAction,
  SyncMode,
  RemoteFileInfo,
  SyncFileRecord,
  SyncFolderRecord,
  SyncFileError,
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

// ── Constants ───────��────────────────────────────────���──────────────

const RECENT_DOWNLOAD_TTL_MS = 120_000; // suppress watcher events for 2 min after download (large files can take >10s)
const SESSION_RECOVERY_MS = 30_000; // check for session recovery every 30s
/** Scanner stops enqueueing at this depth and resumes once drained to LOW. */
const OPS_QUEUE_HIGH_WATER = 20_000;
const OPS_QUEUE_LOW_WATER = 5_000;
/** Ops claimed per drain cycle. */
const OPS_BATCH = 200;
/** Completed ops are kept this long for resume clarity, then swept. */
const OPS_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Files given a content hash per idle pass. Bounded so it never competes. */
const HASH_BACKFILL_BATCH = 500;
const MAX_FILE_RETRIES = 5; // max retry attempts per persistently failing file
/** Rescan interval when live watching was abandoned (tree too big - EMFILE). */
const DEGRADED_RESCAN_MS = 10 * 60 * 1000;

/**
 * Whether an upload failure is worth giving up on immediately, or should be
 * left to the normal MAX_FILE_RETRIES ladder.
 *
 * The distinction matters most on Windows: antivirus, Search Indexer and
 * ordinary applications take brief exclusive locks, which surface as EPERM or
 * EACCES. Those were being matched by a bare `includes("permission")` - the
 * same test meant for the server's "You don't have permission..." 403 - so one
 * unlucky moment marked a file permanently failed and no later cycle would
 * ever retry it. The OS codes are therefore checked FIRST, because the text of
 * "EPERM: operation not permitted" contains "permitted", not "permission",
 * but EACCES messages do read "permission denied".
 */
/**
 * Whether a pair's error message describes a connectivity failure - i.e. one
 * that resolves by itself once the network is back, so the pair should be
 * retried rather than left parked until the app restarts.
 */
function isNetworkErrorMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|EAI_AGAIN|UND_ERR|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED)\b/i.test(message)
    || /\b(fetch failed|network error|socket hang up|request timed out)\b/i.test(message);
}

function isPermanentUploadError(message: string): boolean {
  if (/\b(EPERM|EACCES|EBUSY|ETXTBSY|EAGAIN|EMFILE|ENFILE)\b/.test(message)) return false;
  if (message.includes("quota")) return true;
  if (message.toLowerCase().includes("permission")) return true;
  return false;
}

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
  /** Timer for auto-resuming after rate limit pause */
  rateLimitResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Periodic rescan timer used when the watcher degraded (tree too large). */
  rescanTimer: ReturnType<typeof setInterval> | null;
  /** Non-fatal conditions surfaced to the UI, keyed by kind so a repeating
   *  condition updates its notice instead of stacking duplicates. */
  notices: Map<SyncNotice["kind"], SyncNotice>;
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
  /** Last time this pair reported forward progress - drives the stall watchdog. */
  lastProgressAt: number;
  /** Throttle for periodic "still scanning/fetching…" progress logs. */
  lastProgressLogAt: number;
}

/** One file the push scan queued for upload. */
type UploadEntry = { absPath: string; relPath: string; isNew: boolean; sizeBytes: number };
/** A tracked file whose mtime changed but size didn't - hash to decide. */
type NeedsHashEntry = { absPath: string; relPath: string; sizeBytes: number; record: import("./types").SyncFileRecord };

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
 * SyncEngine - bidirectional sync engine for dosya.dev.
 *
 * Supports five sync modes:
 *   two-way    - reconciler-based three-way diff (watcher + poller + reconciler)
 *   push       - upload local changes, delete remote on local delete
 *   push-safe  - upload only, never delete remote (backup mode)
 *   pull       - download remote changes, delete local on remote delete
 *   pull-safe  - download only, never delete local
 */
export class SyncEngine extends EventEmitter {
  private config: SyncConfig | null = null;
  private client: RemoteClient;
  private runtimes = new Map<string, PairRuntime>();
  private activeTransfers = new Set<ActiveTransfer>();
  private started = false;
  private conflicts: SyncConflict[] = [];

  /** Paths recently written by download - watcher events for these are suppressed. */
  private recentDownloads = new Map<string, number>();

  /** Rolling log buffer (last 200 entries) - shown in the UI Activity tab. */
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

  /**
   * Serializes config-mutating operations (add/remove/update pair).
   * Each of those does load → check → save, and `this.config` is shared
   * instance state. Without this lock two concurrent calls both load the same
   * config, both pass the overlap check, and both push - which is how exact
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
   * stop's runtimes.clear() could wipe pairs a newer start just created -
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
   * Size-agnostic form; the small-file upload loop calls
   * directConcurrencyFor per chunk to run tiny-file chunks deeper.
   */
  private directTransferConcurrency(): number {
    return directConcurrencyFor(this.config?.maxConcurrentTransfers || 3, Number.POSITIVE_INFINITY);
  }

  // ── Write-through persistence ─────────────────────────────────────
  //
  // Every mutation of a pair's base tree goes through one of these helpers:
  // they update the in-memory working copy AND the durable index together,
  // in one place. Before this, state lived only in RAM until a periodic
  // whole-blob save, so a crash lost up to 500 file operations - and the save
  // itself was the memory spike that made a 500K-file sync fatal
  // (2026-08-20 stress test).
  //
  // Phase 3 deletes the in-memory maps entirely and reads straight from the
  // index; these helpers are the seam that makes that a small change.

  /** The process-wide index. Lazily resolved so construction order is free. */
  private get index(): SyncIndex {
    return openSyncIndex();
  }

  private putFile(rt: PairRuntime, record: SyncFileRecord): void {
    this.index.upsertFile(rt.pair.id, record);
  }

  private dropFile(rt: PairRuntime, remoteId: string): void {
    this.index.deleteFileById(rt.pair.id, remoteId);
  }

  private putFolder(rt: PairRuntime, record: SyncFolderRecord): void {
    this.index.upsertFolder(rt.pair.id, record);
  }

  private dropFolder(rt: PairRuntime, relPath: string): void {
    this.index.deleteFolder(rt.pair.id, relPath);
  }

  private putError(rt: PairRuntime, err: SyncFileError): void {
    this.index.upsertError(rt.pair.id, err);
  }

  private dropError(rt: PairRuntime, relPath: string): void {
    this.index.clearError(rt.pair.id, relPath);
  }

  /**
   * Per-pair brake between the scanner and the executors. The scanner can
   * enumerate far faster than the uplink can transfer, so without this the
   * ops table grows without bound while the first batch is still uploading.
   */
  private backpressures = new Map<string, Backpressure>();
  private backpressure(rt: PairRuntime): Backpressure {
    let bp = this.backpressures.get(rt.pair.id);
    if (!bp) {
      bp = new Backpressure({ high: OPS_QUEUE_HIGH_WATER, low: OPS_QUEUE_LOW_WATER });
      this.backpressures.set(rt.pair.id, bp);
    }
    return bp;
  }

  /**
   * A read-only window over this pair's base tree, for the planner. Backed
   * straight by the index - no in-memory copy, which is what lets a plan be
   * made without holding the tree in RAM.
   */
  private baseViewFor(rt: PairRuntime): BaseView {
    const pairId = rt.pair.id;
    const idx = this.index;
    return {
      fileByPath: (key) => idx.getFileByPath(pairId, key),
      fileById: (remoteId) => idx.getFileById(pairId, remoteId),
      files: () => idx.iterFiles(pairId),
      folderByPath: (key) => idx.getFolder(pairId, key),
      folders: () => idx.iterFolders(pairId),
    };
  }

  /** Update pair-level markers in both the working copy and the index. */
  private putPairMeta(rt: PairRuntime, meta: Partial<PairMeta>): void {
    if (meta.lastRemotePollAt !== undefined) rt.state.lastRemotePollAt = meta.lastRemotePollAt;
    if (meta.lastFullSyncAt !== undefined) rt.state.lastFullSyncAt = meta.lastFullSyncAt;
    if (meta.rootFolderCreated !== undefined) rt.state.rootFolderCreated = meta.rootFolderCreated;
    this.index.setPairMeta(rt.pair.id, meta);
  }

  /**
   * `env` supplies the three things the transport needs from its host: the
   * session cookie, the system proxy, and the dev flag. It defaults to the
   * Electron-backed implementation, so nothing changes today - but it is what
   * lets the engine eventually run somewhere Electron's APIs do not exist.
   */
  constructor(private apiBase: string, env: EnvProvider = createElectronEnv()) {
    super();
    // Point persistence at the host's data directory before anything opens a
    // file under it.
    if (env.userDataDir) setSyncDataDir(env.userDataDir);
    this.client = new RemoteClient(apiBase, env);
    this.transferSemaphore = new Semaphore(3);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    return this.withLifecycleLock(() => this.startLocked());
  }

  private async startLocked(): Promise<void> {
    if (this.started) return;

    // One-way import of the pre-SQLite JSON state files. Runs once per
    // installation; a pair whose state cannot be read is reported loudly
    // rather than silently starting from an empty base tree (which would
    // re-derive - and in two-way mode, re-delete - everything).
    try {
      const migration = await migrateJsonStateIfNeeded(this.index, syncStateDir());
      if (migration.migrated.length > 0) {
        console.log(`[sync] Imported ${migration.migrated.length} pair state file(s) into the index.`);
      }
      for (const failure of migration.failed) {
        console.error(`[sync] State import FAILED for pair ${failure.pairId}: ${failure.error}. Its backup was kept as .corrupt.bak; this pair will re-scan from an empty base.`);
      }
    } catch (err: any) {
      console.error("[sync] State migration could not run:", err?.message ?? err);
    }

    // Load the config BEFORE the session check: getStatus() merges configured
    // pairs into the UI list, and a no-session boot must still show them
    // (the 2026-08-20 crash left an empty Sync tab that still refused
    // re-adding the folder because only the duplicate check saw the config).
    this.config = await loadConfig();

    // A timed pause ("snooze") persists its deadline. Expired while the app
    // was closed → clear it; still in the future → re-arm the auto-resume a
    // crash would otherwise have lost forever.
    if (this.config.pausedUntil) {
      if (this.config.pausedUntil <= Date.now()) {
        this.config.pausedGlobally = false;
        delete this.config.pausedUntil;
        await saveConfig(this.config);
      } else {
        const remaining = this.config.pausedUntil - Date.now();
        if (this.pauseResumeTimer) clearTimeout(this.pauseResumeTimer);
        this.pauseResumeTimer = setTimeout(() => {
          this.pauseResumeTimer = null;
          this.resumeAll().catch(() => {});
        }, remaining);
      }
    }

    // Don't start sync if user is not logged in.
    // The app should call start() again after login.
    // Cookie cache was cleared on the last stop(), so this read is fresh.
    const hasSession = await this.client.hasSession();
    if (!hasSession) {
      console.log("[sync] No session cookie found - sync engine will not start until login.");
      return;
    }

    this.started = true;
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
      // API call failed - continue with existing config (user might be offline)
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

    // Completed ops are kept briefly so a resume can show what happened, then
    // dropped - without this the table grows forever.
    try {
      this.index.sweepDoneOps(Date.now() - OPS_RETENTION_MS);
    } catch (err: any) {
      console.error("[sync] Ops sweep failed:", err?.message ?? err);
    }

    for (const pair of this.config.pairs) {
      // Anything left "running" belongs to a process that is gone. Return it
      // to the queue so a kill mid-sync resumes rather than rescanning.
      try {
        const requeued = this.index.resetRunningOps(pair.id, Date.now());
        if (requeued > 0) {
          console.log(`[sync] Resuming ${requeued} interrupted operation(s) for pair ${pair.id}.`);
        }
      } catch (err: any) {
        console.error("[sync] Could not requeue interrupted ops:", err?.message ?? err);
      }
      if (pair.enabled && !this.config.pausedGlobally) {
        // Per-pair guard: one pair failing to start must not strand every
        // pair after it in the list with no runtime and no error surfaced.
        try {
          await this.startPair(pair);
        } catch (err: any) {
          console.error(`[sync] startPair failed for ${pair.id} (${pair.localPath}):`, err?.message ?? err);
        }
      }
    }
    this.emitStatus();
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

    // Release every brake first: a scanner waiting on a queue nothing will
    // drain would hold the shutdown open until its timeout.
    for (const bp of this.backpressures.values()) bp.release();
    this.backpressures.clear();

    // Phase 1: Signal all pairs to stop. In-flight workers check rt.status
    // and this.stopped - both must be set before we do anything destructive.
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
    // status and bail out before we clear runtimes.
    await new Promise<void>(r => setTimeout(r, 100));

    // No "persist state before quitting" phase any more: every mutation was
    // already written through to the index as it happened, so there is
    // nothing buffered to lose and nothing to race a shutdown timeout.
    this.runtimes.clear();
    this.activeTransfers.clear();
    this.conflicts = [];
    this.pendingSyncFlagIds = [];
    this.recentDownloads.clear();
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
      // way, say so in the Activity log instead of showing a silent spinner -
      // this is what turns "it just sat at Starting initial sync" from a
      // mystery into a visible, timestamped signal.
      // 90s meant a wedged pair looked frozen for a minute and a half before
      // anything was said. This check runs on the 30s recovery tick, so a 30s
      // threshold surfaces it on the first or second tick instead.
      const STALL_MS = 30_000;
      if (rt.syncing && rt.lastProgressAt && Date.now() - rt.lastProgressAt > STALL_MS) {
        const secs = Math.round((Date.now() - (rt.syncStartedAt || rt.lastProgressAt)) / 1000);
        this.log(pairId, `Still working: ${rt.statusText || "syncing"} - ${secs}s elapsed, no new progress yet`);
        rt.lastProgressAt = Date.now(); // reset so we log at most once per interval
      }

      // Recover from session expiry
      if (rt.status === "error" && rt.errorMessage?.includes("Session expired")) {
        try {
          this.client.clearCookieCache();
          await this.client.getWorkspaceRegion(rt.pair.workspaceId);
          console.log("[sync] Session recovered for pair:", pairId);
          this.resumeAfterRecovery(pairId, rt);
        } catch {
          // Still expired - will retry next interval
        }
      }
      // Recover from a plain network failure. Only SESSION_EXPIRED and
      // RATE_LIMITED were ever retried, so losing wifi mid-sync parked the pair
      // in `error` until the user restarted the app - the single most common
      // failure there is also the one that used to need manual intervention.
      else if (rt.status === "error" && isNetworkErrorMessage(rt.errorMessage)) {
        try {
          await this.client.getWorkspaceRegion(rt.pair.workspaceId);
          this.log(pairId, "Connection restored - resuming sync");
          this.resumeAfterRecovery(pairId, rt);
        } catch {
          // Still offline - try again next interval
        }
      }
      // Note: rate-limited pairs are recovered via their own setTimeout timers,
      // not via this periodic check. This ensures exact Retry-After timing.
    }
  }

  /** Tell the user about files the scanner left out for exceeding the size
   *  ceiling. Named in the Activity log so they know exactly which ones. */
  private reportSkippedTooLarge(rt: PairRuntime, relPaths: string[]): void {
    if (relPaths.length === 0) return;
    const shown = relPaths.slice(0, 5);
    for (const p of shown) this.log(rt.pair.id, `Skipped "${p}" - too large to sync`);
    if (relPaths.length > shown.length) {
      this.log(rt.pair.id, `...and ${relPaths.length - shown.length} more file(s) skipped for size`);
    }
    this.addNotice(rt, "files-skipped",
      `${relPaths.length} file${relPaths.length === 1 ? " is" : "s are"} too large to sync and ${relPaths.length === 1 ? "was" : "were"} skipped. See Activity for the list.`);
  }

  /** Raise (or update) a non-fatal notice on a pair and push it to the UI. */
  private addNotice(rt: PairRuntime, kind: SyncNotice["kind"], message: string): void {
    const existing = rt.notices.get(kind);
    if (existing?.message === message) return; // nothing changed - don't churn the UI
    rt.notices.set(kind, { kind, message });
    this.emitStatus();
  }

  /** Put a pair that recovered from an error back to work. Distinct from the
   *  public resumePair(), which un-pauses a user-paused pair. */
  private resumeAfterRecovery(pairId: string, rt: PairRuntime): void {
    rt.status = "idle";
    rt.errorMessage = null;
    rt.watcher?.start();
    rt.poller?.start();
    this.emitStatus();
    const mode = rt.pair.syncMode || "push-safe";
    if (["two-way", "push", "push-safe"].includes(mode)) {
      this.runInitialScan(pairId);
    }
  }

  /**
   * Run a recovery pass immediately instead of waiting out the 30s timer.
   * Called when the OS tells us connectivity came back or the machine woke -
   * the moments when a parked pair is most likely to succeed.
   */
  notifyNetworkOnline(): void {
    if (this.stopped) return;
    void this.checkRecovery();
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
   * When the user pauses mid-sync, in-flight operations fail - those errors should
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
   *
   * Delegates to paths.ts so the rule is one exported, directly tested function
   * rather than a private method no test can reach.
   */
  private isPathSafe(syncRoot: string, relPath: string): boolean {
    return isPathWithinRoot(syncRoot, relPath);
  }

  // ── Path index helpers (O(1) lookups) ─────────────────────────────

  /**
   * Path lookup now goes to the index: `files_by_path` replaces the old
   * in-memory PathIndex, and `getFileByPath` applies the same NFC +
   * case-folded key. Holding a second copy of every path in RAM was a
   * meaningful share of the memory that killed a 500K-file sync.
   */
  private lookupByPath(rt: PairRuntime, relPath: string): { remoteId: string; record: SyncFileRecord } | undefined {
    const record = this.index.getFileByPath(rt.pair.id, relPath);
    return record ? { remoteId: record.remoteId, record } : undefined;
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
    // funnels through here - so a stopped engine (logged out) never grows
    // sync machinery, no matter which IPC call or timer fires.
    if (!this.started) {
      console.log("[sync] startPair skipped - engine not started:", pair.id);
      return;
    }
    if (this.runtimes.has(pair.id)) return;
    console.log("[sync] startPair:", pair.id, "mode:", pair.syncMode, "path:", pair.localPath);

    // Clean up orphaned .dosya-sync-tmp files from crashed downloads
    try {
      await this.cleanupTempFiles(pair.localPath, pair.excludedPatterns);
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
        rateLimitResumeTimer: null,
      rescanTimer: null,
      notices: new Map(),
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
        // No runtime exists yet at this point in startPair, so this writes
        // through to the index directly rather than via putPairMeta.
        state.rootFolderCreated = true;
        this.index.setPairMeta(pair.id, { rootFolderCreated: true });
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
      const trackedFiles = this.index.countFiles(pair.id);
      const debounceMs = trackedFiles > 5000 ? 2000 : 1000;
      const maxWaitMs = trackedFiles > 5000 ? 8000 : 5000;
      watcher = new LocalWatcher(pair.localPath, debounceMs, maxWaitMs, pair.excludedPatterns);
    }
    if (needsRemotePoll) {
      poller = new RemotePoller(this.client, pair);
    }

    const rt: PairRuntime = {
      pair, state, watcher, poller,
      status: "idle",
      errorMessage: null,
      syncing: false,
      queuedSync: false,
      queuedEvents: new Map(),
      queuedOverflow: false,
      rateLimitResumeTimer: null,
      rescanTimer: null,
      notices: new Map(),
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
          this.log(pair.id, "Folder too large to watch live - relying on periodic reconcile scans");
          this.addNotice(rt, "degraded-watch",
            "This folder has too many subfolders to watch live. Changes are picked up by periodic scans instead, so they may take a few minutes to sync.");
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
        // Tree too large to watch live (EMFILE) - the watcher is the only
        // change trigger in push modes, so fall back to periodic full rescans
        // so nothing is missed.
        watcher.on("degraded", () => {
          this.log(pair.id, "Folder too large to watch live - switching to periodic rescans");
          this.addNotice(rt, "degraded-watch",
            `This folder has too many subfolders to watch live. It is rescanned every ${Math.round(DEGRADED_RESCAN_MS / 60000)} minutes instead, so changes may take that long to sync.`);
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
        }, (skipped) => this.reportSkippedTooLarge(rt, skipped));
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
      this.putPairMeta(rt, { lastFullSyncAt: Date.now(), lastRemotePollAt: Date.now() });
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
        // Presigned endpoint not available - fall back to Worker-proxied downloads
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
          const dlErr = this.index.getError(rt.pair.id, relPath);
          if (dlErr?.permanent) continue;
          if (dlErr && dlErr.retryCount >= MAX_FILE_RETRIES) { this.putError(rt, { ...dlErr, permanent: true }); continue; }

          try {
            await mkdir(longPath(dirname(absPath)), { recursive: true });
            const presigned = presignedMap.get(action.remoteFile.id);
            if (presigned) {
              // Direct download from R2 via presigned URL - no Worker proxy
              await this.client.downloadFromPresignedUrl(
                presigned.url, absPath, action.remoteFile.size_bytes,
              );
              // Update state
              const s = await stat(longPath(absPath));
              this.markRecentDownload(absPath);
              this.putFile(rt, {
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
              });
            } else {
              // Fallback: download through Worker
              await this.downloadRemoteFile(rt, action.remoteFile, absPath, relPath);
            }
            this.dropError(rt, relPath);
          } catch (dlE: any) {
            if (dlE.message === "SESSION_EXPIRED") { dlFatalErr = dlE; return; }
            if (isRateLimitError(dlE)) { dlFatalErr = dlE; return; }
            const prev = this.index.getError(rt.pair.id, relPath);
            this.putError(rt, {
              filePath: relPath, error: dlE.message,
              retryCount: (prev?.retryCount ?? 0) + 1, lastAttemptAt: Date.now(),
              permanent: dlE.message.includes("404") || dlE.message.includes("not found"),
            });
          }
          rt.completedFilesInBatch++;
          rt.completedBytesInBatch += action.remoteFile.size_bytes;
          this.markProgress(rt);
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
          // A single transient upload failure must NOT abort the batch - the
          // deletes queued in otherActions (below) would be dropped, and a
          // dropped remote deletion is permanent data loss. Session/rate-limit
          // errors are fatal for the whole cycle, so re-throw those; everything
          // else is recorded per-file (same shape scanAndUpload uses) and we
          // continue with the next action.
          if (upErr.message === "SESSION_EXPIRED") throw upErr;
          if (isRateLimitError(upErr)) throw upErr;
          console.error(`[sync] upload failed for ${relPath}:`, upErr.message);
          const existing = this.index.getError(rt.pair.id, relPath);
          this.putError(rt, {
            filePath: relPath,
            error: upErr.message,
            retryCount: (existing?.retryCount ?? 0) + 1,
            lastAttemptAt: Date.now(),
            permanent: isPermanentUploadError(upErr.message),
          });
        }
        rt.completedFilesInBatch++;
        rt.completedBytesInBatch += action.type === "upload-new" ? action.stat.sizeBytes : action.stat.sizeBytes;
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
            // newLocalPath is built from the REMOTE name (planner.ts's
            // toRelPath: remoteFile.relPath), so it carries the same traversal
            // risk as a download target and needs the same guard the other
            // sinks already apply. Without it a remote rename to ".." moves a
            // synced file out of the root - and the catch below would DOWNLOAD
            // the remote file to that escaped path.
            if (!this.isPathSafe(rt.pair.localPath, newRelPath)) {
              this.log(rt.pair.id, `Skipped move to unsafe path: ${newRelPath}`);
              break;
            }
            try {
              await mkdir(longPath(dirname(action.newLocalPath)), { recursive: true });
              const { rename: fsRename } = await import("fs/promises");
              await fsRename(longPath(action.oldLocalPath), longPath(action.newLocalPath));
              action.record.localPath = newRelPath;
              action.record.remoteName = action.remoteFile.name;
              action.record.remoteFolderId = action.remoteFile.folder_id;
              this.markRecentDownload(action.newLocalPath);
            } catch {
              await mkdir(longPath(dirname(action.newLocalPath)), { recursive: true });
              await this.downloadRemoteFile(rt, action.remoteFile, action.newLocalPath, newRelPath);
            }
            break;
          }
          case "delete-local": {
            await unlink(longPath(action.localPath)).catch(() => {});
            this.dropFile(rt, action.record.remoteId);
            break;
          }
          case "delete-remote": {
            await this.client.deleteFile(action.remoteId).catch(() => {});
            this.dropFile(rt, action.remoteId);
            console.log(`[sync] Deleted remote: ${action.record.localPath}`);
            break;
          }
          case "conflict": {
            // A conflict is raised by the reconciler, which re-runs every poll
            // cycle and re-reaches the same conclusion until the user resolves
            // it. Re-adding the same file would stack an identical card every
            // 30 seconds. Keep the first one - it holds the earliest
            // detectedAt, and resolution acts on the path, not on the card.
            const already = this.conflicts.some(
              (c) => c.pairId === action.conflict.pairId && c.localPath === action.conflict.localPath,
            );
            if (already) break;
            this.conflicts.push(action.conflict);
            this.emit("conflict-detected", action.conflict);
            console.log(`[sync] Conflict detected: ${action.conflict.remoteName}`);

            // keep-both resolves itself: the local version is renamed to a
            // conflict copy and uploaded alongside, and the server's version
            // comes back down to the original path on the next cycle. Waiting
            // for the user to click would leave the two versions diverging in
            // the meantime, and the whole point of keep-both is that neither
            // is thrown away. What happened is reported as a notice, so the
            // second file in the folder is never a mystery.
            if ((rt.pair.conflictStrategy || "keep-both") === "keep-both") {
              const original = basename(action.conflict.localPath);
              try {
                await this.resolveConflict(action.conflict.id, "keep-both");
                this.addNotice(rt, "conflict-copy",
                  `"${original}" was changed in two places. Both versions were kept - look for a "conflict copy" beside it and delete the one you do not want.`);
                this.log(rt.pair.id, `Kept both versions of "${original}" - it changed here and on the server`);
              } catch (err: any) {
                // resolveConflict re-queues the conflict on failure, so the
                // user can still resolve it by hand.
                console.error(`[sync] Automatic conflict copy failed for ${original}:`, err?.message ?? err);
              }
            }
            break;
          }
        }

        // Save state periodically (not just at end of batch)
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
      // Work left over from a previous run is already decided. Execute it
      // before walking: re-planning half a million files to reach conclusions
      // that are sitting in the queue is exactly the waste this avoids.
      const pending = this.index.countOpsByState(pairId, "pending");
      if (pending > 0) {
        this.log(pairId, `Resuming ${pending.toLocaleString()} operation(s) from the last run`);
        rt.phase = "transferring";
        rt.statusText = `Resuming ${pending.toLocaleString()} operations...`;
        this.emitStatus();
        await this.drainOps(rt, () => true);
      }
      await this.scanAndUpload(rt);

      // If the pair was paused/stopped while we were scanning, don't
      // overwrite its status or start the watcher - just bail out.
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
      for (const [path, err] of [...this.index.iterErrors(rt.pair.id)].map((e) => [e.filePath, e] as const)) {
        if (err.lastAttemptAt < weekAgo) this.dropError(rt, path);
      }
      rt.scannedFolders = 0;
      rt.statusText = "";
      this.putPairMeta(rt, { lastFullSyncAt: Date.now() });
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
    // The base tree is read through the index (baseViewFor), not the in-memory
    // maps - this method no longer needs rt.state at all.
    const { pair } = rt;

    // NOTE: no disk-space check here - this is the UPLOAD path and uploads
    // don't consume local disk. Backing up from a nearly-full disk must work.
    // Disk space is guarded on the download paths via ensureDiskSpace().

    // Pre-populate state from remote if empty (reinstall / fresh pair)
    try {
      await this.prePopulateStateFromRemote(rt);
    } catch {
      // Continue with empty state - files will be uploaded as new (safe, just slower)
    }

    // Phase 1: Walk the tree and collect files + new directories.
    // No API calls during the walk itself - just filesystem reads. Yields to
    // the event loop every YIELD_INTERVAL entries to prevent blocking UI/IPC.
    //
    // Windowed draining: these arrays are flushed (folders created, hashes
    // checked, files uploaded) every SCAN_WINDOW files instead of after the
    // whole walk. Materializing the entire tree first meant 500K-entry arrays
    // held for hours - the 2026-08-20 stress test's OOM. DFS order guarantees
    // a file's ancestor folders were discovered no later than the file
    // itself, so per-window folder creation preserves the parent-before-child
    // invariant the manifest phase depends on.
    const YIELD_INTERVAL = 200;
    const STAT_BATCH_SIZE = 50;
    const SCAN_WINDOW = 5000; // matches MANIFEST_BATCH in uploadSmallFiles
    const MAX_WALK_DEPTH = 50; // matches reconciler.ts MAX_FOLDER_DEPTH
    // The walk only OBSERVES: it collects what is on disk into a window and
    // decides nothing. What to do about each file is the planner's call, made
    // once per window in drainWindow.
    const windowFiles = new Map<string, LocalFile>();
    const windowFolders = new Set<string>();
    const windowAbsPaths = new Map<string, string>();
    let walkCount = 0;
    let deniedDirs = 0;
    let symlinksSkipped = 0;
    let depthSkipped = 0;
    // Running totals for the scan-complete log - the arrays above are cleared
    // every window, so they can't be counted at the end anymore.
    let totalNew = 0;
    let totalModified = 0;
    let totalToVerify = 0;
    let totalNewFolders = 0;

    // ── Scanning phase: walk the tree, report discovered counts to the UI ──
    rt.phase = "scanning";
    // Fresh scan, fresh skip report - the pieces (too-large files, unreadable
    // folders, symlinks) re-add themselves below if they still apply.
    rt.notices.delete("files-skipped");
    rt.scannedFiles = 0;
    rt.scannedFolders = 0;
    rt.statusText = "Scanning local files...";
    this.log(pair.id, "Scanning local folder for changes...");
    this.emitStatus();

    // Excluded entries are LOGGED, not silently dropped - a sync that quietly
    // leaves folders behind reads as data loss. Individually up to the cap
    // (a node_modules-heavy tree can skip thousands), then summarized.
    const MAX_SKIP_LOGS = 30;
    let skipsLogged = 0;
    let skipsTotal = 0;
    const logSkip = (relPath: string, isDir: boolean, reason: string): void => {
      skipsTotal++;
      if (skipsLogged >= MAX_SKIP_LOGS) return;
      skipsLogged++;
      this.log(pair.id, `Skipped ${isDir ? "folder" : "file"} "${relPath}" - ${reason}`);
    };

    // Flush the current window: create the folders discovered so far, hash
    // the maybe-changed files, then upload. Called mid-walk whenever the
    // window fills, and once after the walk for the final partial window.
    const drainWindow = async (): Promise<void> => {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
      if (windowFiles.size === 0 && windowFolders.size === 0) return;

      // Snapshot and clear first, so the walk can keep filling the next window
      // while this one is decided and uploaded.
      const files = new Map(windowFiles);
      const folders = new Set(windowFolders);
      const absPaths = new Map(windowAbsPaths);
      windowFiles.clear();
      windowFolders.clear();
      windowAbsPaths.clear();
      const absOf = (relPath: string): string => absPaths.get(relPath) ?? join(pair.localPath, relPath);

      // Rename candidates: a local file with no base record whose SIZE matches
      // a base row that is no longer at its own path. Only those get hashed -
      // a handful of files, not the tree - and the hash is what lets the
      // planner turn a 2 GB rename into a server-side move instead of a 2 GB
      // upload. Skipped entirely when the pair has no hashed history to match.
      await this.markRenameCandidates(rt, files);

      // State repair, not a decision: a record pre-populated from a remote
      // snapshot (reinstall) carries localMtimeMs === 0 as "match by size".
      // Adopt the real mtime once the size confirms it, or the sentinel sticks
      // forever and a later same-size edit becomes invisible.
      for (const [relPath, file] of files) {
        const record = this.index.getFileByPath(pair.id, relPath);
        if (record && record.localMtimeMs === 0 && record.localSizeBytes === file.sizeBytes) {
          this.putFile(rt, { ...record, localMtimeMs: file.mtimeMs });
        }
      }

      // ONE decision point for the whole engine. localScanIncomplete is true by
      // construction here: a window is a slice of the tree, so "absent locally"
      // cannot be concluded from it - without this the planner would read every
      // file outside the current window as deleted.
      const ops = filterOpsForMode(
        plan({
          local: { files, folders },
          remote: null,
          base: this.baseViewFor(rt),
          conflictStrategy: pair.conflictStrategy || "last-write-wins",
          localScanIncomplete: true,
        }),
        pair.syncMode || "push-safe",
      );

      // The window's decisions are PERSISTED rather than executed inline. A
      // crash now resumes from these rows instead of re-walking the tree to
      // reach the same conclusions - three hours of decided work used to die
      // with the process (2026-08-20 stress test).
      if (ops.length > 0) {
        for (const op of ops) {
          if (op.kind === "create-remote-folder") totalNewFolders++;
          else if (op.kind === "check-content") totalToVerify++;
          else if (op.kind === "upload-new") totalNew++;
          else if (op.kind === "upload-update") totalModified++;
          if (op.kind === "upload-new" || op.kind === "upload-update") {
            rt.totalBytesInBatch += op.sizeBytes;
          }
        }
        // Absolute paths are resolvable from the pair root, so the queued op
        // stays a plain PlanOp and survives a restart with no side table.
        this.index.enqueueOps(pair.id, ops.map((op) => ({ kind: op.kind, payload: op })), Date.now());
        if (!rt.batchStartedAt) rt.batchStartedAt = Date.now();
        this.backpressure(rt).add(ops.length);
      }
      void absOf; // paths are rebuilt from the pair root at execution time

      // Wait here if the executors are behind. This is not a stall: it means
      // uploads are running at full speed, which is the only way to reach the
      // high-water mark.
      const bp = this.backpressure(rt);
      if (bp.paused) {
        this.markProgress(rt, `Scanned ${rt.scannedFiles.toLocaleString()} files - waiting for uploads to catch up`);
        this.emitStatus();
        await bp.waitUntilDrained();
      }
    };

    const walk = async (dir: string, depth: number): Promise<void> => {
      if (this.stopped || rt.status === "paused") return;
      // Bind-mount / hardlinked-directory cycles recurse forever without a
      // cap; the reconciler and chokidar both stop at 50, the push walk
      // didn't.
      if (depth > MAX_WALK_DEPTH) { depthSkipped++; return; }
      let entries;
      // An unreadable directory is COUNTED now, not silently dropped - a sync
      // that quietly leaves whole subtrees behind reads as data loss (the
      // /usr stress test produced a silently truncated backup).
      try { entries = await readdir(longPath(dir), { withFileTypes: true }); } catch { deniedDirs++; return; }

      const fileEntries: { absPath: string; relPath: string }[] = [];

      for (const entry of entries) {
        const absPath = join(dir, entry.name);
        const relPath = toRelPath(pair.localPath, absPath);

        const skipReason = ignoreReason(entry.name, entry.isDirectory(), pair.excludedPatterns, absPath);
        if (skipReason) {
          // Internal temp markers and transient editor artifacts churn
          // constantly and are nobody's decision - only user-visible
          // exclusions (patterns, virtual filesystems) belong in Activity.
          if (skipReason.startsWith("excluded") || skipReason.startsWith("virtual")) {
            logSkip(relPath, entry.isDirectory(), skipReason);
          }
          continue;
        }

        if (entry.isDirectory()) {
          // Observed, not judged: the planner decides which of these the
          // server is missing.
          windowFolders.add(relPath);
          rt.scannedFolders++;
          if (++walkCount % YIELD_INTERVAL === 0) {
            this.markProgress(rt, `Scanned ${rt.scannedFiles.toLocaleString()} local files, ${rt.scannedFolders.toLocaleString()} folders...`);
            this.emitStatus();
            await new Promise<void>(r => setImmediate(r));
          }
          await walk(absPath, depth + 1);
        } else if (entry.isFile()) {
          fileEntries.push({ absPath, relPath });
        } else if (entry.isSymbolicLink()) {
          // Symlinks are never followed - but count them so the scan summary
          // can say so instead of silently omitting them from the backup.
          symlinksSkipped++;
        }
        // Sockets, FIFOs, device nodes, and FUSE/snap entries that misreport
        // their type are silently skipped.
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
          windowFiles.set(relPath, { relPath, sizeBytes: s.size, mtimeMs: s.mtimeMs });
          windowAbsPaths.set(relPath, absPath);
        }
        // Yield between stat batches
        if (++walkCount % YIELD_INTERVAL === 0) {
          await new Promise<void>(r => setImmediate(r));
        }
        // Window full - decide and upload it before scanning further.
        if (windowFiles.size >= SCAN_WINDOW) await drainWindow();
      }
    };

    // The executors run alongside the walk: transfers start on the first
    // window instead of waiting for the whole tree to be enumerated.
    let scanFinished = false;
    const executor = this.drainOps(rt, () => scanFinished);

    try {
      await walk(pair.localPath, 0);
      // Final partial window.
      await drainWindow();
    } finally {
      scanFinished = true;
      // Never leave the executor waiting on a scan that threw.
      this.backpressure(rt).release();
    }
    await executor;

    if (skipsTotal > skipsLogged) {
      this.log(pair.id, `Skipped ${(skipsTotal - skipsLogged).toLocaleString()} more excluded entries this scan (see the pair's excluded patterns)`);
    }
    this.log(pair.id, `Scan complete: ${totalNew.toLocaleString()} new, ${totalModified.toLocaleString()} modified, ${totalToVerify.toLocaleString()} verified, ${totalNewFolders.toLocaleString()} new folders`);
    if (totalNew + totalModified === 0) {
      this.log(pair.id, "Everything up to date - nothing to upload");
    }

    // Surface what the walk could NOT back up. An unreadable directory or a
    // skipped symlink used to vanish without a trace, so the user believed
    // the tree was fully synced (the /usr stress test was silently
    // truncated).
    // With the transfer work finished, spend a little idle time giving older
    // files the content hash they never got. Without this, dedup and rename
    // detection would only ever cover files uploaded after this shipped -
    // unchanged files never re-upload, so nothing else would fill them in.
    this.enqueueHashBackfill(rt);

    if (deniedDirs > 0 || symlinksSkipped > 0 || depthSkipped > 0) {
      const parts: string[] = [];
      if (deniedDirs > 0) parts.push(`${deniedDirs.toLocaleString()} folders couldn't be read (permission denied)`);
      if (symlinksSkipped > 0) parts.push(`${symlinksSkipped.toLocaleString()} symbolic links were skipped`);
      if (depthSkipped > 0) parts.push(`${depthSkipped.toLocaleString()} folders were deeper than ${MAX_WALK_DEPTH} levels`);
      const message = `Not everything was synced: ${parts.join(", ")}.`;
      this.log(pair.id, message);
      // Merge with a too-large-files notice raised mid-scan (same kind key).
      const existing = rt.notices.get("files-skipped");
      this.addNotice(rt, "files-skipped", existing ? `${existing.message} ${message}` : message);
    }
  }

  /**
   * Executes queued ops until the queue is empty and the scan has finished.
   * Runs concurrently with the walk, which is what lets uploads start while
   * the rest of the tree is still being enumerated.
   */
  private async drainOps(rt: PairRuntime, scanDone: () => boolean): Promise<void> {
    const pairId = rt.pair.id;
    while (!this.stopped && (rt.status as SyncPairStatus) !== "paused") {
      const batch = this.index.popPendingOps(pairId, OPS_BATCH, Date.now());
      if (batch.length === 0) {
        if (scanDone()) return;
        await new Promise<void>((r) => setTimeout(r, 50));
        continue;
      }
      try {
        await this.executeQueuedOps(rt, batch);
      } finally {
        // Release the scanner even if the batch threw, or a failed upload
        // would park the walk forever.
        this.backpressure(rt).remove(batch.length);
        this.refreshQueueProgress(rt);
        this.emitStatus();
      }
    }
  }

  /**
   * Run one claimed batch. Folders first (a file's parent must exist before
   * its manifest entry), then content checks, then transfers.
   */
  private async executeQueuedOps(rt: PairRuntime, batch: QueuedOp[]): Promise<void> {
    const pair = rt.pair;
    const entries = batch.map((queued) => ({ queued, op: queued.payload as PlanOp }));
    const absOf = (relPath: string): string => join(pair.localPath, relPath);
    const now = (): number => Date.now();

    const folderEntries = entries.filter((e) => e.op.kind === "create-remote-folder");
    if (folderEntries.length > 0) {
      const relPaths = folderEntries.map((e) => (e.op as Extract<PlanOp, { kind: "create-remote-folder" }>).relPath);
      await this.createNewFolders(rt, relPaths);
      for (const e of folderEntries) this.index.completeOp(e.queued.id, now());
    }

    // check-content: hash, then either drop it (bytes unchanged, adopt the new
    // mtime) or promote it to an upload. Promotion is inserted in the same
    // transaction that completes the check, so a crash between the two cannot
    // lose the follow-up work.
    const checkEntries = entries.filter((e) => e.op.kind === "check-content");
    const promoted: UploadEntry[] = [];
    for (const e of checkEntries) {
      const op = e.op as Extract<PlanOp, { kind: "check-content" }>;
      const record = this.index.getFileById(pair.id, op.baseRemoteId);
      if (!record) { this.index.completeOp(e.queued.id, now()); continue; }
      const toUpload: UploadEntry[] = [];
      await this.hashCandidates(rt, [{ absPath: absOf(op.relPath), relPath: op.relPath, sizeBytes: op.sizeBytes, record }], toUpload);
      if (toUpload.length === 0) {
        const stat = await this.statOrNull(absOf(op.relPath));
        this.index.completeOp(e.queued.id, now(), () => {
          if (stat) this.index.upsertFile(pair.id, { ...record, localMtimeMs: stat.mtimeMs });
        });
      } else {
        promoted.push(...toUpload);
        this.index.completeOp(e.queued.id, now());
      }
    }

    // Backfill: give an older file the content hash it never got, so it can
    // take part in dedup and rename detection. Pure bookkeeping - it reads
    // the file and writes one column, and never touches the network.
    for (const e of entries.filter((x) => (x.op as { kind: string }).kind === "hash-backfill")) {
      const op = e.op as unknown as { remoteId: string; relPath: string };
      const record = this.index.getFileById(pair.id, op.remoteId);
      if (!record) { this.index.completeOp(e.queued.id, now()); continue; }
      const hash = await hashFile(longPath(absOf(op.relPath))).catch(() => undefined);
      this.index.completeOp(e.queued.id, now(), () => {
        // No hash (deleted, unreadable) still completes: retrying forever
        // would burn I/O on a file that cannot be read.
        if (hash) this.index.upsertFile(pair.id, { ...record, contentHash: hash });
      });
    }

    // Moves: the bytes are already on the server, so this is metadata only.
    // A renamed 2 GB file costs two small requests instead of 2 GB.
    for (const e of entries.filter((x) => x.op.kind === "move-remote")) {
      const op = e.op as Extract<PlanOp, { kind: "move-remote" }>;
      const record = this.index.getFileById(pair.id, op.remoteId);
      if (!record) { this.index.completeOp(e.queued.id, now()); continue; }
      try {
        const newName = op.toRelPath.split("/").pop()!;
        const parentRelPath = op.toRelPath.split("/").slice(0, -1).join("/");
        const targetFolderId = parentRelPath
          ? (this.index.getFolder(pair.id, parentRelPath)?.remoteId ?? pair.remoteFolderId)
          : pair.remoteFolderId;
        if (targetFolderId !== record.remoteFolderId) {
          await this.client.moveFile(op.remoteId, targetFolderId);
        }
        if (newName !== record.remoteName) {
          await this.client.renameFile(op.remoteId, newName);
        }
        const stat = await this.statOrNull(absOf(op.toRelPath));
        this.index.completeOp(e.queued.id, now(), () => {
          this.index.upsertFile(pair.id, {
            ...record,
            remoteName: newName,
            remoteFolderId: targetFolderId,
            localPath: op.toRelPath,
            localMtimeMs: stat?.mtimeMs ?? record.localMtimeMs,
            syncedAt: Date.now(),
          });
        });
        this.log(pair.id, `Moved "${op.fromRelPath}" to "${op.toRelPath}" on the server - no re-upload`);
      } catch (err: any) {
        if (err?.message === "SESSION_EXPIRED") throw err;
        // Fall back to a plain upload on the next scan: the base row still
        // points at the old path, so the file reads as new and is sent.
        console.error(`[sync] Server-side move failed for ${op.toRelPath}:`, err?.message ?? err);
        this.index.failOp(e.queued.id, now(), false);
      }
    }

    const uploadEntries = entries.filter((e) => e.op.kind === "upload-new" || e.op.kind === "upload-update");
    const toUpload: UploadEntry[] = [
      ...promoted,
      ...uploadEntries.map((e) => {
        const op = e.op as Extract<PlanOp, { kind: "upload-new" | "upload-update" }>;
        return { absPath: absOf(op.relPath), relPath: op.relPath, isNew: op.kind === "upload-new", sizeBytes: op.sizeBytes };
      }),
    ];

    if (toUpload.length > 0) {
      toUpload.sort((a, b) => a.sizeBytes - b.sizeBytes);
      const smallFiles = toUpload.filter((f) => f.sizeBytes <= RemoteClient.BATCH_FILE_MAX);
      const largeFiles = toUpload.filter((f) => f.sizeBytes > RemoteClient.BATCH_FILE_MAX);
      rt.phase = "transferring";
      rt.statusText = `Uploading ${this.index.countOpsByState(pair.id, "pending").toLocaleString()} files...`;
      this.emitStatus();
      await this.uploadSmallFiles(rt, smallFiles, largeFiles);
      await this.uploadLargeFiles(rt, largeFiles);
    }

    // The uploaders record each file through putFile as it lands, so the ops
    // are completed once their batch has been through the transfer paths. A
    // file that failed carries its own fileErrors row and is retried by the
    // next scan's plan.
    for (const e of uploadEntries) this.index.completeOp(e.queued.id, now());
    for (const e of entries) {
      const kind = (e.op as { kind: string }).kind;
      if (kind !== "create-remote-folder" && kind !== "check-content" && kind !== "upload-new" && kind !== "upload-update" && kind !== "move-remote" && kind !== "hash-backfill") {
        // Kinds the push path does not execute (deletes are filtered out for
        // push-safe, and two-way still runs through executeActions).
        this.index.completeOp(e.queued.id, now());
      }
    }
  }

  /**
   * Progress comes from the ops table rather than in-memory counters, so the
   * numbers survive a restart mid-sync and describe what is actually left
   * rather than what this process happens to remember.
   */
  private refreshQueueProgress(rt: PairRuntime): void {
    const pairId = rt.pair.id;
    const since = rt.batchStartedAt || 0;
    const pending = this.index.countOpsByState(pairId, "pending");
    const running = this.index.countOpsByState(pairId, "running");
    const done = this.index.countOpsByState(pairId, "done", since);
    rt.completedFilesInBatch = done;
    rt.totalFilesInBatch = pending + running + done;
  }

  /**
   * Queue a bounded slice of hash-backfill work, but only when the pair has
   * nothing else to do. It is strictly an optimization for later syncs, so it
   * must never compete with real transfers - and the batch is capped so the
   * queue depth stays predictable. Successive scans work through the rest.
   */
  private enqueueHashBackfill(rt: PairRuntime): void {
    const pairId = rt.pair.id;
    try {
      if (this.index.countOpsByState(pairId, "pending") > 0) return;
      const remaining = this.index.countFilesWithoutHash(pairId);
      if (remaining === 0) return;
      const batch = this.index.findFilesWithoutHash(pairId, HASH_BACKFILL_BATCH);
      this.index.enqueueOps(
        pairId,
        batch.map((r) => ({ kind: "hash-backfill", payload: { kind: "hash-backfill", remoteId: r.remoteId, relPath: r.localPath } })),
        Date.now(),
      );
      this.log(pairId, `Indexing ${batch.length.toLocaleString()} older file(s) for faster future syncs (${remaining.toLocaleString()} left)`);
    } catch (err: any) {
      console.error("[sync] Could not queue hash backfill:", err?.message ?? err);
    }
  }

  /**
   * Attach content hashes to the files in a window that could be renames.
   *
   * A rename looks like "a new local file appeared" plus "a tracked file went
   * missing". Confirming it needs the content hash of the new file - which is
   * I/O, so it cannot happen inside the pure planner. The candidate set is
   * kept tiny: only files with no base record whose exact size matches a
   * hashed base row that is not at its own path any more.
   */
  private async markRenameCandidates(rt: PairRuntime, files: Map<string, LocalFile>): Promise<void> {
    const pairId = rt.pair.id;
    const candidates: LocalFile[] = [];
    for (const [key, file] of files) {
      if (this.index.getFileByPath(pairId, key)) continue; // already tracked here
      const bySize = this.index.findFilesBySize(pairId, file.sizeBytes);
      const missing = bySize.some((r) => r.contentHash && !files.has(r.localPath));
      if (missing) candidates.push(file);
    }
    if (candidates.length === 0) return;

    const HASH_CONCURRENCY = 4;
    let idx = 0;
    const worker = async (): Promise<void> => {
      while (idx < candidates.length) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
        const file = candidates[idx++];
        const hash = await hashFile(longPath(join(rt.pair.localPath, file.relPath))).catch(() => undefined);
        if (hash) file.contentHash = hash;
      }
    };
    await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, candidates.length) }, () => worker()));
  }

  /**
   * Try to upload only the parts of a file the server does not already have.
   *
   * Returns the committed result, or null to mean "use the normal path" -
   * which is the answer for anything at all doubtful. The whole-file upload is
   * the proven path and stays the default; this is an optimization layered on
   * top, and an optimization that fails must cost time, never data.
   */
  private async tryDeltaUpload(
    rt: PairRuntime,
    absPath: string,
    relPath: string,
    sizeBytes: number,
    existingFileId: string | null,
    remoteFolderId: string | null,
    // Same shape uploadFile returns, so the caller treats both identically.
  ): Promise<{ fileId: string; name: string; version?: number; updatedAt?: number } | null> {
    const pair = rt.pair;
    if (!existingFileId) return null; // a new file has nothing to diff against

    const prior = this.index.getBlocks(pair.id, existingFileId);
    let chunks;
    try {
      chunks = await chunkFile(absPath);
    } catch {
      return null;
    }

    const decision = shouldAttemptDelta(sizeBytes, prior.length, chunks.length);
    if (!decision.attempt) return null;

    try {
      const hashes = chunks.map((c) => c.hash);
      const missing = await this.client.chunksMissing(pair.workspaceId, hashes);
      let missingBytes = 0;
      for (const c of chunks) if (missing.has(c.hash)) missingBytes += c.size;

      if (!deltaIsWorthIt(sizeBytes, missingBytes)) return null;

      const toSend = chunks.filter((c) => missing.has(c.hash));
      if (toSend.length > 0) {
        // Deduplicate by hash: a file can repeat a chunk (long runs of zeros),
        // and uploading the same content twice is wasted bandwidth.
        const unique = new Map<string, typeof toSend[number]>();
        for (const c of toSend) if (!unique.has(c.hash)) unique.set(c.hash, c);
        const presigned = await this.client.presignChunks(
          pair.workspaceId, pair.region,
          [...unique.values()].map((c) => ({ hash: c.hash, size: c.size })),
        );
        for (const c of unique.values()) {
          if (this.stopped || (rt.status as SyncPairStatus) === "paused") return null;
          const target = presigned.get(c.hash);
          if (!target) return null; // server declined this chunk - fall back
          await this.client.uploadChunkToPresignedUrl(target.url, absPath, c.offset, c.size);
        }
      }

      const name = relPath.split("/").pop()!;
      const ext = name.includes(".") ? name.split(".").pop()! : null;
      const committed = await this.client.commitChunks({
        workspaceId: pair.workspaceId,
        region: pair.region,
        fileId: existingFileId,
        folderId: remoteFolderId,
        name,
        size: sizeBytes,
        contentType: "application/octet-stream",
        ext,
        chunks: chunks.map((c) => ({ hash: c.hash, size: c.size })),
      });

      // The chunk list we just proved is what the next delta diffs against.
      this.index.setBlocks(pair.id, committed.fileId, chunks.map((c, idx) => ({
        idx, offset: c.offset, size: c.size, hash: c.hash,
      })));

      const savedMb = Math.round((sizeBytes - missingBytes) / 1024 / 1024);
      this.log(pair.id, `Sent only the changed parts of "${relPath}" - ${savedMb} MB reused from the server`);
      // updatedAt is left out on purpose: the commit response does not carry
      // one, and the caller's estimate is better than a guess here.
      return { fileId: committed.fileId, name, version: committed.version };
    } catch (err: any) {
      if (err?.message === "SESSION_EXPIRED") throw err;
      // Any other failure: say so once and let the normal upload handle it.
      console.error(`[sync] Delta upload failed for ${relPath}, sending whole file:`, err?.message ?? err);
      return null;
    }
  }

  /**
   * Chunk a file and store its block list. Content-defined chunking means an
   * insert or delete in the middle only changes the chunks around the edit,
   * so the next upload can skip everything the server already holds.
   *
   * Never throws: a missing chunk list only costs a future optimization.
   * Very large files are chunked with a larger average size so the block
   * count stays sane (a 10 GB file at 1 MB chunks would be 10,000 rows).
   */
  private async recordBlocks(rt: PairRuntime, remoteId: string, absPath: string, sizeBytes: number): Promise<void> {
    if (!blockTrackingApplies(sizeBytes)) return;
    try {
      const chunks = await chunkFile(absPath);
      this.index.setBlocks(rt.pair.id, remoteId, chunks.map((c, idx) => ({
        idx, offset: c.offset, size: c.size, hash: c.hash,
      })));
    } catch {
      // Chunking is best-effort - the file is already synced either way.
    }
  }

  private async statOrNull(absPath: string): Promise<{ mtimeMs: number } | null> {
    return stat(longPath(absPath)).catch(() => null);
  }

  /** Hash files whose mtime changed but size didn't; queue actual changes. */
  private async hashCandidates(rt: PairRuntime, needsHash: NeedsHashEntry[], toUpload: UploadEntry[]): Promise<void> {
    if (needsHash.length === 0) return;
    const { pair } = rt;
    this.log(pair.id, `Verifying ${needsHash.length.toLocaleString()} files (mtime changed, checking content)...`);
    rt.statusText = `Checking ${needsHash.length} changed files...`;
    this.emitStatus();
    const HASH_CONCURRENCY = 10;
    let hashIdx = 0;
    let actuallyChanged = 0;
    const hashWorker = async () => {
      while (hashIdx < needsHash.length) {
        if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;
        const i = hashIdx++;
        const entry = needsHash[i];
        try {
          const hash = await hashFile(longPath(entry.absPath));
          if (hash !== entry.record.contentHash) {
            // Content actually changed - queue for upload
            toUpload.push({ absPath: entry.absPath, relPath: entry.relPath, isNew: false, sizeBytes: entry.sizeBytes });
            actuallyChanged++;
          } else {
            // Content identical - just update mtime in state so we don't re-hash next time
            const s = await stat(longPath(entry.absPath)).catch(() => null);
            if (s) entry.record.localMtimeMs = s.mtimeMs;
          }
        } catch {
          // Can't hash (permission error, etc.) - treat as changed to be safe
          toUpload.push({ absPath: entry.absPath, relPath: entry.relPath, isNew: false, sizeBytes: entry.sizeBytes });
          actuallyChanged++;
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(HASH_CONCURRENCY, needsHash.length) }, () => hashWorker()));
    this.log(pair.id, `Verification done: ${actuallyChanged} actually changed, ${needsHash.length - actuallyChanged} unchanged (content identical)`);
  }

  /**
   * Create newly discovered folders on the server via the batch API, one
   * depth level at a time. The server assigns IDs only when a batch returns,
   * so a folder can never share a request with its own parent - the parent's
   * ID wouldn't exist yet to send. Grouping by depth guarantees every parent
   * was created (and its ID recorded in state.folders) by an earlier level's
   * request. Chunking the whole depth-sorted list instead flattens the tree:
   * any folder whose parent sat in the same chunk of 500 silently fell back
   * to the pair root.
   */
  private async createNewFolders(rt: PairRuntime, newFolders: string[]): Promise<void> {
    if (newFolders.length === 0) return;
    const { pair, state } = rt;
    newFolders.sort((a, b) => a.split("/").length - b.split("/").length);
    const FOLDER_BATCH_SIZE = 500;

    rt.statusText = `Creating ${newFolders.length.toLocaleString()} folders on server...`;
    this.log(pair.id, `Creating ${newFolders.length.toLocaleString()} folders on server...`);
    this.emitStatus();

    let foldersCreated = 0;
    // Folders whose parent has no recorded ID even in level order (the server
    // skipped the parent, e.g. over-length name). Created individually below -
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
          if (parentRelPath && !this.index.getFolder(rt.pair.id, parentRelPath)) {
            deferred.push(relPath);
            continue;
          }
          batchEntries.push({
            name: folderName,
            parent_id: parentRelPath ? this.index.getFolder(rt.pair.id, parentRelPath)!.remoteId : pair.remoteFolderId,
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
              this.putFolder(rt, {
                remoteId: folderId,
                remoteName: entry.name,
                remoteParentId: entry.parent_id,
                localPath: relPath,
                syncedAt: Date.now(),
              });
            }
          }
        } catch (err: any) {
          if (err.message === "SESSION_EXPIRED") throw err;
          if (isRateLimitError(err)) throw err;
          // Batch failed - fall back to individual creation for this chunk
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
  }

  /**
   * Presigned URL upload for small files: Client → Worker (get presigned
   * URLs) → Client → R2 directly (bounded) → Client → Worker (commit DB
   * records). Worker never touches file bytes. Files the manifest path can't
   * handle are pushed onto `largeFiles` for the streaming path.
   */
  private async uploadSmallFiles(
    rt: PairRuntime,
    smallFiles: UploadEntry[],
    largeFiles: UploadEntry[],
  ): Promise<void> {
    const { pair, state } = rt;
    const MANIFEST_BATCH = 5000; // files per manifest request (Worker CPU limit)
    const COMMIT_BATCH = 5000; // files per commit request

    // Build + process manifest chunks LAZILY from smallFiles: each request
    // only materializes a ≤MANIFEST_BATCH window.
    let smallIdx = 0;
    let batchNo = 0;
    while (smallIdx < smallFiles.length) {
      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      const mChunk: { relPath: string; name: string; size: number; folder_id: string | null; absPath: string }[] = [];
      while (smallIdx < smallFiles.length && mChunk.length < MANIFEST_BATCH) {
        const f = smallFiles[smallIdx++];
        const err = this.index.getError(rt.pair.id, f.relPath);
        if (err?.permanent) continue;
        if (err && err.retryCount >= MAX_FILE_RETRIES) { this.putError(rt, { ...err, permanent: true }); continue; }
        const parentRelPath = f.relPath.split("/").slice(0, -1).join("/");
        // A parent with no recorded remote id means folder creation failed or
        // was skipped for it. This used to fall back to the PAIR ROOT, which
        // filed the whole tree's same-named files (every locale dir's
        // XLC_LOCALE...) into one folder - the duplicate factory behind the
        // commit FK bomb, and a silently wrong tree even when it worked.
        // Defer the file instead: the error ladder retries it after the next
        // scan's folder phase, and gives up visibly if the parent never comes.
        if (parentRelPath && !this.index.getFolder(rt.pair.id, parentRelPath)) {
          const existing = this.index.getError(rt.pair.id, f.relPath);
          this.putError(rt, {
            filePath: f.relPath,
            error: `Parent folder "${parentRelPath}" was not created on the server`,
            retryCount: (existing?.retryCount ?? 0) + 1,
            lastAttemptAt: Date.now(),
            permanent: false,
          });
          continue;
        }
        const folderId = parentRelPath ? this.index.getFolder(rt.pair.id, parentRelPath)!.remoteId : pair.remoteFolderId;
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
        // Manifest failed - fall back to old batch upload for this chunk
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

      // Upload directly to R2 via presigned URLs - bounded worker pool
      const uploaded: typeof manifest.uploads = [];
      let uploadIdx = 0;
      let uploadFatalErr: Error | null = null;

      // Built once and reused by the upload workers and the commit loop below.
      // Both used to `mChunk.find()` per file, so a 5,000-file batch did ~25M
      // string comparisons twice over.
      const mChunkByPath = new Map(mChunk.map(f => [f.relPath, f]));

      const uploadWorker = async (): Promise<void> => {
        while (uploadIdx < manifest.uploads.length) {
          if (this.stopped || (rt.status as SyncPairStatus) === "paused" || uploadFatalErr) return;

          const i = uploadIdx++;
          const upload = manifest.uploads[i];
          const entry = mChunkByPath.get(upload.relPath);
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
            // Same fatal classes the download loop recognises. Without this the
            // workers drained the queue recording one per-file error after
            // another against a session that was already gone, and the caller
            // was never told to stop and re-auth.
            if (err.message === "SESSION_EXPIRED") { uploadFatalErr = err; return; }
            if (isRateLimitError(err)) { uploadFatalErr = err; return; }
            console.error(`[sync] Presigned upload failed for ${upload.relPath}:`, err.message);
            const existing = this.index.getError(rt.pair.id, upload.relPath);
            this.putError(rt, {
              filePath: upload.relPath,
              error: err.message,
              retryCount: (existing?.retryCount ?? 0) + 1,
              lastAttemptAt: Date.now(),
              permanent: false,
            });
          }
        }
      };

      // Sized per chunk: uploads are globally sorted by size, so each chunk is
      // size-homogeneous and a chunk of tiny files runs a deeper pipeline than
      // one of near-5MB files.
      const chunkMaxBytes = manifest.uploads.reduce((m, u) => Math.max(m, u.size), 0);
      const uploadConcurrency = directConcurrencyFor(this.config?.maxConcurrentTransfers || 3, chunkMaxBytes);
      await Promise.all(Array.from({ length: Math.min(uploadConcurrency, manifest.uploads.length) }, () => uploadWorker()));
      if (uploadFatalErr) throw uploadFatalErr;

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
              // A refused file did NOT land (oversized, or the name is already
              // taken in that folder) - marking it synced here is how refusals
              // used to become phantoms that never retried and never surfaced.
              const refusal = commitRes.refused.get(u.fileId);
              if (refusal) {
                this.log(pair.id, `Server refused "${u.relPath}" - ${refusal}`);
                const existing = this.index.getError(rt.pair.id, u.relPath);
                this.putError(rt, {
                  filePath: u.relPath,
                  error: refusal,
                  retryCount: (existing?.retryCount ?? 0) + 1,
                  lastAttemptAt: Date.now(),
                  permanent: false,
                });
                continue;
              }
              const entry = mChunkByPath.get(u.relPath);
              const s = entry ? await stat(entry.absPath).catch(() => null) : null;
              const srv = commitRes.results.get(u.fileId);
              this.putFile(rt, {
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
              });
              this.dropError(rt, u.relPath);
            }
          } catch (err: any) {
            if (err.message === "SESSION_EXPIRED") throw err;
            console.error("[sync] Commit failed:", err.message);
          }
        }
      }

    }
  }

  /** Upload large files individually with streaming through the Worker. */
  private async uploadLargeFiles(
    rt: PairRuntime,
    largeFiles: UploadEntry[],
  ): Promise<void> {
    if (largeFiles.length === 0) return;
    const { state } = rt;
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

        const fileError = this.index.getError(rt.pair.id, file.relPath);
        if (fileError && fileError.permanent) continue;
        if (fileError && fileError.retryCount >= MAX_FILE_RETRIES) {
          this.putError(rt, { ...fileError, permanent: true });
          continue;
        }

        try {
          await this.uploadLocalFile(rt, file.absPath, file.relPath);
          this.dropError(rt, file.relPath);
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
          const existing = this.index.getError(rt.pair.id, file.relPath);
          this.putError(rt, {
            filePath: file.relPath,
            error: err.message,
            retryCount: (existing?.retryCount ?? 0) + 1,
            lastAttemptAt: Date.now(),
            permanent: err.message.includes("permission") || err.message.includes("EPERM") || err.message.includes("quota"),
          });
        }

        // Save state periodically
      }
    };

    // Large files are bandwidth-bound: extra parallel streams don't add
    // throughput on a saturated uplink, they only add bufferbloat (the
    // 2026-08-20 stress test took a whole wifi network down with the old
    // auto-scale to 8). The user's setting is the worker count, full stop.
    const baseConcurrency = this.config?.maxConcurrentTransfers || 3;
    await Promise.all(Array.from({ length: Math.min(baseConcurrency, largeFiles.length) }, () => worker()));

    // Propagate fatal errors after all workers finish
    if (sessionExpiredErr) throw sessionExpiredErr;
    if (rateLimitErr) {
      throw rateLimitErr;
    }
  }

  // ── Handle live local changes (push / push-safe modes) ────────────

  private async handleLocalChanges(pairId: string, events: WatchEvent[]): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt || rt.status === "paused" || rt.status === "rate-limited") return;

    if (rt.syncing) {
      // Buffer events (deduped by path) to process AFTER the current sync so
      // deletes and moves aren't lost - a plain rescan only re-finds additions.
      const QUEUE_CAP = 200_000;
      for (const ev of events) rt.queuedEvents.set(ev.path, ev);
      if (rt.queuedEvents.size > QUEUE_CAP) {
        // Too many buffered changes - drop detail, fall back to full rescan
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


    try {
      // ── Move/rename detection (safe) ──
      // A local rename shows up as unlink(A) + add(B). Relocating the cloud
      // object beats re-uploading B and deleting A. But pairing purely by byte
      // size is dangerous: two unrelated files of equal size (extremely common
      // for 0-byte or round-sized files) get mis-paired - moving the WRONG
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
          // Prove identity by streaming content hash (low RAM) - safe at any
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
          ? (this.index.getFolder(rt.pair.id, newParentRelPath)?.remoteId ?? rt.pair.remoteFolderId)
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
          this.log(rt.pair.id, `Moved: ${oldRel} → ${newRel}`);
        } catch (e: any) {
          if (e.message === "SESSION_EXPIRED") throw e;
          if (isRateLimitError(e)) throw e;
          // Move failed - fall through to delete+re-upload in the normal event loop
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

        // Use shared ignore filter. Chokidar's own ignored-set already drops
        // most excluded paths before an event exists, so a hit here is rare
        // and worth an Activity line - same visibility rule as the scanner.
        const isDirEvent = event.type === "addDir" || event.type === "unlinkDir";
        const eventSkipReason = ignoreReason(fileName, isDirEvent, rt.pair.excludedPatterns, event.path);
        if (eventSkipReason) {
          if (eventSkipReason.startsWith("excluded") || eventSkipReason.startsWith("virtual")) {
            this.log(rt.pair.id, `Skipped ${isDirEvent ? "folder" : "file"} "${relPath}" - ${eventSkipReason}`);
          }
          continue;
        }

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
              continue; // File unchanged - event was triggered by our own write or metadata touch
            }
          }

          // Skip files that are still being written (a later change event will
          // re-trigger once they settle) - avoids backing up partial content.
          if (!(await this.isFileStable(event.path))) continue;

          try {
            await this.uploadLocalFile(rt, event.path, relPath);
          } catch (upErr: any) {
            // Don't let one file's transient upload failure abandon the rest of
            // the batch - later unlink/delete events in this same event list
            // would be silently dropped. Session/rate-limit errors are fatal
            // for the cycle (re-throw so the outer handler pauses the pair);
            // everything else is recorded per-file and we move on.
            if (upErr.message === "SESSION_EXPIRED") throw upErr;
            if (isRateLimitError(upErr)) throw upErr;
            console.error(`[sync] upload failed for ${relPath}:`, upErr.message);
            const existing = this.index.getError(rt.pair.id, relPath);
            this.putError(rt, {
              filePath: relPath,
              error: upErr.message,
              retryCount: (existing?.retryCount ?? 0) + 1,
              lastAttemptAt: Date.now(),
              permanent: upErr.message.includes("permission") || upErr.message.includes("EPERM") || upErr.message.includes("quota"),
            });
          }
        } else if (event.type === "unlink" && (mode === "two-way" || mode === "push")) {
          // Delete from cloud only in full sync or push mode (not push-safe/backup)
          const found = this.lookupByPath(rt, relPath);
          if (found) {
            try {
              await this.client.deleteFile(found.remoteId);
              this.dropFile(rt, found.remoteId);
              console.log(`[sync] Deleted remote: ${relPath}`);
            } catch (e: any) {
              if (isRateLimitError(e)) throw e;
              console.error(`[sync] Delete remote failed: ${e.message}`);
            }
          }
        } else if (event.type === "unlinkDir" && (mode === "two-way" || mode === "push")) {
          // FIX: Handle folder deletion - delete remote folder contents.
          // Find all tracked files under this folder and delete them remotely.
          const prefix = relPath + "/";
          const toDelete: { remoteId: string; localPath: string }[] = [];
          for (const [remoteId, record] of [...this.index.iterFiles(rt.pair.id)].map((r) => [r.remoteId, r] as const)) {
            if (record.localPath === relPath || record.localPath.startsWith(prefix)) {
              toDelete.push({ remoteId, localPath: record.localPath });
            }
          }
          // Batch delete - 500 files per request instead of 1 per file
          if (toDelete.length > 0) {
            try {
              await this.client.deleteFilesBatch(rt.pair.workspaceId, toDelete.map(d => d.remoteId));
              for (const { remoteId, localPath } of toDelete) {
                this.dropFile(rt, remoteId);
              }
              this.log(rt.pair.id, `Deleted ${toDelete.length} files remotely (folder removed)`);
            } catch (e: any) {
              if (isRateLimitError(e)) throw e;
              if (e.message === "SESSION_EXPIRED") throw e;
              console.error(`[sync] Batch delete failed: ${e.message}`);
            }
          }
          // Clean up folder state
          for (const folderRelPath of [...this.index.iterFolders(rt.pair.id)].map((f) => f.localPath)) {
            if (folderRelPath === relPath || folderRelPath.startsWith(prefix)) {
              this.dropFolder(rt, folderRelPath);
            }
          }
        }
        // push-safe: skip deletes (backup mode - never delete from cloud)

        // Save state periodically
      }

      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      rt.status = "idle";
      this.putPairMeta(rt, { lastFullSyncAt: Date.now() });
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

      // Guard disk space up-front - pull can otherwise fill the volume.
      let neededBytes = 0;
      for (const [remoteId, file] of snapshot.files) {
        const existing = this.index.getFileById(rt.pair.id, remoteId);
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
        const existing = this.index.getFileById(rt.pair.id, remoteId);

        if (!existing) {
          await mkdir(longPath(dirname(absPath)), { recursive: true });
          await this.downloadRemoteFile(rt, file, absPath, relPath);
        } else if (
          file.updated_at !== existing.remoteUpdatedAt ||
          file.size_bytes !== existing.remoteSizeBytes
        ) {
          await this.downloadRemoteFile(rt, file, absPath, relPath);
        }

      }

      // Handle remote deletions (only in pull, not pull-safe).
      // Safety check: if the snapshot has significantly fewer files than stored
      // state, skip deletions to avoid data loss from incomplete snapshots
      // (e.g., API pagination errors or network interruptions).
      if (mode === "pull") {
        const remoteIds = new Set(snapshot.files.keys());
        const storedCount = this.index.countFiles(rt.pair.id);
        const missingCount = [...this.index.iterFiles(rt.pair.id)].map((r) => r.remoteId).filter(id => !remoteIds.has(id)).length;

        // If more than 50% of tracked files are missing from the snapshot
        // and there are more than 5 missing, assume the snapshot is incomplete.
        const snapshotLooksIncomplete = storedCount > 10 && missingCount > 5 && missingCount > storedCount * 0.5;

        if (snapshotLooksIncomplete) {
          console.warn(
            `[sync] Skipping pull deletions: ${missingCount}/${storedCount} files missing from snapshot. ` +
            `This likely indicates an incomplete remote snapshot.`,
          );
        } else {
          for (const [id, record] of [...this.index.iterFiles(rt.pair.id)].map((r) => [r.remoteId, r] as const)) {
            if (!remoteIds.has(id)) {
              const absPath = join(rt.pair.localPath, record.localPath);
              try {
                await unlink(longPath(absPath));
                this.dropFile(rt, id);
                console.log(`[sync] Deleted local: ${record.localPath}`);
              } catch {
                this.dropFile(rt, id);
              }
            }
          }
        }
      }

      if (this.stopped || (rt.status as SyncPairStatus) === "paused") return;

      rt.status = "idle";
      this.putPairMeta(rt, { lastFullSyncAt: Date.now(), lastRemotePollAt: Date.now() });
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
   * this guards the download/pull paths - uploads never call it (a backup
   * FROM a nearly-full disk must still be able to upload).
   */
  private async ensureDiskSpace(localPath: string, neededBytes: number): Promise<void> {
    let freeBytes: number | null = null;
    try {
      const s = await statfs(localPath);
      freeBytes = s.bavail * s.bsize;
    } catch {
      freeBytes = null; // statfs unavailable (some network drives) - allow
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

      this.putFile(rt, {
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
      });

      this.dropError(rt, relPath);
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
    // ALWAYS released. Previously `stat()` (below) ran before the try - when it
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
        ? (this.index.getFolder(rt.pair.id, parentRelPath)?.remoteId ?? rt.pair.remoteFolderId)
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

      // Send only the changed parts when that is possible and cheaper. Returns
      // null for anything doubtful, and the proven whole-file path runs
      // instead - an optimization may cost time, never data.
      const delta = await this.tryDeltaUpload(rt, absPath, relPath, s.size, existingFileId, remoteFolderId);

      let lastUploadEmit = 0;
      const result = delta ?? await this.client.uploadFile(
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
        this.dropFile(rt, existingFileId);
      }

      // Hash EVERY file, regardless of size. This used to stop at 50 MB to
      // avoid re-reading a large file after uploading it - but that excluded
      // exactly the files where a hash pays for itself most: a hash is what
      // lets a 2 GB rename cost nothing and a 1 MB edit to a 2 GB file send
      // roughly 1 MB. hashFile streams, so the cost is one sequential read,
      // and a file that cannot be hashed still syncs, just without dedup.
      const fileHash = await hashFile(longPath(absPath)).catch(() => undefined);

      this.putFile(rt, {
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
      });

      // Record the chunk list so the NEXT edit to this file can send only the
      // parts that changed. Deliberately after the upload has landed and
      // deliberately swallowed: chunking is an optimization for later, and a
      // failure here must never fail a transfer that already succeeded.
      void this.recordBlocks(rt, result.fileId, absPath, postStat.size);

      // Collect file ID for batched sync-flag call (done at end of scan, not per-file).
      // For individual watcher events, set the flag inline.
      if (rt.totalFilesInBatch > 0) {
        this.pendingSyncFlagIds.push(result.fileId);
      } else if (!this.stopped) {
        this.client.setFileSyncFlag(result.fileId, true).catch(() => {});
      }

      this.dropError(rt, relPath);
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
    if (this.index.getFolder(rt.pair.id, relPath)) {
      return this.index.getFolder(rt.pair.id, relPath)!.remoteId;
    }

    const parts = relPath.split("/");
    let parentRemoteId = rt.pair.remoteFolderId;

    for (let i = 0; i < parts.length; i++) {
      const partialPath = parts.slice(0, i + 1).join("/");

      const known = this.index.getFolder(rt.pair.id, partialPath);
      if (known) {
        parentRemoteId = known.remoteId;
        continue;
      }

      const folderId = await this.client.createFolder(
        rt.pair.workspaceId,
        parts[i],
        parentRemoteId,
      );

      this.putFolder(rt, {
        remoteId: folderId,
        remoteName: parts[i],
        remoteParentId: parentRemoteId,
        localPath: partialPath,
        syncedAt: Date.now(),
      });

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
    // Reload fresh inside the lock - like addPair/updatePair/removePair - so a
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
        notices: [...rt.notices.values()],
      });
    }
    return {
      // Merge in configured pairs that have no runtime (engine not started,
      // pausedGlobally, or a startPair failure) so the UI can never disagree
      // with the duplicate-folder check, which reads the same config.
      pairs: mergeStatusPairs(pairs, this.config?.pairs ?? [], this.config?.pausedGlobally ?? false),
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
    // Sync only works while logged in - refuse before persisting anything.
    // (If a session exists but the engine hasn't started yet - the delayed
    // boot start - the pair is saved and picked up when start() runs.)
    if (!(await this.client.hasSession())) {
      throw new Error("You must be logged in to add a sync folder.");
    }
    this.config = await loadConfig();

    // Refuse system trees as sync roots. The ignore rules deliberately don't
    // match system NAMES anymore (2026-08 rework), so this root-level check is
    // the only thing standing between a user and syncing /usr (the 2026-08-20
    // stress test: ~500K root-owned files, EACCES churn, OOM).
    const forbidden = forbiddenSyncRootReason(resolve(pair.localPath), process.platform, homedir(), tmpdir());
    if (forbidden) throw new Error(forbidden);

    // Prevent overlapping sync pairs - two pairs watching the same or nested
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
        // Name the conflicting LOCAL path - that's what the user has to act on.
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
    if (updates.localPath !== undefined) {
      const forbidden = forbiddenSyncRootReason(resolve(updates.localPath), process.platform, homedir(), tmpdir());
      if (forbidden) throw new Error(forbidden);
    }
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
      // Set paused FIRST - in-flight workers check this and bail out.
      rt.status = "paused";
      // A scanner parked on the queue must not stay parked through a pause.
      this.backpressures.get(pairId)?.release();
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
      // Nothing to flush here any more: uploads recorded themselves in the
      // index as they completed, so a resume already knows what is done.
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
      // No path index to rebuild any more - lookups read the index directly.
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
    delete this.config.pausedUntil; // a manual pause is indefinite
    await saveConfig(this.config);
    for (const [id] of this.runtimes) await this.pausePair(id);
  }

  /** Pause everything, then auto-resume after `ms` (a "snooze"). The deadline
   *  is persisted so a crash or restart mid-snooze can't leave pausedGlobally
   *  wedged on forever - the exact trap that emptied the Sync tab in the
   *  2026-08-20 stress test. */
  async pauseAllFor(ms: number): Promise<void> {
    await this.pauseAll(); // clears any existing timer first
    if (ms > 0) {
      this.config!.pausedUntil = Date.now() + ms;
      await saveConfig(this.config!);
      this.pauseResumeTimer = setTimeout(() => {
        this.pauseResumeTimer = null;
        this.resumeAll().catch(() => {});
      }, ms);
    }
  }

  /**
   * Pause every runtime WITHOUT persisting pausedGlobally. For automatic
   * pauses (system sleep, battery): if the app dies before the matching
   * resume ever runs, the next launch must start clean instead of finding a
   * paused flag nobody set on purpose.
   */
  async pauseAllTransient(): Promise<void> {
    for (const [id] of this.runtimes) await this.pausePair(id);
  }

  /** Resume every runtime without touching the persisted config. */
  async resumeAllTransient(): Promise<void> {
    for (const [id] of this.runtimes) await this.resumePair(id);
  }

  async resumeAll(): Promise<void> {
    if (this.pauseResumeTimer) { clearTimeout(this.pauseResumeTimer); this.pauseResumeTimer = null; }
    this.config = await loadConfig();
    this.config.pausedGlobally = false;
    delete this.config.pausedUntil;
    await saveConfig(this.config);
    // Engine never started (no session at boot, or a wedged pause) - a resume
    // is the user asking for sync to run, so try the full start path.
    if (!this.started) {
      await this.start();
      this.emitStatus();
      return;
    }
    for (const [id] of this.runtimes) await this.resumePair(id);
    // Heal configured pairs that lost their runtime (startPair failure,
    // start skipped by a persisted pause).
    for (const pair of this.config.pairs) {
      if (pair.enabled && !this.runtimes.has(pair.id)) {
        try {
          await this.startPair(pair);
        } catch (err: any) {
          console.error(`[sync] resumeAll startPair failed for ${pair.id}:`, err?.message ?? err);
        }
      }
    }
    this.emitStatus();
  }

  syncNow(pairId: string): void {
    const rt = this.runtimes.get(pairId);
    if (!rt) {
      // A configured pair without a runtime - the placeholder row's
      // "Sync now" is a recovery action, so start the pair.
      const pair = this.config?.pairs.find((p) => p.id === pairId);
      if (pair && this.started) {
        this.startPair(pair).catch((err: any) =>
          console.error(`[sync] syncNow startPair failed for ${pairId}:`, err?.message ?? err));
      }
      return;
    }
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

    // Resolve asynchronously - awaited so IPC handler propagates errors
    try {
      if (resolution === "keep-local") {
        const relPath = toRelPath(rt.pair.localPath, conflict.localPath);
        await this.uploadLocalFile(rt, conflict.localPath, relPath);
      } else if (resolution === "keep-remote") {
        // Delete local state so the next reconcile treats the remote file as new and downloads it.
        const existing = this.index.getFileById(rt.pair.id, conflict.remoteId);
        if (existing) {
          // Delete the local file so the download doesn't think it's unchanged
          await unlink(longPath(conflict.localPath)).catch(() => {});
          this.dropFile(rt, conflict.remoteId);
        }
        // Trigger immediate poll instead of waiting up to 30s
        if (rt.poller) rt.poller.triggerNow();
      } else if (resolution === "keep-both") {
        // The copy's name has to say WHEN this forked and WHERE the other
        // version came from - that is what the user needs to pick a side.
        // Date alone collided on a fast edit-sync-edit cycle; the naming rules
        // (and the numbered tie-break) live in conflict-name.ts.
        const dir = dirname(conflict.localPath);
        const copyName = conflictCopyName({
          fileName: basename(conflict.localPath),
          at: new Date(),
          device: hostname(),
          taken: (candidate) => existsSync(longPath(join(dir, candidate))),
        });
        const conflictPath = join(dir, copyName);

        const { rename: fsRename } = await import("fs/promises");
        await fsRename(longPath(conflict.localPath), longPath(conflictPath));

        const conflictRelPath = toRelPath(rt.pair.localPath, conflictPath);
        await this.uploadLocalFile(rt, conflictPath, conflictRelPath);
      }

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
   * Folder tree for the workspace picker.
   *
   * Exists as an engine method rather than a `getClient()` reach-through
   * because a RemoteClient cannot cross the utilityProcess boundary, and the
   * picker was the only caller that ever wanted the client itself.
   */
  async getFolderTree(workspaceId: string): Promise<import("./types").RemoteFolderInfo[]> {
    return this.client.getFolderTree(workspaceId);
  }

  /**
   * Pre-populate sync state from a remote snapshot when state is empty.
   * Matches remote files to local files by name+size so the reconciler
   * or scanner can skip files that already exist identically on both sides.
   * Used by both push-mode (scanAndUpload) and two-way (runInitialReconcile).
   */
  private async prePopulateStateFromRemote(rt: PairRuntime): Promise<RemoteSnapshot | null> {
    const { pair, state } = rt;
    if (this.index.countFiles(pair.id) > 0 || !pair.remoteFolderId) return null;

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
        this.putFolder(rt, {
          remoteId: id, remoteName: f.name, remoteParentId: f.parent_id,
          localPath: relPath, syncedAt: Date.now(),
        });
      }
    }

    // Pre-populate file state with localMtimeMs=0 sentinel
    for (const [id, f] of snapshot.files) {
      const dir = f.folder_id && f.folder_id !== pair.remoteFolderId
        ? folderPaths.get(f.folder_id) ?? "" : "";
      const relPath = normalizeRel(dir ? `${dir}/${f.name}` : f.name);
      this.putFile(rt, {
        remoteId: id, remoteName: f.name, remoteFolderId: f.folder_id,
        remoteSizeBytes: f.size_bytes, remoteUpdatedAt: f.updated_at,
        remoteVersion: f.current_version, localPath: relPath,
        localSizeBytes: f.size_bytes, localMtimeMs: 0, syncedAt: Date.now(),
      });
    }

    this.log(pair.id, `Found ${snapshot.files.size.toLocaleString()} files and ${snapshot.folders.size.toLocaleString()} folders on server`);
    return snapshot;
  }

  /**
   * Initial reconcile for two-way mode.
   * Fetches remote snapshot, pre-populates state, runs reconciler,
   * and executes download/upload actions - all before the poller starts.
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
        this.log(pairId, "Could not fetch remote state - will retry on next poll");
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
      }, (skipped) => this.reportSkippedTooLarge(rt, skipped));

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
      this.putPairMeta(rt, { lastFullSyncAt: Date.now(), lastRemotePollAt: Date.now() });
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

  /**
   * Clean up orphaned .dosya-sync-tmp files left by crashed downloads.
   * Skips excluded subtrees (the sync never writes temps there, and walking
   * a node_modules-sized tree for nothing slows every pair start).
   */
  private async cleanupTempFiles(dir: string, excludedPatterns?: string[]): Promise<void> {
    let entries;
    try { entries = await readdir(longPath(dir), { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isFile() && (entry.name.endsWith(".dosya-sync-tmp") || entry.name.endsWith(".dosya-sync-tmp.meta"))) {
        await unlink(longPath(fullPath)).catch(() => {});
      } else if (entry.isDirectory() && !shouldIgnoreEntry(entry.name, true, excludedPatterns, fullPath)) {
        await this.cleanupTempFiles(fullPath, excludedPatterns);
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
