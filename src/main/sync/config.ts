import { app } from "electron";
import { join } from "path";
import { mkdirSync } from "fs";
import { open, readFile, mkdir, rename, unlink } from "fs/promises";
import {
  type SyncConfig,
  type SyncPairState,
  DEFAULT_SYNC_CONFIG,
} from "./types";
import { SyncIndex } from "./index-db";
import { absKey } from "./paths";

/**
 * Everything the sync engine persists lives here: the config, the per-pair
 * state, and the installation's device id (device-id.ts). Exported because
 * that module takes the directory as an argument rather than importing
 * `electron` itself, which is what keeps it testable outside an Electron
 * process.
 */
/**
 * Where the engine's data lives. Normally Electron's userData directory, but
 * settable so the engine can run somewhere Electron's `app` does not exist -
 * a utilityProcess, or a test. The Electron fallback stays until the engine
 * actually moves, so no call site has to be initialised in a particular order
 * today; removing it is the last step of that move.
 */
let dataDirOverride: string | null = null;

export function setSyncDataDir(dir: string): void {
  dataDirOverride = dir || null;
}

export function syncDir(): string {
  return join(dataDirOverride ?? app.getPath("userData"), "sync");
}

function configPath(): string {
  return join(syncDir(), "sync-config.json");
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

// ── Per-Pair State (SQLite index) ───────────────────────────────────

/** Directory holding the retired pre-SQLite JSON state files. */
export function syncStateDir(): string {
  return join(syncDir(), "sync-state");
}

let indexSingleton: SyncIndex | null = null;

/**
 * The process-wide sync index. One connection, one writer - which is what
 * SQLite wants and what the engine already is.
 */
export function openSyncIndex(): SyncIndex {
  if (!indexSingleton) {
    // SQLite will not create the directory for us, and this runs before any
    // async path has had a chance to.
    mkdirSync(syncDir(), { recursive: true });
    indexSingleton = SyncIndex.open(join(syncDir(), "index.db"));
  }
  return indexSingleton;
}

/** Close the index (engine teardown / tests). Reopens on next use. */
export function closeSyncIndex(): void {
  indexSingleton?.close();
  indexSingleton = null;
}

/**
 * Hydrate a pair's in-memory working state from the index.
 *
 * Same shape the engine has always consumed - what changed is where it comes
 * from and what it costs: rows stream out of SQLite instead of a whole JSON
 * blob being parsed, and writes no longer rewrite the world (see the
 * write-through helpers in index.ts). Phase 3 removes these maps entirely and
 * reads straight from the index.
 */
export async function loadPairState(pairId: string): Promise<SyncPairState> {
  // Only the pair-level markers are held in memory now. The files, folders
  // and error maps used to be hydrated here - hundreds of thousands of
  // records per pair, held for the life of the process, which is most of what
  // made a large sync fatal. Everything reads through SyncIndex instead, so
  // engine memory is bounded by the work queue rather than by tree size.
  const meta = openSyncIndex().getPairMeta(pairId);
  return {
    pairId,
    lastRemotePollAt: meta.lastRemotePollAt,
    lastFullSyncAt: meta.lastFullSyncAt,
    rootFolderCreated: meta.rootFolderCreated,
    files: {},
    folders: {},
    fileErrors: {},
  };
}

export async function deletePairState(pairId: string): Promise<void> {
  openSyncIndex().deletePair(pairId);
}
