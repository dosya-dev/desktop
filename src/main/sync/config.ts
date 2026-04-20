import { app } from "electron";
import { join } from "path";
import { readFile, writeFile, mkdir, rename, unlink } from "fs/promises";
import {
  type SyncConfig,
  type SyncPairState,
  DEFAULT_SYNC_CONFIG,
  EMPTY_PAIR_STATE,
} from "./types";

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
 * Atomic write: write to a temp file, then rename.
 * If the app crashes mid-write, the original file remains intact.
 */
async function atomicWriteFile(filePath: string, data: string): Promise<void> {
  const tmpPath = `${filePath}.tmp`;
  await writeFile(tmpPath, data, "utf-8");
  await rename(tmpPath, filePath);
}

// ── Config ──────────────────────────────────────────────────────────

export async function loadConfig(): Promise<SyncConfig> {
  try {
    const raw = await readFile(configPath(), "utf-8");
    const parsed = JSON.parse(raw);
    // Validate required fields exist
    // Backfill missing fields on pairs saved before new fields were added
    const pairs = Array.isArray(parsed.pairs)
      ? parsed.pairs.map((p: any) => ({
          ...p,
          excludedPatterns: Array.isArray(p.excludedPatterns) ? p.excludedPatterns : [],
        }))
      : [];
    return {
      ...DEFAULT_SYNC_CONFIG,
      ...parsed,
      pairs,
    };
  } catch {
    return { ...DEFAULT_SYNC_CONFIG };
  }
}

export async function saveConfig(config: SyncConfig): Promise<void> {
  await ensureDir(syncDir());
  await atomicWriteFile(configPath(), JSON.stringify(config, null, 2));
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
  await atomicWriteFile(statePath(state.pairId), JSON.stringify(state, null, 2));
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
