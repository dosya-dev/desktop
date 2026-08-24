import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SyncIndex, type FileBlock } from "./index-db.ts";
import type { SyncFileRecord } from "./types.ts";

// Chunk lists are what let an edit to a huge file cost only the changed
// chunks, and what lets a rename cost nothing at all. They live next to the
// file records so both questions - "which parts of this changed" and "do we
// already have this content somewhere" - are index lookups rather than walks.

async function withDb(fn: (db: SyncIndex) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dosya-blk-"));
  const db = SyncIndex.open(join(dir, "index.db"));
  try { await fn(db); } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
}

function blocks(n: number, prefix = "h"): FileBlock[] {
  return Array.from({ length: n }, (_, i) => ({ idx: i, offset: i * 1024, size: 1024, hash: `${prefix}${i}` }));
}

function record(o: Partial<SyncFileRecord> = {}): SyncFileRecord {
  return {
    remoteId: "f_1", remoteName: "a.bin", remoteFolderId: null, remoteSizeBytes: 4096,
    remoteUpdatedAt: 1, remoteVersion: 1, localPath: "a.bin", localSizeBytes: 4096,
    localMtimeMs: 1, syncedAt: 1, contentHash: "whole-1", ...o,
  };
}

test("a chunk list round-trips in index order", async () => {
  await withDb((db) => {
    db.setBlocks("p1", "f_1", blocks(4));
    assert.deepEqual(db.getBlocks("p1", "f_1"), blocks(4));
  });
});

test("setBlocks REPLACES the list rather than appending to it", async () => {
  // Re-chunking a file that shrank must not leave the old tail behind, or a
  // delta upload would reference chunks the file no longer has.
  await withDb((db) => {
    db.setBlocks("p1", "f_1", blocks(6, "old"));
    db.setBlocks("p1", "f_1", blocks(2, "new"));
    const back = db.getBlocks("p1", "f_1");
    assert.equal(back.length, 2);
    assert.deepEqual(back.map((b) => b.hash), ["new0", "new1"]);
  });
});

test("blocks are scoped per pair and per file", async () => {
  await withDb((db) => {
    db.setBlocks("p1", "f_1", blocks(2, "a"));
    db.setBlocks("p1", "f_2", blocks(3, "b"));
    db.setBlocks("p2", "f_1", blocks(4, "c"));
    assert.equal(db.getBlocks("p1", "f_1").length, 2);
    assert.equal(db.getBlocks("p1", "f_2").length, 3);
    assert.equal(db.getBlocks("p2", "f_1").length, 4);
    assert.equal(db.countBlocks("p1"), 5);
  });
});

test("an empty list clears the file's blocks", async () => {
  await withDb((db) => {
    db.setBlocks("p1", "f_1", blocks(3));
    db.setBlocks("p1", "f_1", []);
    assert.deepEqual(db.getBlocks("p1", "f_1"), []);
  });
});

test("deletePair takes the blocks with it", async () => {
  await withDb((db) => {
    db.setBlocks("p1", "f_1", blocks(3));
    db.setBlocks("p2", "f_1", blocks(3));
    db.deletePair("p1");
    assert.equal(db.countBlocks("p1"), 0);
    assert.equal(db.countBlocks("p2"), 3);
  });
});

test("content lookup needs BOTH the hash and the size to match", async () => {
  // Size is a cheap guard against a hash collision being taken as identity,
  // and it is the field the scanner already has for free.
  await withDb((db) => {
    db.upsertFile("p1", record({ remoteId: "f_1", localPath: "a.bin", contentHash: "SAME", localSizeBytes: 4096 }));
    db.upsertFile("p1", record({ remoteId: "f_2", localPath: "b.bin", contentHash: "SAME", localSizeBytes: 999 }));
    db.upsertFile("p1", record({ remoteId: "f_3", localPath: "c.bin", contentHash: "OTHER", localSizeBytes: 4096 }));

    const hits = db.findFilesByContentHash("p1", "SAME", 4096);
    assert.deepEqual(hits.map((h) => h.remoteId), ["f_1"]);
    assert.deepEqual(db.findFilesByContentHash("p1", "nope", 4096), []);
  });
});

test("a record with no content hash never matches", async () => {
  // Files synced before hashing was universal keep NULL hashes. NULL must not
  // be treated as "matches anything" - that would move unrelated files.
  await withDb((db) => {
    db.upsertFile("p1", record({ remoteId: "f_1", contentHash: undefined }));
    assert.deepEqual(db.findFilesByContentHash("p1", "whole-1", 4096), []);
  });
});

test("content lookup is pair-scoped", async () => {
  await withDb((db) => {
    db.upsertFile("p1", record({ remoteId: "f_1", contentHash: "SAME" }));
    db.upsertFile("p2", record({ remoteId: "f_9", contentHash: "SAME" }));
    assert.deepEqual(db.findFilesByContentHash("p1", "SAME", 4096).map((h) => h.remoteId), ["f_1"]);
  });
});

test("un-hashed files are findable so they can be backfilled", async () => {
  // Files synced before hashing was universal never re-upload, so without a
  // deliberate backfill they keep a NULL hash forever and can never take part
  // in dedup or rename detection.
  await withDb((db) => {
    db.upsertFile("p1", record({ remoteId: "f_1", localPath: "a", contentHash: undefined }));
    db.upsertFile("p1", record({ remoteId: "f_2", localPath: "b", contentHash: "have-one" }));
    db.upsertFile("p1", record({ remoteId: "f_3", localPath: "c", contentHash: undefined }));
    db.upsertFile("p2", record({ remoteId: "f_9", localPath: "z", contentHash: undefined }));

    assert.equal(db.countFilesWithoutHash("p1"), 2);
    assert.deepEqual(db.findFilesWithoutHash("p1", 10).map((r) => r.remoteId), ["f_1", "f_3"]);
    assert.equal(db.findFilesWithoutHash("p1", 1).length, 1);   // batched
    assert.equal(db.countFilesWithoutHash("p2"), 1);            // pair-scoped
  });
});

test("backfilling a hash removes the file from the un-hashed set", async () => {
  await withDb((db) => {
    db.upsertFile("p1", record({ remoteId: "f_1", contentHash: undefined }));
    const found = db.findFilesWithoutHash("p1", 10)[0];
    db.upsertFile("p1", { ...found, contentHash: "backfilled" });
    assert.equal(db.countFilesWithoutHash("p1"), 0);
    assert.deepEqual(db.findFilesByContentHash("p1", "backfilled", found.localSizeBytes).map((r) => r.remoteId), ["f_1"]);
  });
});

test("a 5,000-block file (a 5 GB file at 1 MB chunks) writes and reads back quickly", async () => {
  await withDb((db) => {
    const many = blocks(5_000);
    const started = process.hrtime.bigint();
    db.setBlocks("p1", "big", many);
    const read = db.getBlocks("p1", "big");
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(read.length, 5_000);
    assert.equal(read[4_999].hash, "h4999");
    assert.ok(ms < 2_000, `took ${ms.toFixed(0)}ms`);
  });
});
