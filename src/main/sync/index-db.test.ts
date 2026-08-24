import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SyncIndex, indexPathKey } from "./index-db.ts";
import { pathKey } from "./paths.ts";
import type { SyncFileRecord } from "./types.ts";

// The base tree - "what both sides looked like after the last successful
// sync" - used to be one JSON blob per pair, rewritten in full every 500 file
// operations. That design is what made a 500K-file sync fatal (2026-08-20
// stress test). It lives in SQLite now: incremental, transactional, and
// bounded in memory.

function rec(overrides: Partial<SyncFileRecord> = {}): SyncFileRecord {
  return {
    remoteId: "f_1", remoteName: "a.txt", remoteFolderId: "fo_1",
    remoteSizeBytes: 10, remoteUpdatedAt: 100, remoteVersion: 1,
    localPath: "Dir/a.txt", localSizeBytes: 10, localMtimeMs: 1234.5,
    syncedAt: 999, contentHash: "h1", ...overrides,
  };
}

test("the index's persisted key format agrees with the engine's pathKey", () => {
  // path_key is written to disk. If these two ever diverge, every persisted
  // key silently stops matching what lookups compute - so this test failing
  // is the signal that a reindex migration is required, not a nuisance.
  for (const p of [
    "Dir/a.txt", "DIR/A.TXT", "Döcs/Ü.txt", "Döcs/Ü.txt".normalize("NFD"),
    "a/b/c/d.bin", "", "no-slash", "Ünïcödé ☃/файл.txt", "trailing/",
  ]) {
    assert.equal(indexPathKey(p), pathKey(p), JSON.stringify(p));
  }
});

