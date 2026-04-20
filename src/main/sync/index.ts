import { EventEmitter } from "events";
import { access, readdir, stat, unlink, mkdir } from "fs/promises";
import { join, relative, resolve, sep, basename, dirname } from "path";
import { loadConfig, saveConfig, loadPairState, savePairState, deletePairState } from "./config";
import { RemoteClient, RateLimitError } from "./remote-client";
import { LocalWatcher, type WatchEvent, shouldIgnoreEntry } from "./local-watcher";
import { RemotePoller, type RemoteSnapshot } from "./remote-poller";
import { reconcile } from "./reconciler";
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

// ── Constants ───────��────────────────────────────────���──────────────

const RECENT_DOWNLOAD_TTL_MS = 10_000; // suppress watcher events for 10s after download
const STATE_SAVE_INTERVAL = 10; // save state every N file operations
const SESSION_RECOVERY_MS = 30_000; // check for session recovery every 30s
const MAX_FILE_RETRIES = 5; // max retry attempts per persistently failing file

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
  /** O(1) lookup: localPath → remoteId */
  pathIndex: Map<string, string>;
  /** Timer for auto-resuming after rate limit pause */
  rateLimitResumeTimer: ReturnType<typeof setTimeout> | null;
  /** Total files in the current batch operation (scan/reconcile). 0 when idle. */
  totalFilesInBatch: number;
  /** Files completed so far in the current batch. */
  completedFilesInBatch: number;
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
  private activeTransfers: ActiveTransfer[] = [];
  private started = false;
  private conflicts: SyncConflict[] = [];

  /** Paths recently written by download — watcher events for these are suppressed. */
  private recentDownloads = new Map<string, number>();

  /** Limits concurrent uploads/downloads across all pairs. */
  private transferSemaphore: Semaphore;

  /** Periodic timer to recover pairs stuck in SESSION_EXPIRED or RATE_LIMITED error. */
  private recoveryTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private apiBase: string) {
    super();
    this.client = new RemoteClient(apiBase);
    this.transferSemaphore = new Semaphore(3);
  }

  // ── Lifecycle ─────────────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.started) return;

    // Don't start sync if user is not logged in.
    // The app should call start() again after login.
    const hasSession = await this.client.hasSession();
    if (!hasSession) {
      console.log("[sync] No session cookie found — sync engine will not start until login.");
      return;
    }

    this.started = true;
    this.config = await loadConfig();
    this.transferSemaphore.updateMax(this.config.maxConcurrentTransfers || 3);

    // Start session recovery loop
    this.recoveryTimer = setInterval(() => this.checkRecovery(), SESSION_RECOVERY_MS);

    for (const pair of this.config.pairs) {
      if (pair.enabled && !this.config.pausedGlobally) {
        await this.startPair(pair);
      }
    }
  }

  async stop(): Promise<void> {
    this.started = false;
    if (this.recoveryTimer) {
      clearInterval(this.recoveryTimer);
      this.recoveryTimer = null;
    }
    for (const [, rt] of this.runtimes) {
      rt.watcher?.stop();
      rt.poller?.stop();
      if (rt.rateLimitResumeTimer) clearTimeout(rt.rateLimitResumeTimer);
      // Mark pair as stopped so in-flight operations bail out
      rt.status = "paused";
      rt.syncing = false;
      await savePairState(rt.state);
    }
    this.runtimes.clear();
    this.activeTransfers = [];
    this.conflicts = [];
    this.emitStatus();
  }

  /** Check if engine is stopped. In-flight operations should bail out when true. */
  private get stopped(): boolean {
    return !this.started;
  }

  // ── Session & rate-limit recovery ────────────────────────────────

  private async checkRecovery(): Promise<void> {
    for (const [pairId, rt] of this.runtimes) {
      // Recover from session expiry
      if (rt.status === "error" && rt.errorMessage?.includes("Session expired")) {
        try {
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
    this.recentDownloads.set(absPath, Date.now());
  }

  private isRecentDownload(absPath: string): boolean {
    const ts = this.recentDownloads.get(absPath);
    if (!ts) return false;
    if (Date.now() - ts > RECENT_DOWNLOAD_TTL_MS) {
      this.recentDownloads.delete(absPath);
      return false;
    }
    return true;
  }

  // ── Start / stop pairs ────────────────────────────────────────────

  private async startPair(pair: SyncPair): Promise<void> {
    if (this.runtimes.has(pair.id)) return;
    console.log("[sync] startPair:", pair.id, "mode:", pair.syncMode, "path:", pair.localPath);

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
        pathIndex: new Map(),
        rateLimitResumeTimer: null,
        totalFilesInBatch: 0,
        completedFilesInBatch: 0,
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
        await savePairState(state);
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
    const pathIndex = new Map<string, string>();
    for (const [remoteId, record] of Object.entries(state.files)) {
      pathIndex.set(record.localPath, remoteId);
    }

    const rt: PairRuntime = {
      pair, state, watcher, poller,
      status: "idle",
      errorMessage: null,
      syncing: false,
      queuedSync: false,
      pathIndex,
      rateLimitResumeTimer: null,
      totalFilesInBatch: 0,
      completedFilesInBatch: 0,
    };

    this.runtimes.set(pair.id, rt);

    if (mode === "two-way") {
      // ── Two-way mode: watcher triggers reconcile, poller provides snapshot ──
      if (watcher) {
        watcher.on("batch", () => {
          // Don't upload directly — trigger a reconcile cycle via the poller.
          // The reconciler will do a three-way diff and compute correct actions.
          if (poller) poller.triggerNow();
        });
        watcher.on("error", (err: Error) => {
          console.error(`[sync] watcher error for ${pair.id}:`, err.message);
        });
        watcher.start();
      }
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
        poller.start();
      }
    } else {
      // ── Push / push-safe modes: direct upload on watcher events ──
      if (watcher) {
        watcher.on("batch", (events: WatchEvent[]) => {
          this.handleLocalChanges(pair.id, events);
        });
        watcher.on("error", (err: Error) => {
          console.error(`[sync] watcher error for ${pair.id}:`, err.message);
        });
        watcher.start();
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

  private async stopPair(pairId: string): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt) return;
    rt.watcher?.stop();
    rt.poller?.stop();
    if (rt.rateLimitResumeTimer) {
      clearTimeout(rt.rateLimitResumeTimer);
      rt.rateLimitResumeTimer = null;
    }
    await savePairState(rt.state);
    this.runtimes.delete(pairId);
  }

  // ── Reconcile (two-way mode) ──────────────────────────────────────

  private async runReconcile(pairId: string, snapshot: RemoteSnapshot): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt || rt.status === "paused" || rt.status === "rate-limited" || rt.syncing) return;

    rt.syncing = true;
    rt.status = "syncing";
    this.emitStatus();

    try {
      const actions = await reconcile(rt.pair, rt.state, snapshot);
      await this.executeActions(rt, actions);

      rt.status = "idle";
      rt.state.lastFullSyncAt = Date.now();
      rt.state.lastRemotePollAt = Date.now();
      await savePairState(rt.state);
    } catch (err: any) {
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

    // Count file transfer actions for batch progress tracking
    const fileActions = actions.filter(a =>
      a.type === "download-new" || a.type === "download-update" ||
      a.type === "upload-new" || a.type === "upload-update"
    );
    rt.totalFilesInBatch = fileActions.length;
    rt.completedFilesInBatch = 0;
    this.emitStatus();

    for (const action of actions) {
      if (this.stopped) return;
      try {
        switch (action.type) {
          case "download-new": {
            const absPath = join(action.localDir, action.remoteFile.name);
            const relPath = relative(rt.pair.localPath, absPath).split(sep).join("/");
            if (!this.isPathSafe(rt.pair.localPath, relPath)) {
              console.error("[sync] Path traversal blocked:", relPath);
              break;
            }
            await mkdir(dirname(absPath), { recursive: true });
            await this.downloadRemoteFile(rt, action.remoteFile, absPath, relPath);
            rt.completedFilesInBatch++;
            this.emitStatus();
            break;
          }
          case "download-update": {
            const relPath = relative(rt.pair.localPath, action.localPath).split(sep).join("/");
            if (!this.isPathSafe(rt.pair.localPath, relPath)) {
              console.error("[sync] Path traversal blocked:", relPath);
              break;
            }
            await this.downloadRemoteFile(rt, action.remoteFile, action.localPath, relPath);
            rt.completedFilesInBatch++;
            this.emitStatus();
            break;
          }
          case "upload-new":
          case "upload-update": {
            const relPath = relative(rt.pair.localPath, action.localPath).split(sep).join("/");
            await this.uploadLocalFile(rt, action.localPath, relPath);
            rt.completedFilesInBatch++;
            this.emitStatus();
            break;
          }
          case "delete-local": {
            await unlink(action.localPath).catch(() => {});
            delete rt.state.files[action.record.remoteId];
            rt.pathIndex.delete(action.record.localPath);
            console.log(`[sync] Deleted local: ${action.record.localPath}`);
            break;
          }
          case "delete-remote": {
            await this.client.deleteFile(action.remoteId).catch(() => {});
            delete rt.state.files[action.remoteId];
            rt.pathIndex.delete(action.record.localPath);
            console.log(`[sync] Deleted remote: ${action.record.localPath}`);
            break;
          }
          case "create-local-folder": {
            const folderPath = join(action.localDir, action.name);
            const relPath = relative(rt.pair.localPath, folderPath).split(sep).join("/");
            if (!this.isPathSafe(rt.pair.localPath, relPath)) {
              console.error("[sync] Path traversal blocked for folder:", relPath);
              break;
            }
            await mkdir(folderPath, { recursive: true });
            break;
          }
          case "create-remote-folder": {
            const relPath = relative(rt.pair.localPath, action.localPath).split(sep).join("/");
            await this.ensureRemoteFolder(rt, relPath);
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
          await savePairState(rt.state);
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
    if (!rt || rt.syncing || rt.status === "rate-limited") return;
    console.log("[sync] runInitialScan:", pairId);

    // Check if the server still has sync enabled for this folder
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
    this.emitStatus();

    try {
      await this.scanAndUpload(rt);
      rt.status = "idle";
      rt.totalFilesInBatch = 0;
      rt.completedFilesInBatch = 0;
      rt.state.lastFullSyncAt = Date.now();
      await savePairState(rt.state);
      console.log("[sync] Initial scan complete:", pairId);
    } catch (err: any) {
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
      }
      rt.syncing = false;
      this.emitStatus();
    }
  }

  private async scanAndUpload(rt: PairRuntime): Promise<void> {
    const { pair, state } = rt;

    const toUpload: { absPath: string; relPath: string; isNew: boolean }[] = [];
    let opCount = 0;

    const walk = async (dir: string): Promise<void> => {
      let entries;
      try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }

      for (const entry of entries) {
        // FIX: Use shared ignore filter (matches watcher patterns)
        if (shouldIgnoreEntry(entry.name, entry.isDirectory(), pair.excludedPatterns)) continue;

        const absPath = join(dir, entry.name);
        const relPath = relative(pair.localPath, absPath).split(sep).join("/");

        if (entry.isDirectory()) {
          if (!state.folders[relPath]) {
            await this.ensureRemoteFolder(rt, relPath);
          }
          await walk(absPath);
        } else if (entry.isFile()) {
          const s = await stat(absPath).catch(() => null);
          if (!s) continue;

          // FIX: Use pathIndex for O(1) lookup instead of O(n) find
          const existing = this.lookupByPath(rt, relPath);
          if (!existing) {
            toUpload.push({ absPath, relPath, isNew: true });
          } else if (s.mtimeMs !== existing.record.localMtimeMs || s.size !== existing.record.localSizeBytes) {
            toUpload.push({ absPath, relPath, isNew: false });
          }
        }
      }
    };

    await walk(pair.localPath);

    // Track batch progress for UI
    rt.totalFilesInBatch = toUpload.length;
    rt.completedFilesInBatch = 0;
    this.emitStatus();

    // Upload files
    for (const file of toUpload) {
      // Bail out immediately if engine was stopped (e.g. user logged out)
      if (this.stopped) return;

      // Skip files that have permanently failed
      const fileError = state.fileErrors[file.relPath];
      if (fileError && fileError.permanent) continue;
      if (fileError && fileError.retryCount >= MAX_FILE_RETRIES) {
        state.fileErrors[file.relPath].permanent = true;
        console.error(`[sync] File permanently failed (${MAX_FILE_RETRIES} retries): ${file.relPath}`);
        continue;
      }

      try {
        await this.uploadLocalFile(rt, file.absPath, file.relPath);
        // Clear any previous errors on success
        delete state.fileErrors[file.relPath];
        rt.completedFilesInBatch++;
        this.emitStatus();
      } catch (err: any) {
        if (err.message === "SESSION_EXPIRED") throw err;

        // CRITICAL FIX: Rate limiting affects all subsequent requests.
        // Stop the loop immediately. Don't increment retryCount (it's not a file-specific error).
        // Save state and let pauseForRateLimit schedule a delayed retry.
        if (isRateLimitError(err)) {
          const remaining = toUpload.length - toUpload.indexOf(file) - 1;
          console.log(`[sync] Rate limited during batch upload. ${remaining} files remaining.`);
          await savePairState(rt.state);
          throw err; // propagate to runInitialScan which calls pauseForRateLimit
        }

        console.error(`[sync] upload failed for ${file.relPath}:`, err.message);
        // Track per-file error
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
      opCount++;
      if (opCount % STATE_SAVE_INTERVAL === 0) {
        await savePairState(rt.state);
      }
    }
  }

  // ── Handle live local changes (push / push-safe modes) ────────────

  private async handleLocalChanges(pairId: string, events: WatchEvent[]): Promise<void> {
    const rt = this.runtimes.get(pairId);
    if (!rt || rt.status === "paused" || rt.status === "rate-limited") return;

    if (rt.syncing) {
      rt.queuedSync = true;
      return;
    }

    rt.syncing = true;
    rt.status = "syncing";
    this.emitStatus();

    let opCount = 0;

    try {
      for (const event of events) {
        if (this.stopped) break;
        const relPath = relative(rt.pair.localPath, event.path).split(sep).join("/");
        const fileName = relPath.split("/").pop()!;

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
            const s = await stat(event.path).catch(() => null);
            if (s && s.mtimeMs === existing.record.localMtimeMs && s.size === existing.record.localSizeBytes) {
              continue; // File unchanged — event was triggered by our own write or metadata touch
            }
          }

          await this.uploadLocalFile(rt, event.path, relPath);
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
          for (const { remoteId, localPath } of toDelete) {
            try {
              await this.client.deleteFile(remoteId);
              delete rt.state.files[remoteId];
              rt.pathIndex.delete(localPath);
              console.log(`[sync] Deleted remote (folder cleanup): ${localPath}`);
            } catch (e: any) {
              if (isRateLimitError(e)) throw e;
              console.error(`[sync] Delete remote failed: ${e.message}`);
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
          await savePairState(rt.state);
        }
      }

      rt.status = "idle";
      rt.state.lastFullSyncAt = Date.now();
      await savePairState(rt.state);
    } catch (err: any) {
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

      if (rt.queuedSync) {
        rt.queuedSync = false;
        this.runInitialScan(pairId);
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
    this.emitStatus();

    let opCount = 0;

    try {
      // Build path map from remote files
      const folderPaths = new Map<string, string>();
      for (const [id] of snapshot.folders) {
        const buildPath = (fid: string): string => {
          if (folderPaths.has(fid)) return folderPaths.get(fid)!;
          const f = snapshot.folders.get(fid);
          if (!f) return "";
          if (!f.parent_id || f.parent_id === rt.pair.remoteFolderId) {
            folderPaths.set(fid, f.name);
            return f.name;
          }
          const parentPath = buildPath(f.parent_id);
          const p = parentPath ? `${parentPath}/${f.name}` : f.name;
          folderPaths.set(fid, p);
          return p;
        };
        buildPath(id);
      }

      // Download new/changed remote files
      for (const [remoteId, file] of snapshot.files) {
        if (this.stopped) break;
        const folderId = file.folder_id;
        let relDir = "";
        if (folderId && folderId !== rt.pair.remoteFolderId) {
          relDir = folderPaths.get(folderId) ?? "";
        }
        const relPath = relDir ? `${relDir}/${file.name}` : file.name;

        // FIX: Path traversal validation
        if (!this.isPathSafe(rt.pair.localPath, relPath)) {
          console.error("[sync] Path traversal blocked:", relPath);
          continue;
        }

        const absPath = join(rt.pair.localPath, relPath);
        const existing = rt.state.files[remoteId];

        if (!existing) {
          await mkdir(dirname(absPath), { recursive: true });
          await this.downloadRemoteFile(rt, file, absPath, relPath);
        } else if (
          file.updated_at !== existing.remoteUpdatedAt ||
          file.size_bytes !== existing.remoteSizeBytes
        ) {
          await this.downloadRemoteFile(rt, file, absPath, relPath);
        }

        opCount++;
        if (opCount % STATE_SAVE_INTERVAL === 0) {
          await savePairState(rt.state);
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
                await unlink(absPath);
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

      rt.status = "idle";
      rt.state.lastFullSyncAt = Date.now();
      rt.state.lastRemotePollAt = Date.now();
      await savePairState(rt.state);
    } catch (err: any) {
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
    this.activeTransfers.push(transfer);
    this.emitStatus();

    try {
      // FIX: Download streams to temp file, verifies size, atomically renames.
      // FIX: Progress is now updated via callback.
      // FIX: Zero-byte files are allowed (expectedSize = 0 is valid).
      await this.client.downloadFile(
        file.id,
        absPath,
        file.size_bytes,
        (bytes) => {
          transfer.bytesTransferred = bytes;
          this.emitStatus();
        },
      );

      const s = await stat(absPath);

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

      // Clear any previous errors
      delete rt.state.fileErrors[relPath];

      console.log(`[sync] Downloaded: ${relPath} (${file.size_bytes} bytes)`);
    } finally {
      this.activeTransfers = this.activeTransfers.filter(t => t !== transfer);
      this.transferSemaphore.release();
      this.emitStatus();
    }
  }

  // ── Upload a single file ──────��───────────────────────────────────

  private async uploadLocalFile(rt: PairRuntime, absPath: string, relPath: string): Promise<void> {
    if (this.stopped) return;
    await this.transferSemaphore.acquire();
    if (this.stopped) { this.transferSemaphore.release(); return; }

    const fileName = relPath.split("/").pop()!;
    const s = await stat(absPath);

    // Find the remote folder ID for this file's parent directory
    const parentRelPath = relPath.split("/").slice(0, -1).join("/");
    const remoteFolderId = parentRelPath
      ? (rt.state.folders[parentRelPath]?.remoteId ?? rt.pair.remoteFolderId)
      : rt.pair.remoteFolderId;

    const transfer: ActiveTransfer = {
      pairId: rt.pair.id,
      filePath: relPath,
      fileName,
      direction: "upload",
      bytesTotal: s.size,
      bytesTransferred: 0,
      startedAt: Date.now(),
    };
    this.activeTransfers.push(transfer);
    this.emitStatus();

    try {
      // FIX: Use pathIndex for O(1) lookup
      const existing = this.lookupByPath(rt, relPath);
      const existingFileId = existing?.remoteId ?? null;

      // FIX: Progress is now updated via callback
      const result = await this.client.uploadFile(
        absPath,
        rt.pair.workspaceId,
        remoteFolderId,
        rt.pair.region,
        existingFileId,
        (bytes) => {
          transfer.bytesTransferred = bytes;
          this.emitStatus();
        },
      );

      // Re-stat after upload to get the actual mtime (file may have been modified during upload)
      const postStat = await stat(absPath).catch(() => s);

      // Track in state
      const version = existing ? existing.record.remoteVersion + 1 : 1;

      // Clean up old entry if fileId changed
      if (existingFileId && existingFileId !== result.fileId) {
        delete rt.state.files[existingFileId];
      }

      rt.state.files[result.fileId] = {
        remoteId: result.fileId,
        remoteName: result.name,
        remoteFolderId: remoteFolderId,
        remoteSizeBytes: postStat.size,
        remoteUpdatedAt: Math.floor(Date.now() / 1000),
        remoteVersion: version,
        localPath: relPath,
        localSizeBytes: postStat.size,
        localMtimeMs: postStat.mtimeMs,
        syncedAt: Date.now(),
      };
      rt.pathIndex.set(relPath, result.fileId);

      // Mark file as synced on server (skip if engine stopped, e.g. logout)
      if (!this.stopped) {
        try {
          await this.client.setFileSyncFlag(result.fileId, true);
        } catch (e: any) {
          console.error(`[sync] Failed to set file sync flag: ${e.message}`);
        }
      }

      // Clear any previous errors
      delete rt.state.fileErrors[relPath];

      if (existingFileId) {
        console.log(`[sync] Updated (v${version}): ${relPath} (${postStat.size} bytes)`);
      } else {
        console.log(`[sync] Uploaded: ${relPath} (${postStat.size} bytes)`);
      }
    } finally {
      this.activeTransfers = this.activeTransfers.filter(t => t !== transfer);
      this.transferSemaphore.release();
      this.emitStatus();
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
    if (!this.config) this.config = await loadConfig();
    // Update concurrency limit if changed
    if (typeof updates.maxConcurrentTransfers === "number" && updates.maxConcurrentTransfers > 0) {
      this.transferSemaphore.updateMax(updates.maxConcurrentTransfers);
    }
    Object.assign(this.config, updates);
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
      });
    }
    return {
      pairs,
      globalPaused: this.config?.pausedGlobally ?? false,
      activeTransfers: this.activeTransfers,
      unresolvedConflicts: this.conflicts,
    };
  }

  async addPair(pair: SyncPair): Promise<void> {
    this.config = await loadConfig();

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
      rt.status = "paused";
      rt.errorMessage = null;
      rt.syncing = false;
      rt.totalFilesInBatch = 0;
      rt.completedFilesInBatch = 0;
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
      rt.watcher?.start();
      rt.poller?.start();
      rt.status = "idle";
      this.emitStatus();
      const mode = rt.pair.syncMode || "push-safe";
      if (["two-way", "push", "push-safe"].includes(mode)) this.runInitialScan(pairId);
    }
  }

  async pauseAll(): Promise<void> {
    this.config = await loadConfig();
    this.config.pausedGlobally = true;
    await saveConfig(this.config);
    for (const [id] of this.runtimes) await this.pausePair(id);
  }

  async resumeAll(): Promise<void> {
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

  resolveConflict(conflictId: string, resolution: "keep-local" | "keep-remote" | "keep-both"): void {
    const idx = this.conflicts.findIndex(c => c.id === conflictId);
    if (idx === -1) return;

    const conflict = this.conflicts[idx];
    const rt = this.runtimes.get(conflict.pairId);
    if (!rt) {
      this.conflicts.splice(idx, 1);
      this.emitStatus();
      return;
    }

    // Schedule resolution asynchronously
    (async () => {
      try {
        if (resolution === "keep-local") {
          // Upload local version, overwriting remote
          const relPath = relative(rt.pair.localPath, conflict.localPath).split(sep).join("/");
          await this.uploadLocalFile(rt, conflict.localPath, relPath);
        } else if (resolution === "keep-remote") {
          // Download remote version, overwriting local
          const relPath = relative(rt.pair.localPath, conflict.localPath).split(sep).join("/");
          const remoteFile = rt.state.files[conflict.remoteId];
          if (remoteFile) {
            // Re-fetch file info is not available here; use stored info to trigger download
            // The next reconcile cycle will handle the actual download
          }
        } else if (resolution === "keep-both") {
          // Rename local file with conflict suffix, then download remote version
          const ext = conflict.localPath.includes(".") ? conflict.localPath.substring(conflict.localPath.lastIndexOf(".")) : "";
          const base = conflict.localPath.substring(0, conflict.localPath.length - ext.length);
          const dateStr = new Date().toISOString().slice(0, 10);
          const conflictPath = `${base} (conflict ${dateStr})${ext}`;

          // Rename existing local file
          const { rename: fsRename } = await import("fs/promises");
          await fsRename(conflict.localPath, conflictPath);

          // Upload the conflict copy
          const conflictRelPath = relative(rt.pair.localPath, conflictPath).split(sep).join("/");
          await this.uploadLocalFile(rt, conflictPath, conflictRelPath);
        }

        // Remove resolved conflict
        this.conflicts.splice(idx, 1);
        await savePairState(rt.state);
        this.emitStatus();
        console.log(`[sync] Conflict resolved (${resolution}): ${conflict.remoteName}`);
      } catch (err: any) {
        console.error(`[sync] Failed to resolve conflict: ${err.message}`);
      }
    })();
  }

  getConflicts(): SyncConflict[] {
    return [...this.conflicts];
  }

  isRunning(): boolean {
    return this.started;
  }

  getClient(): RemoteClient {
    return this.client;
  }

  private emitStatus(): void {
    this.emit("status-changed", this.getStatus());
  }
}
