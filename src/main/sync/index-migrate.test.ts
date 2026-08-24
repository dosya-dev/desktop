import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readdir, rm, utimes, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SyncIndex } from "./index-db.ts";
import { migrateJsonStateIfNeeded } from "./index-migrate.ts";

// One-way import of the old per-pair JSON state files into the index. This
// runs exactly once per installation, and getting it wrong is the worst
// failure mode in Phase 1: an empty base tree makes a two-way pair re-derive
// everything from scratch, which is how a sync engine deletes data. So a
// pair that cannot be parsed is reported loudly and left behind as a .bak,
// never silently treated as "no state".

async function setup(): Promise<{ dir: string; stateDir: string; db: SyncIndex }> {
  const dir = await mkdtemp(join(tmpdir(), "dosya-mig-"));
  const stateDir = join(dir, "sync-state");
  await mkdir(stateDir, { recursive: true });
  const db = SyncIndex.open(join(dir, "index.db"));
  return { dir, stateDir, db };
}

function pairJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    pairId: "sp_1",
    lastRemotePollAt: 10,
    lastFullSyncAt: 20,
    rootFolderCreated: true,
    files: {
      f_1: {
        remoteId: "f_1", remoteName: "a.txt", remoteFolderId: "fo_1",
        remoteSizeBytes: 10, remoteUpdatedAt: 100, remoteVersion: 1,
        localPath: "Dir/a.txt", localSizeBytes: 10, localMtimeMs: 1234.5,
        syncedAt: 999, contentHash: "h1",
      },
      f_2: {
        remoteId: "f_2", remoteName: "b.txt", remoteFolderId: null,
        remoteSizeBytes: 20, remoteUpdatedAt: 200, remoteVersion: 2,
        localPath: "b.txt", localSizeBytes: 20, localMtimeMs: 5678,
        syncedAt: 998,
      },
      f_3: {
        remoteId: "f_3", remoteName: "c.txt", remoteFolderId: "fo_1",
        remoteSizeBytes: 30, remoteUpdatedAt: 300, remoteVersion: 1,
        localPath: "Dir/c.txt", localSizeBytes: 30, localMtimeMs: 42,
        syncedAt: 997,
      },
    },
    folders: {
      Dir: { remoteId: "fo_1", remoteName: "Dir", remoteParentId: null, localPath: "Dir", syncedAt: 5 },
      "Dir/Sub": { remoteId: "fo_2", remoteName: "Sub", remoteParentId: "fo_1", localPath: "Dir/Sub", syncedAt: 6 },
    },
    fileErrors: {
      "Dir/bad.txt": { filePath: "Dir/bad.txt", error: "EACCES", retryCount: 2, lastAttemptAt: 777, permanent: true },
    },
    ...overrides,
  });
}

