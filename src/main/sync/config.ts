import { app } from "electron";
import { join } from "path";
import { open, readFile, mkdir, rename, unlink } from "fs/promises";
import {
  type SyncConfig,
  type SyncPairState,
  DEFAULT_SYNC_CONFIG,
  EMPTY_PAIR_STATE,
} from "./types";
import { stringifyOffThread } from "./state-writer";
import { absKey } from "./paths";

function syncDir(): string {
  return join(app.getPath("userData"), "sync");
}

function configPath(): string {
  return join(syncDir(), "sync-config.json");
}

function statePath(pairId: string): string {
  return join(syncDir(), "sync-state", `${pairId}.json`);
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Atomic write: write to a UNIQUE temp file, fsync, then rename.
 * fsync ensures data is flushed to disk before rename, preventing
 * 0-byte files on crash (ext4 data=ordered without fsync can lose data).
 *
 * The temp name is made unique (pid + counter) so two concurrent writers
 * to the same destination never share a temp file and corrupt each other.
 */
let tmpCounter = 0;
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.${process.pid}.${tmpCounter++}.tmp`;
  const fh = await open(tmpPath, "w");
  try {
    await fh.writeFile(data, "utf-8");
    await fh.sync();
  } finally {
    await fh.close();
  }
  try {
    await rename(tmpPath, filePath);
  } catch (err) {
    // Clean up the orphaned temp file if the rename failed
    await unlink(tmpPath).catch(() => {});
    throw err;
  }
}

// ── Config ──────────────────────────────────────────────────────────

export async function loadConfig(): Promise<SyncConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    // Validate required fields exist
    // Backfill missing fields on pairs saved before new fields were added
    const rawPairs = Array.isArray(parsed.pairs)
      ? parsed.pairs.map((p: any) => ({
          ...p,
          excludedPatterns: Array.isArray(p.excludedPatterns) ? p.excludedPatterns : [],
        }))
      : [];

    // Self-heal: drop exact-duplicate local paths. A check-then-act race in
    // addPair used to let the same folder be added twice, which then synced
    // that folder twice over (two watchers, double uploads). Keep the first.
    const seen = new Set<string>();
    const pairs = [];
    for (const p of rawPairs) {
      const key = absKey(String(p.localPath ?? ""));
      if (!key) continue;
      if (seen.has(key)) {
        console.warn(`[sync] Dropping duplicate sync pair for "${p.localPath}" (same folder listed twice)`);
        continue;
      }
      seen.add(key);
      pairs.push(p);
    }
    return {
      ...DEFAULT_SYNC_CONFIG,
      ...parsed,
      pairs,
    };
  } catch {
    return { ...DEFAULT_SYNC_CONFIG };
  }
}

// Serialize config writes so overlapping callers (addPair, updatePair,
// region refresh, account switch) can't interleave and lose an update.
let configWriteChain: Promise<void> = Promise.resolve();
export function saveConfig(config: SyncConfig): Promise<void> {
  // Snapshot now so a later in-place mutation of `config` doesn't change
  // what this particular write persists.
  const json = JSON.stringify(config, null, 2);
  const run = configWriteChain.then(async () => {
    await ensureDir(syncDir());
    await atomicWriteFile(configPath(), json);
  });
  // Keep the chain alive even if this write rejects.
  configWriteChain = run.catch(() => {});
  return run;
}

// ── Per-Pair State ──────────────────────────────────────────────────

export async function loadPairState(pairId: string): Promise<SyncPairState> {
  try {
    const raw = await readFile(statePath(pairId), "utf-8");
    const parsed = JSON.parse(raw);
    return {
      ...EMPTY_PAIR_STATE(pairId),
      ...parsed,
      files: typeof parsed.files === "object" && parsed.files !== null ? parsed.files : {},
      folders: typeof parsed.folders === "object" && parsed.folders !== null ? parsed.folders : {},
      fileErrors: typeof parsed.fileErrors === "object" && parsed.fileErrors !== null ? parsed.fileErrors : {},
    };
  } catch {
    return EMPTY_PAIR_STATE(pairId);
  }
}

export async function savePairState(state: SyncPairState): Promise<void> {
  const dir = join(syncDir(), "sync-state");
  await ensureDir(dir);
  // Serialize off the main thread - JSON.stringify on 50K entries blocks
  // the event loop for 50-200ms. The worker thread handles it so IPC,
  // watcher events, and UI updates keep flowing.
  const json = await stringifyOffThread(state);
  await atomicWriteFile(statePath(state.pairId), json);
}

export async function deletePairState(pairId: string): Promise<void> {
  try {
    await unlink(statePath(pairId));
  } catch {
    // ignore if doesn't exist
  }
  // Also clean up any leftover tmp file
  try {
    await unlink(`${statePath(pairId)}.tmp`);
  } catch {
    // ignore
  }
}
