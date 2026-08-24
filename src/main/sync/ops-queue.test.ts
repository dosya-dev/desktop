import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SyncIndex } from "./index-db.ts";
import type { SyncFileRecord } from "./types.ts";

// Work stops being a transient array and becomes rows. That is what makes a
// kill mid-sync resumable: the 2026-08-20 stress test lost three hours of
// decided work every time the app died, because the queue only ever existed
// in RAM.

async function withDb(fn: (db: SyncIndex) => void | Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dosya-ops-"));
  const db = SyncIndex.open(join(dir, "index.db"));
  try {
    await fn(db);
  } finally {
    db.close();
    await rm(dir, { recursive: true, force: true });
  }
}

function record(overrides: Partial<SyncFileRecord> = {}): SyncFileRecord {
  return {
    remoteId: "f_1", remoteName: "a", remoteFolderId: null, remoteSizeBytes: 1,
    remoteUpdatedAt: 1, remoteVersion: 1, localPath: "a", localSizeBytes: 1,
    localMtimeMs: 1, syncedAt: 1, ...overrides,
  };
}

test("ops come back in the order they were enqueued", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [
      { kind: "upload-new", payload: { relPath: "a" } },
      { kind: "upload-new", payload: { relPath: "b" } },
      { kind: "upload-new", payload: { relPath: "c" } },
    ], 1);
    const popped = db.popPendingOps("p1", 2, 2);
    assert.deepEqual(popped.map((o) => (o.payload as any).relPath), ["a", "b"]);
    assert.deepEqual(db.popPendingOps("p1", 5, 3).map((o) => (o.payload as any).relPath), ["c"]);
  });
});

test("popping marks ops running so a second consumer cannot take them", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "upload-new", payload: { relPath: "a" } }], 1);
    assert.equal(db.popPendingOps("p1", 10, 2).length, 1);
    assert.equal(db.popPendingOps("p1", 10, 3).length, 0);
    assert.equal(db.countOpsByState("p1", "running"), 1);
  });
});

test("completion and its index mutation are ONE transaction (I2)", async () => {
  // An op may only be marked done if the state change it represents actually
  // landed. If the mutation throws, neither is written - otherwise the engine
  // would believe a file was uploaded that never was.
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "upload-new", payload: { relPath: "a" } }], 1);
    const [op] = db.popPendingOps("p1", 1, 2);
    assert.throws(() => db.completeOp(op.id, 3, () => {
      db.upsertFile("p1", record());
      throw new Error("commit failed");
    }), /commit failed/);
    assert.equal(db.countFiles("p1"), 0);
    assert.equal(db.countOpsByState("p1", "done"), 0);
    assert.equal(db.countOpsByState("p1", "running"), 1);
  });
});

test("a successful completion writes both the mutation and the done state", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "upload-new", payload: { relPath: "a" } }], 1);
    const [op] = db.popPendingOps("p1", 1, 2);
    db.completeOp(op.id, 3, () => db.upsertFile("p1", record()));
    assert.equal(db.countFiles("p1"), 1);
    assert.equal(db.countOpsByState("p1", "done"), 1);
  });
});

test("completeOp works without a mutation", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "create-remote-folder", payload: { relPath: "d" } }], 1);
    const [op] = db.popPendingOps("p1", 1, 2);
    db.completeOp(op.id, 3);
    assert.equal(db.countOpsByState("p1", "done"), 1);
  });
});

test("a transient failure returns the op to the queue and counts the attempt", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "upload-new", payload: { relPath: "a" } }], 1);
    const [op] = db.popPendingOps("p1", 1, 2);
    db.failOp(op.id, 3, false);
    const again = db.popPendingOps("p1", 1, 4);
    assert.equal(again.length, 1);
    assert.equal(again[0].attempts, 1);
  });
});

test("a permanent failure stays out of the queue", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "upload-new", payload: { relPath: "a" } }], 1);
    const [op] = db.popPendingOps("p1", 1, 2);
    db.failOp(op.id, 3, true);
    assert.equal(db.popPendingOps("p1", 1, 4).length, 0);
    assert.equal(db.countOpsByState("p1", "failed"), 1);
  });
});

test("resetRunningOps re-queues work a crash left in flight", async () => {
  // This is precisely what turns a SIGKILL mid-sync into a resume instead of
  // a full rescan of the tree.
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "a", payload: {} }, { kind: "b", payload: {} }], 1);
    db.popPendingOps("p1", 2, 2);
    assert.equal(db.resetRunningOps("p1", 3), 2);
    assert.equal(db.countOpsByState("p1", "pending"), 2);
    assert.equal(db.countOpsByState("p1", "running"), 0);
  });
});

test("done ops are swept by age; pending and failed are never swept", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [
      { kind: "a", payload: {} }, { kind: "b", payload: {} }, { kind: "c", payload: {} },
    ], 1);
    const [a, b] = db.popPendingOps("p1", 2, 2);
    db.completeOp(a.id, 1_000);
    db.failOp(b.id, 1_000, true);
    assert.equal(db.sweepDoneOps(5_000), 1);
    assert.equal(db.countOpsByState("p1", "done"), 0);
    assert.equal(db.countOpsByState("p1", "failed"), 1);
    assert.equal(db.countOpsByState("p1", "pending"), 1);
  });
});

test("pairs are isolated and deletePair takes their ops with them", async () => {
  await withDb((db) => {
    db.enqueueOps("p1", [{ kind: "a", payload: {} }], 1);
    db.enqueueOps("p2", [{ kind: "a", payload: {} }], 1);
    db.deletePair("p1");
    assert.equal(db.countOpsByState("p1", "pending"), 0);
    assert.equal(db.countOpsByState("p2", "pending"), 1);
  });
});

test("the queue survives a close and reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-ops-"));
  try {
    const path = join(dir, "index.db");
    let db = SyncIndex.open(path);
    db.enqueueOps("p1", [{ kind: "upload-new", payload: { relPath: "a" } }], 1);
    db.popPendingOps("p1", 1, 2); // left "running", as a crash would
    db.close();

    db = SyncIndex.open(path);
    assert.equal(db.resetRunningOps("p1", 3), 1);
    const [op] = db.popPendingOps("p1", 1, 4);
    assert.equal((op.payload as any).relPath, "a");
    db.close();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("popping 100 ops from a 20K-row queue is an index walk, not a scan", async () => {
  await withDb((db) => {
    const many = Array.from({ length: 20_000 }, (_, i) => ({ kind: "upload-new", payload: { i } }));
    db.transaction(() => db.enqueueOps("p1", many, 1));
    const started = process.hrtime.bigint();
    const popped = db.popPendingOps("p1", 100, 2);
    const ms = Number(process.hrtime.bigint() - started) / 1e6;
    assert.equal(popped.length, 100);
    assert.ok(ms < 50, `pop took ${ms.toFixed(1)}ms - ops_pending is not being used`);
  });
});
