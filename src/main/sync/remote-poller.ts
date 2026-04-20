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

export class RemotePoller extends EventEmitter {
  private timer: ReturnType<typeof setInterval> | null = null;
  private polling = false;
  private consecutiveErrors = 0;
  private lastSnapshotHash = "";
  private backedOff = false;
  /** Counter of API requests made during the current poll cycle, for pacing. */
  private pollRequestCount = 0;

  constructor(
    private client: RemoteClient,
    private pair: SyncPair,
  ) {
    super();
  }

  start(): void {
    if (this.timer) return;
    this.consecutiveErrors = 0;
    this.backedOff = false;
    // Immediate first poll
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pair.pollIntervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.backedOff = false;
  }

  triggerNow(): void {
    this.poll();
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
        this.emit("snapshot", snapshot);
      }

      this.consecutiveErrors = 0;

      // FIX: Restore original poll interval after recovery from backoff.
      // Previously the backed-off timer was never replaced on success,
      // permanently degrading the poll interval.
      if (this.backedOff && this.timer) {
        clearInterval(this.timer);
        this.timer = setInterval(() => this.poll(), this.pair.pollIntervalMs);
        this.backedOff = false;
        console.log(`[sync] Poller restored to ${this.pair.pollIntervalMs / 1000}s interval`);
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
    // Quick hash: concatenate file ids + updated_at timestamps
    const parts: string[] = [];
    for (const [id, f] of snapshot.files) {
      parts.push(`${id}:${f.updated_at}:${f.size_bytes}`);
    }
    for (const [id, f] of snapshot.folders) {
      parts.push(`d:${id}:${f.name}`);
    }
    return parts.sort().join("|");
  }

  private async fetchSnapshot(): Promise<RemoteSnapshot> {
    const files = new Map<string, RemoteFileInfo>();
    const folders = new Map<string, RemoteFolderInfo>();

    await this.fetchFolder(this.pair.remoteFolderId, files, folders, 0);

    return { files, folders };
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