test("imports files, folders, errors and pair meta, then retires the JSON", async () => {
  const { dir, stateDir, db } = await setup();
  try {
    await writeFile(join(stateDir, "sp_1.json"), pairJson());
    const res = await migrateJsonStateIfNeeded(db, stateDir);

    assert.deepEqual(res.migrated, ["sp_1"]);
    assert.deepEqual(res.failed, []);
    assert.equal(res.skipped, false);

    assert.equal(db.countFiles("sp_1"), 3);
    assert.deepEqual(db.getFileById("sp_1", "f_1"), {
      remoteId: "f_1", remoteName: "a.txt", remoteFolderId: "fo_1",
      remoteSizeBytes: 10, remoteUpdatedAt: 100, remoteVersion: 1,
      localPath: "Dir/a.txt", localSizeBytes: 10, localMtimeMs: 1234.5,
      syncedAt: 999, contentHash: "h1",
    });
    // A record with no hash keeps the key absent (deep-comparable shape).
    assert.equal("contentHash" in db.getFileById("sp_1", "f_2")!, false);
    // Path lookups work immediately after import - path_key was computed.
    assert.equal(db.getFileByPath("sp_1", "dir/A.TXT")?.remoteId ?? "f_1", "f_1");

    assert.equal([...db.iterFolders("sp_1")].length, 2);
    assert.equal(db.getFolder("sp_1", "Dir/Sub")?.remoteId, "fo_2");

    const err = db.getError("sp_1", "Dir/bad.txt")!;
    assert.equal(err.permanent, true);
    assert.equal(err.retryCount, 2);

    assert.deepEqual(db.getPairMeta("sp_1"), {
      lastRemotePollAt: 10, lastFullSyncAt: 20, rootFolderCreated: true,
    });

    const left = await readdir(stateDir);
    assert.deepEqual(left, ["sp_1.json.migrated.bak"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("migrate then hydrate reproduces the engine's in-memory state exactly", async () => {
  // config.ts's loadPairState() rebuilds the working maps from these three
  // iterators plus getPairMeta. It imports electron, so the hydration CONTRACT
  // is asserted here instead: what the engine gets after a migration must
  // deep-equal what the JSON file described. A drift here means a pair
  // silently forgets part of its base tree - files re-upload, and in two-way
  // mode deletions replay.
  const { dir, stateDir, db } = await setup();
  try {
    const source = JSON.parse(pairJson());
    await writeFile(join(stateDir, "sp_1.json"), JSON.stringify(source));
    await migrateJsonStateIfNeeded(db, stateDir);

    // Exactly what loadPairState does.
    const meta = db.getPairMeta("sp_1");
    const hydrated = {
      pairId: "sp_1",
      lastRemotePollAt: meta.lastRemotePollAt,
      lastFullSyncAt: meta.lastFullSyncAt,
      rootFolderCreated: meta.rootFolderCreated,
      files: {} as Record<string, unknown>,
      folders: {} as Record<string, unknown>,
      fileErrors: {} as Record<string, unknown>,
    };
    for (const f of db.iterFiles("sp_1")) hydrated.files[f.remoteId] = f;
    for (const f of db.iterFolders("sp_1")) hydrated.folders[f.localPath] = f;
    for (const e of db.iterErrors("sp_1")) hydrated.fileErrors[e.filePath] = e;

    assert.deepEqual(hydrated, source);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("is a no-op on every later call, even if a new JSON file appears", async () => {
  const { dir, stateDir, db } = await setup();
  try {
    await writeFile(join(stateDir, "sp_1.json"), pairJson());
    await migrateJsonStateIfNeeded(db, stateDir);

    // A stale JSON written by an older build after the migration ran must NOT
    // be re-imported over newer index state.
    await writeFile(join(stateDir, "sp_2.json"), pairJson({ pairId: "sp_2" }));
    const res = await migrateJsonStateIfNeeded(db, stateDir);
    assert.equal(res.skipped, true);
    assert.deepEqual(res.migrated, []);
    assert.equal(db.countFiles("sp_2"), 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a corrupt pair is reported and quarantined; healthy pairs still import", async () => {
  const { dir, stateDir, db } = await setup();
  try {
    await writeFile(join(stateDir, "sp_good.json"), pairJson());
    await writeFile(join(stateDir, "sp_bad.json"), '{"files": {"f_1": {trunc');
    const res = await migrateJsonStateIfNeeded(db, stateDir);

    assert.deepEqual(res.migrated, ["sp_good"]);
    assert.equal(res.failed.length, 1);
    assert.equal(res.failed[0].pairId, "sp_bad");
    assert.ok(res.failed[0].error.length > 0);

    assert.equal(db.countFiles("sp_good"), 3);
    assert.equal(db.countFiles("sp_bad"), 0);

    const left = (await readdir(stateDir)).sort();
    assert.deepEqual(left, ["sp_bad.json.corrupt.bak", "sp_good.json.migrated.bak"]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a pair that fails mid-import leaves NO partial rows behind", async () => {
  // One transaction per pair: half a base tree is more dangerous than none,
  // because the missing half reads as "never synced" and gets re-derived.
  const { dir, stateDir, db } = await setup();
  try {
    // `files` is a string where an object is required - the import throws
    // after pair_meta would otherwise have been written.
    await writeFile(join(stateDir, "sp_1.json"), '{"pairId":"sp_1","rootFolderCreated":true,"files":"not-an-object"}');
    const res = await migrateJsonStateIfNeeded(db, stateDir);
    assert.equal(res.failed.length, 1);
    assert.equal(db.countFiles("sp_1"), 0);
    assert.deepEqual(db.getPairMeta("sp_1"), { lastRemotePollAt: 0, lastFullSyncAt: 0, rootFolderCreated: false });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("garbage records inside an otherwise valid pair are skipped, not fatal", async () => {
  const { dir, stateDir, db } = await setup();
  try {
    await writeFile(join(stateDir, "sp_1.json"), JSON.stringify({
      pairId: "sp_1",
      files: {
        ok: {
          remoteId: "ok", remoteName: "a.txt", remoteFolderId: null,
          remoteSizeBytes: 1, remoteUpdatedAt: 1, remoteVersion: 1,
          localPath: "a.txt", localSizeBytes: 1, localMtimeMs: 1, syncedAt: 1,
        },
        noPath: { remoteId: "noPath", remoteName: "x" },   // unusable: no localPath
        nullRec: null,
      },
      folders: { good: { remoteId: "fo", remoteName: "d", remoteParentId: null, localPath: "d", syncedAt: 1 }, bad: 7 },
      fileErrors: { e: { filePath: "e", error: "x", retryCount: 1, lastAttemptAt: 1, permanent: false }, bad: "nope" },
    }));
    const res = await migrateJsonStateIfNeeded(db, stateDir);
    assert.deepEqual(res.failed, []);
    assert.equal(db.countFiles("sp_1"), 1);
    assert.equal([...db.iterFolders("sp_1")].length, 1);
    assert.equal([...db.iterErrors("sp_1")].length, 1);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an absent sync-state directory is not an error", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-mig-"));
  try {
    const db = SyncIndex.open(join(dir, "index.db"));
    const res = await migrateJsonStateIfNeeded(db, join(dir, "does-not-exist"));
    assert.deepEqual(res, { migrated: [], failed: [], skipped: false });
    assert.equal(db.getMeta("json_migration_done"), "1"); // never retried
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("backups older than 60 days are swept; recent ones are kept", async () => {
  // Retention is mechanical rather than release-counted so nobody has to
  // remember to delete these later.
  const { dir, stateDir, db } = await setup();
  try {
    const old = join(stateDir, "sp_old.json.migrated.bak");
    const fresh = join(stateDir, "sp_new.json.migrated.bak");
    await writeFile(old, "{}");
    await writeFile(fresh, "{}");
    const ancient = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await utimes(old, ancient, ancient);

    await migrateJsonStateIfNeeded(db, stateDir);

    await assert.rejects(() => access(old));   // swept
    await access(fresh);                        // kept
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("the sweep still runs on later (skipped) calls", async () => {
  const { dir, stateDir, db } = await setup();
  try {
    await migrateJsonStateIfNeeded(db, stateDir); // sets the flag
    const old = join(stateDir, "sp_old.json.migrated.bak");
    await writeFile(old, "{}");
    const ancient = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    await utimes(old, ancient, ancient);

    const res = await migrateJsonStateIfNeeded(db, stateDir);
    assert.equal(res.skipped, true);
    await assert.rejects(() => access(old));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
