import { readdir, readFile, rename, stat, unlink } from "fs/promises";
import { join } from "path";
import type { SyncIndex } from "./index-db";
import type { SyncFileError, SyncFileRecord, SyncFolderRecord } from "./types";

/**
 * One-way import of the pre-SQLite per-pair state files
 * (<userData>/sync/sync-state/<pairId>.json) into the index.
 *
 * Runs once per installation. The failure mode this is built around: an
 * EMPTY base tree is not a harmless fresh start - it reads as "nothing was
 * ever synced", which makes a two-way pair re-derive its entire tree and a
 * push pair re-upload it. So a file that cannot be parsed is reported to the
 * caller (which surfaces it) and left on disk as a `.corrupt.bak`; it is
 * never quietly treated as no-state. Each pair imports inside ONE
 * transaction, because half a base tree is more dangerous than none.
 *
 * Type-only import of SyncIndex on purpose: this module stays runtime-leaf so
 * `node --test` can load it (see the note in index-db.ts).
 */

const MIGRATION_FLAG = "json_migration_done";

/** Backups are swept mechanically instead of "deleted two releases later". */
const BAK_RETENTION_MS = 60 * 24 * 60 * 60 * 1000;

export interface MigrationResult {
  /** pairIds imported by this call. */
  migrated: string[];
  /** pairIds whose state could not be read - each left behind as .corrupt.bak. */
  failed: { pairId: string; error: string }[];
  /** True when the migration had already run and nothing was re-imported. */
  skipped: boolean;
}

function isObj(v: unknown): v is Record<string, any> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** Coerce a stored record, or null when it is too damaged to be usable. */
function coerceFile(remoteId: string, r: unknown): SyncFileRecord | null {
  if (!isObj(r)) return null;
  const localPath = typeof r.localPath === "string" ? r.localPath : "";
  if (!localPath) return null; // without a path it can never be looked up
  const record: SyncFileRecord = {
    remoteId,
    remoteName: typeof r.remoteName === "string" ? r.remoteName : localPath.split("/").pop() || localPath,
    remoteFolderId: typeof r.remoteFolderId === "string" ? r.remoteFolderId : null,
    remoteSizeBytes: num(r.remoteSizeBytes),
    remoteUpdatedAt: num(r.remoteUpdatedAt),
    remoteVersion: num(r.remoteVersion, 1),
    localPath,
    localSizeBytes: num(r.localSizeBytes),
    localMtimeMs: num(r.localMtimeMs),
    syncedAt: num(r.syncedAt),
  };
  if (typeof r.contentHash === "string") record.contentHash = r.contentHash;
  return record;
}

function coerceFolder(relPath: string, r: unknown): SyncFolderRecord | null {
  if (!isObj(r)) return null;
  if (typeof r.remoteId !== "string") return null;
  return {
    remoteId: r.remoteId,
    remoteName: typeof r.remoteName === "string" ? r.remoteName : relPath.split("/").pop() || relPath,
    remoteParentId: typeof r.remoteParentId === "string" ? r.remoteParentId : null,
    localPath: typeof r.localPath === "string" ? r.localPath : relPath,
    syncedAt: num(r.syncedAt),
  };
}

function coerceError(relPath: string, r: unknown): SyncFileError | null {
  if (!isObj(r)) return null;
  return {
    filePath: typeof r.filePath === "string" ? r.filePath : relPath,
    error: typeof r.error === "string" ? r.error : "Unknown error",
    retryCount: num(r.retryCount),
    lastAttemptAt: num(r.lastAttemptAt),
    permanent: r.permanent === true,
  };
}

/** Import one parsed pair state. Throws if the shape is unusable. */
function importPairState(db: SyncIndex, pairId: string, parsed: unknown): void {
  if (!isObj(parsed)) throw new Error("state file is not an object");
  if (parsed.files !== undefined && !isObj(parsed.files)) throw new Error("`files` is not an object");
  if (parsed.folders !== undefined && !isObj(parsed.folders)) throw new Error("`folders` is not an object");
  if (parsed.fileErrors !== undefined && !isObj(parsed.fileErrors)) throw new Error("`fileErrors` is not an object");

  db.transaction(() => {
    for (const [remoteId, raw] of Object.entries(isObj(parsed.files) ? parsed.files : {})) {
      const record = coerceFile(remoteId, raw);
      if (record) db.upsertFile(pairId, record);
    }
    for (const [relPath, raw] of Object.entries(isObj(parsed.folders) ? parsed.folders : {})) {
      const record = coerceFolder(relPath, raw);
      if (record) db.upsertFolder(pairId, record);
    }
    for (const [relPath, raw] of Object.entries(isObj(parsed.fileErrors) ? parsed.fileErrors : {})) {
      const record = coerceError(relPath, raw);
      if (record) db.upsertError(pairId, record);
    }
    db.setPairMeta(pairId, {
      lastRemotePollAt: num(parsed.lastRemotePollAt),
      lastFullSyncAt: num(parsed.lastFullSyncAt),
      rootFolderCreated: parsed.rootFolderCreated === true,
    });
  });
}

/** Delete retired state backups once they are older than the retention window. */
async function sweepOldBackups(syncStateDir: string): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(syncStateDir);
  } catch {
    return;
  }
  const cutoff = Date.now() - BAK_RETENTION_MS;
  for (const name of entries) {
    if (!name.endsWith(".bak")) continue;
    const full = join(syncStateDir, name);
    try {
      const s = await stat(full);
      if (s.mtimeMs < cutoff) await unlink(full);
    } catch {
      // A backup we can't stat or remove is not worth failing a startup over.
    }
  }
}

export async function migrateJsonStateIfNeeded(
  db: SyncIndex,
  syncStateDir: string,
): Promise<MigrationResult> {
  const result: MigrationResult = { migrated: [], failed: [], skipped: false };

  if (db.getMeta(MIGRATION_FLAG) === "1") {
    // Already done. A JSON file appearing later (an older build run against
    // the same profile) must NOT be replayed over newer index state.
    result.skipped = true;
    await sweepOldBackups(syncStateDir);
    return result;
  }

  let entries: string[];
  try {
    entries = await readdir(syncStateDir);
  } catch {
    // No directory at all: a fresh install. Nothing to import, and the flag
    // is set so this never runs again.
    db.setMeta(MIGRATION_FLAG, "1");
    return result;
  }

  for (const name of entries) {
    if (!name.endsWith(".json")) continue;
    const pairId = name.slice(0, -".json".length);
    const full = join(syncStateDir, name);
    try {
      const raw = await readFile(full, "utf-8");
      importPairState(db, pairId, JSON.parse(raw));
      result.migrated.push(pairId);
      await rename(full, `${full}.migrated.bak`).catch(() => {});
    } catch (err: any) {
      result.failed.push({ pairId, error: err?.message ?? String(err) });
      await rename(full, `${full}.corrupt.bak`).catch(() => {});
    }
  }

  db.setMeta(MIGRATION_FLAG, "1");
  await sweepOldBackups(syncStateDir);
  return result;
}