test("open creates the schema and survives reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.upsertFile("p1", rec());
    db.close();
    const db2 = SyncIndex.open(join(dir, "index.db"));
    assert.equal(db2.getFileById("p1", "f_1")?.remoteName, "a.txt");
    db2.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a file record round-trips every field exactly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    const r = rec();
    db.upsertFile("p1", r);
    assert.deepEqual(db.getFileById("p1", "f_1"), r);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a record without a content hash round-trips as absent, not null", async () => {
  // SQLite has NULL, JS records have an optional field. deepEqual against the
  // engine's in-memory shape only holds if the key stays absent.
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    const r = rec({ contentHash: undefined, remoteFolderId: null });
    db.upsertFile("p1", r);
    const back = db.getFileById("p1", "f_1")!;
    assert.equal("contentHash" in back, false);
    assert.equal(back.remoteFolderId, null);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("path lookup is pathKey-normalized (NFC + case-fold), round-trips the preserved path", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.upsertFile("p1", rec({ localPath: "Döcs/Ü.txt" }));
    const hit = db.getFileByPath("p1", "döcs/ü.txt".normalize("NFD")); // different case AND normalization
    assert.equal(hit?.remoteId, "f_1");
    assert.equal(hit?.localPath, "Döcs/Ü.txt"); // preserved form comes back
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("upsert replaces; path index follows a moved file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.upsertFile("p1", rec());
    db.upsertFile("p1", rec({ localPath: "Other/b.txt", localSizeBytes: 20 }));
    assert.equal(db.countFiles("p1"), 1);
    assert.equal(db.getFileByPath("p1", "Dir/a.txt"), undefined);
    assert.equal(db.getFileByPath("p1", "Other/b.txt")?.localSizeBytes, 20);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("two remote files colliding on one path key both survive; newest wins the lookup", async () => {
  // The server can hold "Foo.txt" and "foo.txt"; a case-insensitive local
  // filesystem cannot. Neither throwing (breaks a write-through call mid-sync)
  // nor dropping the loser (the two then re-download over each other forever)
  // is acceptable, so both rows are kept and the most recently synced one
  // answers the lookup - the old in-memory PathIndex's last-writer-wins rule.
  // Surfacing this as a real conflict belongs to the planner (Phase 2).
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.upsertFile("p1", rec({ remoteId: "f_1", localPath: "Dir/a.txt", syncedAt: 100 }));
    db.upsertFile("p1", rec({ remoteId: "f_2", localPath: "dir/A.txt", syncedAt: 200 }));
    assert.equal(db.countFiles("p1"), 2);
    assert.equal(db.getFileById("p1", "f_1")?.localPath, "Dir/a.txt"); // loser's base row intact
    assert.equal(db.getFileByPath("p1", "Dir/a.txt")?.remoteId, "f_2"); // newest answers
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pairs are isolated and deletePair removes everything atomically", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.upsertFile("p1", rec()); db.upsertFile("p2", rec());
    db.upsertFolder("p1", { remoteId: "fo_1", remoteName: "Dir", remoteParentId: null, localPath: "Dir", syncedAt: 1 });
    db.upsertError("p1", { filePath: "x", error: "e", retryCount: 1, lastAttemptAt: 1, permanent: false });
    db.setPairMeta("p1", { lastFullSyncAt: 5 });
    db.deletePair("p1");
    assert.equal(db.countFiles("p1"), 0);
    assert.equal(db.countFiles("p2"), 1);
    assert.equal(db.getFolder("p1", "Dir"), undefined);
    assert.equal(db.getError("p1", "x"), undefined);
    assert.equal(db.getPairMeta("p1").lastFullSyncAt, 0);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("transaction rolls back on throw", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    assert.throws(() => db.transaction(() => {
      db.upsertFile("p1", rec());
      throw new Error("boom");
    }), /boom/);
    assert.equal(db.countFiles("p1"), 0);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("nested transactions join the outer one instead of erroring", async () => {
  // Write-through call sites nest freely (an executor inside a batch commit);
  // SQLite has no nested BEGIN, so the inner call must join, and an inner
  // throw must still roll the whole thing back.
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.transaction(() => {
      db.upsertFile("p1", rec());
      db.transaction(() => db.upsertFile("p1", rec({ remoteId: "f_2", localPath: "Dir/b.txt" })));
    });
    assert.equal(db.countFiles("p1"), 2);
    assert.throws(() => db.transaction(() => {
      db.upsertFile("p1", rec({ remoteId: "f_3", localPath: "Dir/c.txt" }));
      db.transaction(() => { throw new Error("inner"); });
    }), /inner/);
    assert.equal(db.countFiles("p1"), 2); // f_3 rolled back
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("iterFiles streams every record; errors prune by age", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    for (let i = 0; i < 250; i++) db.upsertFile("p1", rec({ remoteId: `f_${i}`, localPath: `d/f${i}` }));
    assert.equal([...db.iterFiles("p1")].length, 250);
    db.upsertError("p1", { filePath: "old", error: "e", retryCount: 1, lastAttemptAt: 1, permanent: false });
    db.upsertError("p1", { filePath: "new", error: "e", retryCount: 1, lastAttemptAt: Date.now(), permanent: false });
    assert.equal(db.pruneErrors("p1", Date.now() - 1000), 1);
    assert.equal(db.getError("p1", "new")?.filePath, "new");
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("error records round-trip the permanent flag as a real boolean", async () => {
  // node:sqlite refuses to bind booleans, so the mapper converts both ways.
  // A truthy 1 leaking into the engine would read as `permanent === 1`, which
  // fails the `=== true` checks the retry ladder makes.
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.upsertError("p1", { filePath: "p", error: "denied", retryCount: 3, lastAttemptAt: 7, permanent: true });
    const back = db.getError("p1", "p")!;
    assert.equal(back.permanent, true);
    assert.deepEqual(back, { filePath: "p", error: "denied", retryCount: 3, lastAttemptAt: 7, permanent: true });
    db.clearError("p1", "p");
    assert.equal(db.getError("p1", "p"), undefined);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("folders round-trip and iterate", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    const f = { remoteId: "fo_1", remoteName: "Dir", remoteParentId: null, localPath: "Dir", syncedAt: 3 };
    db.upsertFolder("p1", f);
    db.upsertFolder("p1", { remoteId: "fo_2", remoteName: "Sub", remoteParentId: "fo_1", localPath: "Dir/Sub", syncedAt: 4 });
    assert.deepEqual(db.getFolder("p1", "Dir"), f);
    assert.equal([...db.iterFolders("p1")].length, 2);
    db.deleteFolder("p1", "Dir");
    assert.equal(db.getFolder("p1", "Dir"), undefined);
    assert.equal([...db.iterFolders("p1")].length, 1);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("pair meta defaults and partial updates", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    assert.deepEqual(db.getPairMeta("p1"), { lastRemotePollAt: 0, lastFullSyncAt: 0, rootFolderCreated: false });
    db.setPairMeta("p1", { rootFolderCreated: true });
    db.setPairMeta("p1", { lastFullSyncAt: 42 });
    assert.deepEqual(db.getPairMeta("p1"), { lastRemotePollAt: 0, lastFullSyncAt: 42, rootFolderCreated: true });
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("meta keys store and overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    assert.equal(db.getMeta("nope"), undefined);
    db.setMeta("json_migration_done", "1");
    db.setMeta("json_migration_done", "2");
    assert.equal(db.getMeta("json_migration_done"), "2");
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("deleteFileById clears the path lookup too", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-idx-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    db.upsertFile("p1", rec());
    db.deleteFileById("p1", "f_1");
    assert.equal(db.getFileById("p1", "f_1"), undefined);
    assert.equal(db.getFileByPath("p1", "Dir/a.txt"), undefined);
    assert.equal(db.countFiles("p1"), 0);
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});
