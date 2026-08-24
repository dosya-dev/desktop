import { DatabaseSync, type StatementSync } from "node:sqlite";
import type { SyncFileError, SyncFileRecord, SyncFolderRecord } from "./types";

/**
 * The sync index: the durable "base tree" - what both sides looked like after
 * the last successful sync - plus the error ledger and (from later phases) the
 * op queue and block lists.
 *
 * This replaces one JSON blob per pair that was rewritten in full every 500
 * file operations, holding three to four copies of a multi-hundred-MB object
 * in memory each time. That design is what made a 500K-file sync fatal
 * (2026-08-20 stress test).
 *
 * THIS IS THE ONLY FILE IN THE CODEBASE THAT SPEAKS SQL. Keep it that way:
 * it is what makes a future swap of the driver (node:sqlite → better-sqlite3
 * or anything else) a one-file change behind an unchanged interface.
 *
 * node:sqlite quirks this module absorbs so callers never see them:
 *  - booleans and `undefined` CANNOT be bound (they throw); everything is
 *    mapped to 0/1 and NULL here, and mapped back on read.
 *  - an absent contentHash round-trips as an ABSENT key, not `undefined`, so
 *    records still deep-compare against the engine's in-memory shape.
 *
 * No electron imports: the caller supplies the path, which is what lets the
 * unit tests (and, later, the utility process) open one anywhere.
 */

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS pair_meta (
  pair_id TEXT PRIMARY KEY,
  last_remote_poll_at INTEGER NOT NULL DEFAULT 0,
  last_full_sync_at INTEGER NOT NULL DEFAULT 0,
  root_folder_created INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS files (
  pair_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,           -- case/NFC-preserving, forward slashes
  path_key TEXT NOT NULL,           -- pathKey(rel_path): NFC + case-folded
  remote_name TEXT NOT NULL,
  remote_folder_id TEXT,
  remote_size INTEGER NOT NULL,
  remote_updated_at INTEGER NOT NULL,
  remote_version INTEGER NOT NULL,
  local_size INTEGER NOT NULL,
  local_mtime_ms REAL NOT NULL,     -- REAL: mtimeMs carries sub-ms precision
  content_hash TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (pair_id, remote_id)
);
-- Deliberately NOT unique. The server can hold "Foo.txt" and "foo.txt" as two
-- files; a case-insensitive local filesystem cannot. A UNIQUE index would
-- either throw inside a write-through call (breaking sync where it currently
-- limps) or silently drop the loser's base row, which makes the two files
-- re-download over each other forever. Both rows are kept, lookups resolve to
-- the most recently synced one (mirroring the old in-memory PathIndex, where
-- the last writer won), and surfacing the collision as a real conflict is the
-- planner's job in Phase 2.
CREATE INDEX IF NOT EXISTS files_by_path ON files(pair_id, path_key);

CREATE TABLE IF NOT EXISTS folders (
  pair_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  remote_name TEXT NOT NULL,
  remote_parent_id TEXT,
  synced_at INTEGER NOT NULL,
  PRIMARY KEY (pair_id, rel_path)
);

CREATE TABLE IF NOT EXISTS file_errors (
  pair_id TEXT NOT NULL,
  rel_path TEXT NOT NULL,
  error TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  last_attempt_at INTEGER NOT NULL,
  permanent INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (pair_id, rel_path)
);

-- Created now, used from Phase 3 (persistent op queue) and Phase 4 (blocks).
CREATE TABLE IF NOT EXISTS ops (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pair_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,            -- JSON
  state TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
-- id included so "pop oldest N pending" stays a pure index walk at 500K rows
CREATE INDEX IF NOT EXISTS ops_pending ON ops(pair_id, state, id);

CREATE TABLE IF NOT EXISTS blocks (
  pair_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  hash TEXT NOT NULL,
  PRIMARY KEY (pair_id, remote_id, idx)
);
CREATE INDEX IF NOT EXISTS blocks_by_hash ON blocks(pair_id, hash);
`;

/** Tables holding per-pair rows - deletePair clears every one of them. */
const PAIR_TABLES = ["files", "folders", "file_errors", "pair_meta", "ops", "blocks"] as const;

const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * The lookup key for a relative path: NFC-normalized, and case-folded on
 * filesystems that treat "Foo.txt" and "foo.txt" as one file.
 *
 * Deliberately owned by this module rather than imported from paths.ts, for
 * two reasons. Architecturally: these keys are WRITTEN TO DISK in path_key.
 * If the shared pathKey() ever changed, every persisted key would silently
 * become unreachable - a change that needs a reindex migration, not a quiet
 * behavior shift, and the index is what has to know that. Practically: a
 * module that `node --test` loads directly cannot have value imports from
 * siblings (Node's strip-only TypeScript mode does not resolve extensionless
 * or .js specifiers to .ts files), so the index has to be a leaf to stay
 * testable at all.
 *
 * index-db.test.ts asserts this agrees with paths.ts's pathKey on a table of
 * inputs, so the two cannot diverge unnoticed - and if someone changes the
 * shared one on purpose, that red test is the reminder that a reindex is due.
 */
export function indexPathKey(relPath: string): string {
  const nfc = relPath.normalize("NFC");
  return CASE_INSENSITIVE ? nfc.toLowerCase() : nfc;
}

type Row = Record<string, any>;

export interface FileBlock {
  idx: number;
  offset: number;
  size: number;
  /** Strong content hash of this chunk - its identity for dedup. */
  hash: string;
}

export type OpState = "pending" | "running" | "done" | "failed";

export interface QueuedOp {
  id: number;
  pairId: string;
  kind: string;
  /** The stored PlanOp. Callers cast it back to PlanOp. */
  payload: unknown;
  state: OpState;
  attempts: number;
}

export interface PairMeta {
  lastRemotePollAt: number;
  lastFullSyncAt: number;
  rootFolderCreated: boolean;
}

const EMPTY_PAIR_META: PairMeta = { lastRemotePollAt: 0, lastFullSyncAt: 0, rootFolderCreated: false };

export class SyncIndex {
  private stmts = new Map<string, StatementSync>();
  private txDepth = 0;
  // Declared explicitly rather than as a constructor parameter property:
  // `node --test` strips types without transforming, and parameter
  // properties are unsupported there.
  private db: DatabaseSync;

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(dbPath: string): SyncIndex {
    const db = new DatabaseSync(dbPath);
    db.exec(SCHEMA);
    const index = new SyncIndex(db);
    index.migrateSchema();
    if (!index.getMeta("schema_version")) index.setMeta("schema_version", "2");
    return index;
  }

  /**
   * Additive, idempotent schema changes for databases that already exist on a
   * user's disk. CREATE TABLE IF NOT EXISTS above only helps a fresh file, so
   * anything added to an existing table has to be applied here - and has to be
   * safe to run on every single open.
   */
  private migrateSchema(): void {
    const opColumns = this.db.prepare("PRAGMA table_info(ops)").all() as Row[];
    if (!opColumns.some((c) => c.name === "attempts")) {
      this.db.exec("ALTER TABLE ops ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0");
    }
  }

  close(): void {
    this.stmts.clear();
    this.db.close();
  }

  /** Prepared-statement cache. Statements are reused for the connection's life. */
  private s(sql: string): StatementSync {
    let st = this.stmts.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.stmts.set(sql, st);
    }
    return st;
  }

  /**
   * Run `fn` inside one transaction. Nested calls JOIN the outer transaction
   * rather than failing (SQLite has no nested BEGIN) - write-through call
   * sites nest freely, and an inner throw still rolls the whole thing back.
   */
  transaction<T>(fn: () => T): T {
    if (this.txDepth > 0) return fn();
    this.db.exec("BEGIN IMMEDIATE");
    this.txDepth++;
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      try { this.db.exec("ROLLBACK"); } catch { /* connection already unwound */ }
      throw err;
    } finally {
      this.txDepth--;
    }
  }

  // ── meta ──────────────────────────────────────────────────────────

  getMeta(key: string): string | undefined {
    const row = this.s("SELECT value FROM meta WHERE key = ?").get(key) as Row | undefined;
    return row ? String(row.value) : undefined;
  }

  setMeta(key: string, value: string): void {
    this.s(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(key, value);
  }

  // ── files ─────────────────────────────────────────────────────────

  private static fileFromRow(r: Row): SyncFileRecord {
    const record: SyncFileRecord = {
      remoteId: String(r.remote_id),
      remoteName: String(r.remote_name),
      remoteFolderId: r.remote_folder_id == null ? null : String(r.remote_folder_id),
      remoteSizeBytes: Number(r.remote_size),
      remoteUpdatedAt: Number(r.remote_updated_at),
      remoteVersion: Number(r.remote_version),
      localPath: String(r.rel_path),
      localSizeBytes: Number(r.local_size),
      localMtimeMs: Number(r.local_mtime_ms),
      syncedAt: Number(r.synced_at),
    };
    // Absent, not undefined - see the header note on deep-comparability.
    if (r.content_hash != null) record.contentHash = String(r.content_hash);
    return record;
  }

  getFileById(pairId: string, remoteId: string): SyncFileRecord | undefined {
    const row = this.s("SELECT * FROM files WHERE pair_id = ? AND remote_id = ?").get(pairId, remoteId) as Row | undefined;
    return row ? SyncIndex.fileFromRow(row) : undefined;
  }

  /**
   * Look a file up by its relative path. Case/NFC variants collapse to one
   * key; when two remote files share a key (see the files_by_path note in the
   * schema) the most recently synced one wins, which is what the in-memory
   * PathIndex did.
   */
  getFileByPath(pairId: string, relPath: string): SyncFileRecord | undefined {
    const row = this.s(
      "SELECT * FROM files WHERE pair_id = ? AND path_key = ? ORDER BY synced_at DESC, remote_id DESC LIMIT 1",
    ).get(pairId, indexPathKey(relPath)) as Row | undefined;
    return row ? SyncIndex.fileFromRow(row) : undefined;
  }

  upsertFile(pairId: string, record: SyncFileRecord): void {
    this.s(`INSERT INTO files (
        pair_id, remote_id, rel_path, path_key, remote_name, remote_folder_id,
        remote_size, remote_updated_at, remote_version, local_size, local_mtime_ms,
        content_hash, synced_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id, remote_id) DO UPDATE SET
        rel_path = excluded.rel_path,
        path_key = excluded.path_key,
        remote_name = excluded.remote_name,
        remote_folder_id = excluded.remote_folder_id,
        remote_size = excluded.remote_size,
        remote_updated_at = excluded.remote_updated_at,
        remote_version = excluded.remote_version,
        local_size = excluded.local_size,
        local_mtime_ms = excluded.local_mtime_ms,
        content_hash = excluded.content_hash,
        synced_at = excluded.synced_at`,
    ).run(
      pairId,
      record.remoteId,
      record.localPath,
      indexPathKey(record.localPath),
      record.remoteName,
      record.remoteFolderId ?? null,
      record.remoteSizeBytes,
      record.remoteUpdatedAt,
      record.remoteVersion,
      record.localSizeBytes,
      record.localMtimeMs,
      record.contentHash ?? null,
      record.syncedAt,
    );
  }

  deleteFileById(pairId: string, remoteId: string): void {
    this.s("DELETE FROM files WHERE pair_id = ? AND remote_id = ?").run(pairId, remoteId);
  }

  countFiles(pairId: string): number {
    const row = this.s("SELECT COUNT(*) AS n FROM files WHERE pair_id = ?").get(pairId) as Row;
    return Number(row.n);
  }

  *iterFiles(pairId: string): IterableIterator<SyncFileRecord> {
    // Fresh statement per iterator: a cached one can't serve two live
    // iterations, and hydration may run per pair in quick succession.
    const st = this.db.prepare("SELECT * FROM files WHERE pair_id = ?");
    for (const row of st.iterate(pairId)) yield SyncIndex.fileFromRow(row as Row);
  }

  // ── folders ───────────────────────────────────────────────────────

  private static folderFromRow(r: Row): SyncFolderRecord {
    return {
      remoteId: String(r.remote_id),
      remoteName: String(r.remote_name),
      remoteParentId: r.remote_parent_id == null ? null : String(r.remote_parent_id),
      localPath: String(r.rel_path),
      syncedAt: Number(r.synced_at),
    };
  }

  getFolder(pairId: string, relPath: string): SyncFolderRecord | undefined {
    const row = this.s("SELECT * FROM folders WHERE pair_id = ? AND rel_path = ?").get(pairId, relPath) as Row | undefined;
    return row ? SyncIndex.folderFromRow(row) : undefined;
  }

  upsertFolder(pairId: string, record: SyncFolderRecord): void {
    this.s(`INSERT INTO folders (pair_id, rel_path, remote_id, remote_name, remote_parent_id, synced_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id, rel_path) DO UPDATE SET
        remote_id = excluded.remote_id,
        remote_name = excluded.remote_name,
        remote_parent_id = excluded.remote_parent_id,
        synced_at = excluded.synced_at`,
    ).run(pairId, record.localPath, record.remoteId, record.remoteName, record.remoteParentId ?? null, record.syncedAt);
  }

  deleteFolder(pairId: string, relPath: string): void {
    this.s("DELETE FROM folders WHERE pair_id = ? AND rel_path = ?").run(pairId, relPath);
  }

  *iterFolders(pairId: string): IterableIterator<SyncFolderRecord> {
    const st = this.db.prepare("SELECT * FROM folders WHERE pair_id = ?");
    for (const row of st.iterate(pairId)) yield SyncIndex.folderFromRow(row as Row);
  }

  // ── file errors ───────────────────────────────────────────────────

  private static errorFromRow(r: Row): SyncFileError {
    return {
      filePath: String(r.rel_path),
      error: String(r.error),
      retryCount: Number(r.retry_count),
      lastAttemptAt: Number(r.last_attempt_at),
      // Back to a real boolean: the retry ladder compares with === true.
      permanent: Number(r.permanent) === 1,
    };
  }

  getError(pairId: string, relPath: string): SyncFileError | undefined {
    const row = this.s("SELECT * FROM file_errors WHERE pair_id = ? AND rel_path = ?").get(pairId, relPath) as Row | undefined;
    return row ? SyncIndex.errorFromRow(row) : undefined;
  }

  upsertError(pairId: string, err: SyncFileError): void {
    this.s(`INSERT INTO file_errors (pair_id, rel_path, error, retry_count, last_attempt_at, permanent)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pair_id, rel_path) DO UPDATE SET
        error = excluded.error,
        retry_count = excluded.retry_count,
        last_attempt_at = excluded.last_attempt_at,
        permanent = excluded.permanent`,
    ).run(pairId, err.filePath, err.error, err.retryCount, err.lastAttemptAt, err.permanent ? 1 : 0);
  }

  clearError(pairId: string, relPath: string): void {
    this.s("DELETE FROM file_errors WHERE pair_id = ? AND rel_path = ?").run(pairId, relPath);
  }

  *iterErrors(pairId: string): IterableIterator<SyncFileError> {
    const st = this.db.prepare("SELECT * FROM file_errors WHERE pair_id = ?");
    for (const row of st.iterate(pairId)) yield SyncIndex.errorFromRow(row as Row);
  }

  /** Drop errors last attempted before `olderThanMs`. Returns rows removed. */
  pruneErrors(pairId: string, olderThanMs: number): number {
    const res = this.s("DELETE FROM file_errors WHERE pair_id = ? AND last_attempt_at < ?").run(pairId, olderThanMs);
    return Number(res.changes);
  }

  // ── pair meta ─────────────────────────────────────────────────────

  getPairMeta(pairId: string): PairMeta {
    const row = this.s("SELECT * FROM pair_meta WHERE pair_id = ?").get(pairId) as Row | undefined;
    if (!row) return { ...EMPTY_PAIR_META };
    return {
      lastRemotePollAt: Number(row.last_remote_poll_at),
      lastFullSyncAt: Number(row.last_full_sync_at),
      rootFolderCreated: Number(row.root_folder_created) === 1,
    };
  }

  setPairMeta(pairId: string, meta: Partial<PairMeta>): void {
    const next = { ...this.getPairMeta(pairId), ...meta };
    this.s(`INSERT INTO pair_meta (pair_id, last_remote_poll_at, last_full_sync_at, root_folder_created)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(pair_id) DO UPDATE SET
        last_remote_poll_at = excluded.last_remote_poll_at,
        last_full_sync_at = excluded.last_full_sync_at,
        root_folder_created = excluded.root_folder_created`,
    ).run(pairId, next.lastRemotePollAt, next.lastFullSyncAt, next.rootFolderCreated ? 1 : 0);
  }

  // ── ops queue ─────────────────────────────────────────────────────
  //
  // Planned work is persisted rather than held in an array, so a crash or a
  // quit resumes where it stopped instead of re-walking the tree to reach the
  // same conclusions. The state machine is deliberately tiny:
  //
  //   pending --pop--> running --complete--> done --sweep--> (gone)
  //                       |
  //                       +--fail(transient)--> pending (attempts + 1)
  //                       +--fail(permanent)--> failed (kept for the user)

  private static opFromRow(r: Row): QueuedOp {
    let payload: unknown = null;
    try { payload = JSON.parse(String(r.payload)); } catch { payload = null; }
    return {
      id: Number(r.id),
      pairId: String(r.pair_id),
      kind: String(r.kind),
      payload,
      state: String(r.state) as OpState,
      attempts: Number(r.attempts ?? 0),
    };
  }

  /** Append work. Returns how many rows were written. */
  enqueueOps(pairId: string, ops: { kind: string; payload: unknown }[], now: number): number {
    if (ops.length === 0) return 0;
    const insert = this.s(
      `INSERT INTO ops (pair_id, kind, payload, state, created_at, updated_at, attempts)
       VALUES (?, ?, ?, 'pending', ?, ?, 0)`,
    );
    this.transaction(() => {
      for (const op of ops) insert.run(pairId, op.kind, JSON.stringify(op.payload), now, now);
    });
    return ops.length;
  }

  /**
   * Claim up to `limit` of the oldest pending ops, marking them running in the
   * same transaction as the read - so two consumers can never take the same
   * row.
   */
  popPendingOps(pairId: string, limit: number, now: number): QueuedOp[] {
    return this.transaction(() => {
      const rows = this.s(
        `SELECT * FROM ops WHERE pair_id = ? AND state = 'pending' ORDER BY id LIMIT ?`,
      ).all(pairId, limit) as Row[];
      if (rows.length === 0) return [];
      const claim = this.s("UPDATE ops SET state = 'running', updated_at = ? WHERE id = ?");
      for (const row of rows) claim.run(now, Number(row.id));
      return rows.map((r) => SyncIndex.opFromRow({ ...r, state: "running" }));
    });
  }

  /**
   * Mark an op done, optionally performing the index mutation it represents in
   * the SAME transaction. `mutate` runs FIRST: if it throws, nothing is
   * written and the op stays running, because an op marked done whose effect
   * never landed is how an engine comes to believe it uploaded a file it did
   * not (invariant I2).
   */
  completeOp(id: number, now: number, mutate?: () => void): void {
    this.transaction(() => {
      mutate?.();
      this.s("UPDATE ops SET state = 'done', updated_at = ? WHERE id = ?").run(now, id);
    });
  }

  /** Transient failures go back in the queue; permanent ones are kept, visible. */
  failOp(id: number, now: number, permanent: boolean): void {
    this.s(
      `UPDATE ops SET state = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`,
    ).run(permanent ? "failed" : "pending", now, id);
  }

  /**
   * Count ops in a state. `sinceMs` bounds it to rows last touched at or
   * after that time, which is how progress for the CURRENT run is counted
   * without completed rows from previous runs (kept for a week) inflating it.
   */
  countOpsByState(pairId: string, state: OpState, sinceMs?: number): number {
    const row = sinceMs === undefined
      ? this.s("SELECT COUNT(*) AS n FROM ops WHERE pair_id = ? AND state = ?").get(pairId, state) as Row
      : this.s("SELECT COUNT(*) AS n FROM ops WHERE pair_id = ? AND state = ? AND updated_at >= ?").get(pairId, state, sinceMs) as Row;
    return Number(row.n);
  }

  /**
   * Crash recovery: anything left running belongs to a process that is gone.
   * Returns it to the queue. Returns how many were re-queued.
   */
  resetRunningOps(pairId: string, now: number): number {
    const res = this.s(
      "UPDATE ops SET state = 'pending', updated_at = ? WHERE pair_id = ? AND state = 'running'",
    ).run(now, pairId);
    return Number(res.changes);
  }

  /** Retention: completed rows are kept briefly for resume clarity, then dropped. */
  sweepDoneOps(olderThanMs: number): number {
    const res = this.s("DELETE FROM ops WHERE state = 'done' AND updated_at < ?").run(olderThanMs);
    return Number(res.changes);
  }

  // ── blocks (content-defined chunks) ───────────────────────────────
  //
  // A file's chunk list is what lets an edit to a huge file cost only the
  // changed chunks instead of the whole thing, and what lets the engine ask
  // "do we already have this content" without walking anything.

  /** Replace a file's chunk list. Replace, not append: a re-chunked file that
   *  shrank must not keep a stale tail that a delta upload would reference. */
  setBlocks(pairId: string, remoteId: string, blocks: FileBlock[]): void {
    this.transaction(() => {
      this.s("DELETE FROM blocks WHERE pair_id = ? AND remote_id = ?").run(pairId, remoteId);
      if (blocks.length === 0) return;
      const insert = this.s(
        "INSERT INTO blocks (pair_id, remote_id, idx, offset, size, hash) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const b of blocks) insert.run(pairId, remoteId, b.idx, b.offset, b.size, b.hash);
    });
  }

  getBlocks(pairId: string, remoteId: string): FileBlock[] {
    const rows = this.s(
      "SELECT idx, offset, size, hash FROM blocks WHERE pair_id = ? AND remote_id = ? ORDER BY idx",
    ).all(pairId, remoteId) as Row[];
    return rows.map((r) => ({
      idx: Number(r.idx), offset: Number(r.offset), size: Number(r.size), hash: String(r.hash),
    }));
  }

  countBlocks(pairId: string): number {
    const row = this.s("SELECT COUNT(*) AS n FROM blocks WHERE pair_id = ?").get(pairId) as Row;
    return Number(row.n);
  }

  /**
   * Files whose whole-file content hash AND size both match. Size is a cheap
   * guard so a hash collision is never taken as identity on its own, and it
   * is a field the scanner already has for free.
   *
   * A record with no stored hash never matches: NULL must not read as
   * "matches anything", or unrelated files would be treated as moves.
   */
  /**
   * Files recorded at exactly this size. The cheap first pass of rename
   * detection: size comes free from the scan, so it narrows the set that has
   * to be hashed down to a handful.
   */
  findFilesBySize(pairId: string, sizeBytes: number): SyncFileRecord[] {
    const rows = this.s("SELECT * FROM files WHERE pair_id = ? AND local_size = ?").all(pairId, sizeBytes) as Row[];
    return rows.map((r) => SyncIndex.fileFromRow(r));
  }

  /**
   * Tracked files with no content hash yet. These are files synced before
   * hashing was universal: they never re-upload, so without a deliberate
   * backfill they would keep a NULL hash forever and could never participate
   * in dedup or rename detection.
   */
  findFilesWithoutHash(pairId: string, limit: number): SyncFileRecord[] {
    const rows = this.s(
      "SELECT * FROM files WHERE pair_id = ? AND content_hash IS NULL ORDER BY remote_id LIMIT ?",
    ).all(pairId, limit) as Row[];
    return rows.map((r) => SyncIndex.fileFromRow(r));
  }

  countFilesWithoutHash(pairId: string): number {
    const row = this.s("SELECT COUNT(*) AS n FROM files WHERE pair_id = ? AND content_hash IS NULL").get(pairId) as Row;
    return Number(row.n);
  }

  findFilesByContentHash(pairId: string, contentHash: string, sizeBytes: number): SyncFileRecord[] {
    const rows = this.s(
      "SELECT * FROM files WHERE pair_id = ? AND content_hash IS NOT NULL AND content_hash = ? AND local_size = ?",
    ).all(pairId, contentHash, sizeBytes) as Row[];
    return rows.map((r) => SyncIndex.fileFromRow(r));
  }

  // ── teardown ──────────────────────────────────────────────────────

  /** Remove every trace of a pair. One transaction: a half-removed pair would
   *  re-sync some rows and not others on the next start. */
  deletePair(pairId: string): void {
    this.transaction(() => {
      for (const table of PAIR_TABLES) {
        this.s(`DELETE FROM ${table} WHERE pair_id = ?`).run(pairId);
      }
    });
  }
}
