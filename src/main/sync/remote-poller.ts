import { EventEmitter } from "events";
import type { RemoteClient } from "./remote-client";
import { RateLimitError } from "./remote-client";
import type { RemoteFileInfo, RemoteFolderInfo, SyncPair } from "./types";

export interface RemoteSnapshot {
  files: Map<string, RemoteFileInfo>; // keyed by remoteId
  folders: Map<string, RemoteFolderInfo>; // keyed by remoteId
}

const MAX_FOLDER_DEPTH = 50;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes
/** Pause briefly every N API requests to avoid exhausting rate budget in a single poll cycle. */
const PACE_REQUEST_INTERVAL = 40;
const PACE_DELAY_MS = 3000;

/** Adaptive poll intervals — slow down when idle, speed up when active. */
const IDLE_THRESHOLDS = [
  { afterMs: 60 * 60 * 1000, intervalMs: 300_000 },  // idle >1h → poll every 5 min
  { afterMs: 5 * 60 * 1000,  intervalMs: 120_000 },  // idle >5 min → poll every 2 min
] as const;

export class RemotePoller extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private consecutiveErrors = 0;
  private lastSnapshotHash = "";
  private backedOff = false;
  private pollRequestCount = 0;
  private lastPollTimestamp = 0;
  private cachedSnapshot: RemoteSnapshot | null = null;
  /** When the last actual change was detected (for adaptive interval). */
  private lastChangeAt = Date.now();
  /** Current effective poll interval (may differ from pair.pollIntervalMs when idle). */
  private currentIntervalMs: number;
  /** Whether the app window is visible (affects poll speed). */
  private appVisible = true;

  constructor(
    private client: RemoteClient,
    private pair: SyncPair,
  ) {
    super();
    this.currentIntervalMs = pair.pollIntervalMs;
  }

  start(): void {
    if (this.timer) return;
    this.consecutiveErrors = 0;
    this.backedOff = false;
    this.lastChangeAt = Date.now();
    this.currentIntervalMs = this.pair.pollIntervalMs;
    this.poll();
    this.timer = setInterval(() => this.poll(), this.currentIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.backedOff = false;
  }

  triggerNow(): void {
    // User/watcher triggered — reset to active interval
    this.lastChangeAt = Date.now();
    if (this.currentIntervalMs !== this.pair.pollIntervalMs && !this.backedOff) {
      this.setInterval(this.pair.pollIntervalMs);
    }
    this.poll();
  }

  /** Notify poller that the app window visibility changed. */
  setAppVisible(visible: boolean): void {
    this.appVisible = visible;
    if (visible) {
      // App became visible — speed up polling
      this.lastChangeAt = Date.now();
      if (this.currentIntervalMs !== this.pair.pollIntervalMs && !this.backedOff) {
        this.setInterval(this.pair.pollIntervalMs);
      }
      this.poll(); // immediate check
    }
  }

  private setInterval(ms: number): void {
    this.currentIntervalMs = ms;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.poll(), ms);
    }
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    this.pollRequestCount = 0;

    try {
      const snapshot = await this.fetchSnapshot();

      // Only emit if snapshot actually changed
      const hash = this.hashSnapshot(snapshot);
      if (hash !== this.lastSnapshotHash) {
        this.lastSnapshotHash = hash;
        this.lastChangeAt = Date.now(); // reset idle timer
        this.emit("snapshot", snapshot);
      }

      this.consecutiveErrors = 0;

      // Restore from error backoff
      if (this.backedOff && this.timer) {
        this.backedOff = false;
        this.setInterval(this.pair.pollIntervalMs);
      }

      // ── Adaptive interval: slow down when idle ──
      // If no changes detected for a while and app is in tray, increase interval.
      if (!this.backedOff) {
        const idleMs = Date.now() - this.lastChangeAt;
        let targetInterval = this.pair.pollIntervalMs;

        // If app is hidden (tray), use longer idle intervals
        if (!this.appVisible) {
          targetInterval = Math.max(targetInterval, 120_000); // min 2 min when hidden
        }

        // Apply idle thresholds
        for (const t of IDLE_THRESHOLDS) {
          if (idleMs > t.afterMs) {
            targetInterval = Math.max(targetInterval, t.intervalMs);
            break; // thresholds sorted longest-first
          }
        }

        if (targetInterval !== this.currentIntervalMs) {
          this.setInterval(targetInterval);
        }
      }
    } catch (err: any) {
      this.consecutiveErrors++;

      // Rate limit errors: use the Retry-After value as backoff instead of generic exponential.
      // Also propagate the error so the sync engine can pause the pair.
      if (err instanceof RateLimitError) {
        this.emit("error", err);
        if (this.timer) {
          clearInterval(this.timer);
          const backoffMs = Math.max(err.retryAfterMs, this.pair.pollIntervalMs);
          console.log(`[sync] Poller rate-limited. Backing off to ${Math.round(backoffMs / 1000)}s (Retry-After)`);
          this.timer = setInterval(() => this.poll(), backoffMs);
          this.backedOff = true;
        }
      } else {
        this.emit("error", err);

        // Generic exponential backoff with jitter after repeated failures
        if (this.consecutiveErrors >= 3 && this.timer) {
          clearInterval(this.timer);
          const baseMs = this.pair.pollIntervalMs * Math.pow(2, this.consecutiveErrors - 2);
          // Add jitter (0.5x – 1.5x) to prevent thundering herd
          const jitteredMs = baseMs * (0.5 + Math.random());
          const backoffMs = Math.min(jitteredMs, MAX_BACKOFF_MS);
          console.log(`[sync] Poller backing off to ${Math.round(backoffMs / 1000)}s after ${this.consecutiveErrors} errors`);
          this.timer = setInterval(() => this.poll(), backoffMs);
          this.backedOff = true;
        }
      }
    } finally {
      this.polling = false;
    }
  }

  private hashSnapshot(snapshot: RemoteSnapshot): string {
    // FNV-1a-inspired numeric hash — O(n) with no string allocation or sorting.
    // Previous approach concatenated all IDs into a multi-MB string and sorted it.
    let h = 2166136261;
    for (const [id, f] of snapshot.files) {
      for (let i = 0; i < id.length; i++) h = (h ^ id.charCodeAt(i)) * 16777619;
      h = (h ^ f.updated_at) * 16777619;
      h = (h ^ f.size_bytes) * 16777619;
    }
    for (const [id, f] of snapshot.folders) {
      for (let i = 0; i < id.length; i++) h = (h ^ id.charCodeAt(i)) * 16777619;
      for (let i = 0; i < f.name.length; i++) h = (h ^ f.name.charCodeAt(i)) * 16777619;
      // Include parent_id so folder moves are detected
      if (f.parent_id) {
        for (let i = 0; i < f.parent_id.length; i++) h = (h ^ f.parent_id.charCodeAt(i)) * 16777619;
      }
    }
    // Include counts to catch additions/deletions
    h = (h ^ snapshot.files.size) * 16777619;
    h = (h ^ snapshot.folders.size) * 16777619;
    return String(h >>> 0);
  }

  async fetchSnapshot(): Promise<RemoteSnapshot> {
    // First poll: full snapshot. Subsequent polls: delta (only changes since last poll).
    // Delta polls are typically 1 HTTP request with 0-100 changed files,
    // vs full snapshot which could be thousands of files across many pages.
    const useDelta = this.cachedSnapshot && this.lastPollTimestamp > 0;
    const since = useDelta ? this.lastPollTimestamp : undefined;
    const beforePoll = Math.floor(Date.now() / 1000);

    const fast = await this.client.fetchSnapshotFast(
      this.pair.workspaceId,
      this.pair.remoteFolderId,
      since,
    );

    if (fast) {
      if (useDelta && this.cachedSnapshot) {
        // Merge delta into cached snapshot
        for (const f of fast.files) {
          this.cachedSnapshot.files.set(f.id, f);
        }
        // Folders only come in full snapshots (first page, no cursor)
        if (fast.folders.length > 0) {
          this.cachedSnapshot.folders.clear();
          for (const d of fast.folders) {
            this.cachedSnapshot.folders.set(d.id, d);
          }
        }
        this.lastPollTimestamp = beforePoll;
        return this.cachedSnapshot;
      }

      // Full snapshot — build and cache
      const files = new Map<string, RemoteFileInfo>();
      const folders = new Map<string, RemoteFolderInfo>();
      for (const f of fast.files) files.set(f.id, f);
      for (const d of fast.folders) folders.set(d.id, d);
      this.cachedSnapshot = { files, folders };
      this.lastPollTimestamp = beforePoll;
      return this.cachedSnapshot;
    }

    // Fast endpoint not available — throw so the caller knows.
    // Do NOT fall back to recursive per-folder fetching (30K requests for 30K folders).
    // The /api/sync/snapshot endpoint must be deployed for sync to work efficiently.
    throw new Error("Snapshot endpoint unavailable — deploy /api/sync/snapshot");
  }

  /**
   * Paced API call: pauses briefly every PACE_REQUEST_INTERVAL requests
   * to avoid exhausting the rate limit budget in a single poll cycle.
   */
  private async pacedListFiles(
    workspaceId: string,
    folderId: string | null,
    page: number,
    perPage: number,
  ) {
    this.pollRequestCount++;
    if (this.pollRequestCount > 1 && this.pollRequestCount % PACE_REQUEST_INTERVAL === 0) {
      // Check client's rate budget — if low, pause longer
      const budget = this.client.rateBudget;
      if (budget.remaining < 50 && budget.remaining < Infinity) {
        const waitMs = Math.max(0, budget.resetAt * 1000 - Date.now());
        if (waitMs > 0 && waitMs < 120_000) {
          console.log(`[sync] Poller pacing: budget low (${budget.remaining}), waiting ${Math.round(waitMs / 1000)}s`);
          await new Promise(r => setTimeout(r, waitMs + 500));
        }
      } else {
        await new Promise(r => setTimeout(r, PACE_DELAY_MS));
      }
    }
    return this.client.listFiles(workspaceId, folderId, page, perPage);
  }

  private async fetchFolder(
    folderId: string | null,
    files: Map<string, RemoteFileInfo>,
    folders: Map<string, RemoteFolderInfo>,
    depth: number,
  ): Promise<void> {
    // Depth limit to prevent infinite recursion from circular folder trees
    if (depth > MAX_FOLDER_DEPTH) {
      console.warn("[sync] Skipping folder at depth", depth, "— exceeded max depth");
      return;
    }

    // Check selective sync: if this folder is excluded, skip it
    if (folderId && this.pair.selectiveFolders.length > 0) {
      const entry = this.pair.selectiveFolders.find(
        (sf) => sf.folderId === folderId,
      );
      if (entry && !entry.included) return;
    }

    let page = 1;
    let totalPages = 1;

    while (page <= totalPages) {
      const result = await this.pacedListFiles(
        this.pair.workspaceId,
        folderId,
        page,
        500,
      );
      totalPages = result.totalPages;

      for (const f of result.files) {
        files.set(f.id, f);
      }

      for (const dir of result.folders) {
        // Guard against cycles: skip if we've already seen this folder
        if (folders.has(dir.id)) continue;
        folders.set(dir.id, dir);
        await this.fetchFolder(dir.id, files, folders, depth + 1);
      }

      page++;
    }
  }
}
