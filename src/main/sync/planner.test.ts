import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, filterOpsForMode, type BaseView, type LocalView, type PlanInputs, type PlanOp, type RemoteView } from "./planner.ts";
import type { SyncFileRecord, SyncFolderRecord, SyncMode } from "./types.ts";

// One test per row of the decision table. These pin the semantics the old
// reconciler had, so the extraction into a pure planner cannot quietly change
// what sync DOES - only where the decision lives.

function baseRecord(o: Partial<SyncFileRecord> = {}): SyncFileRecord {
  return {
    remoteId: "f_1", remoteName: "a.txt", remoteFolderId: null,
    remoteSizeBytes: 10, remoteUpdatedAt: 100, remoteVersion: 1,
    localPath: "a.txt", localSizeBytes: 10, localMtimeMs: 1000,
    syncedAt: 1, ...o,
  };
}

function makeBase(files: SyncFileRecord[] = [], folders: SyncFolderRecord[] = []): BaseView {
  const byPath = new Map(files.map((f) => [f.localPath, f]));
  const byId = new Map(files.map((f) => [f.remoteId, f]));
  const folderByPath = new Map(folders.map((f) => [f.localPath, f]));
  return {
    fileByPath: (k) => byPath.get(k),
    fileById: (id) => byId.get(id),
    files: () => files,
    folderByPath: (k) => folderByPath.get(k),
    folders: () => folders,
  };
}

function makeLocal(files: { relPath: string; sizeBytes: number; mtimeMs: number }[] = [], folders: string[] = []): LocalView {
  return { files: new Map(files.map((f) => [f.relPath, f])), folders: new Set(folders) };
}

function makeRemote(
  files: { remoteId: string; relPath: string; name?: string; folderId?: string | null; sizeBytes: number; updatedAt: number; version: number }[] = [],
  folders: { remoteId: string; relPath: string }[] = [],
): RemoteView {
  const full = files.map((f) => ({
    remoteId: f.remoteId, relPath: f.relPath, name: f.name ?? f.relPath.split("/").pop()!,
    folderId: f.folderId ?? null, sizeBytes: f.sizeBytes, updatedAt: f.updatedAt, version: f.version,
  }));
  return {
    filesByPath: new Map(full.map((f) => [f.relPath, f])),
    filesById: new Map(full.map((f) => [f.remoteId, f])),
    foldersByPath: new Map(folders.map((f) => [f.relPath, { remoteId: f.remoteId, relPath: f.relPath, name: f.relPath.split("/").pop()!, parentId: null }])),
  };
}

function run(over: Partial<PlanInputs>): PlanOp[] {
  return plan({
    local: makeLocal(), remote: makeRemote(), base: makeBase(),
    conflictStrategy: "keep-both", ...over,
  });
}

const kinds = (ops: PlanOp[]) => ops.map((o) => o.kind).sort();

// ── Three-way cases ─────────────────────────────────────────────────

test("remote only, never seen before, downloads", () => {
  const ops = run({ remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 10, updatedAt: 100, version: 1 }]) });
  assert.deepEqual(ops, [{ kind: "download-new", relPath: "a.txt", remoteId: "f_1", sizeBytes: 10 }]);
});

test("local only, never seen before, uploads", () => {
  const ops = run({ local: makeLocal([{ relPath: "a.txt", sizeBytes: 10, mtimeMs: 5 }]) });
  assert.deepEqual(ops, [{ kind: "upload-new", relPath: "a.txt", sizeBytes: 10 }]);
});

test("deleted locally, server copy untouched, deletes on the server", () => {
  const ops = run({
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 10, updatedAt: 100, version: 1 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(ops, [{ kind: "delete-remote", remoteId: "f_1", relPath: "a.txt" }]);
});

test("deleted locally BUT the server copy moved on: re-download instead of deleting", () => {
  // The remote edit is newer information than the local deletion. Deleting
  // here would destroy a change the user never saw.
  const ops = run({
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 99, updatedAt: 500, version: 2 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(kinds(ops), ["download-new"]);
});

test("deleted on the server, local copy untouched, deletes locally", () => {
  const ops = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 10, mtimeMs: 1000 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(ops, [{ kind: "delete-local", relPath: "a.txt", baseRemoteId: "f_1" }]);
});

test("deleted on the server BUT edited locally: re-upload, never delete (I1)", () => {
  const ops = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 44, mtimeMs: 9999 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(kinds(ops), ["upload-new"]);
});

test("a locally-edited file whose whole remote folder vanished raises a conflict, not an upload", () => {
  // Folder + file both gone from the snapshot is what withdrawn access looks
  // like; re-uploading would recreate the file outside whatever removed it.
  const ops = run({
    local: makeLocal([{ relPath: "Dir/a.txt", sizeBytes: 44, mtimeMs: 9999 }], ["Dir"]),
    base: makeBase([baseRecord({ localPath: "Dir/a.txt" })], [{ remoteId: "fo_1", remoteName: "Dir", remoteParentId: null, localPath: "Dir", syncedAt: 1 }]),
  });
  assert.equal(ops.filter((o) => o.kind === "conflict").length, 1);
  assert.equal(ops.some((o) => o.kind === "upload-new"), false);
});

test("a file renamed on the server is moved locally, not re-downloaded", () => {
  const ops = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 10, mtimeMs: 1000 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "b.txt", sizeBytes: 10, updatedAt: 100, version: 1 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(ops, [{ kind: "move-local", fromRelPath: "a.txt", toRelPath: "b.txt", remoteId: "f_1" }]);
});

test("the same path on both sides with NO shared history is reconciled, not ignored", () => {
  // Regression, found by the property harness at seed 3. The old reconciler
  // had no case for (remote, no base record, local): it emitted nothing, so
  // the two copies stayed different forever while sync reported success. It
  // happens on independent creation of the same path, and after anything that
  // loses the base tree - a failed state migration, a reinstall.
  const both = {
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 4, mtimeMs: 5_000 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 9, updatedAt: 900, version: 3 }]),
    base: makeBase(),
  };

  // keep-both refuses to choose for the user, and says so.
  const kept = run({ ...both, conflictStrategy: "keep-both" });
  assert.deepEqual(kinds(kept), ["conflict"]);

  // last-write-wins takes the newer side - here the server (900s > 5s).
  const lww = run({ ...both, conflictStrategy: "last-write-wins" });
  assert.deepEqual(kinds(lww), ["download-update"]);

  // ...and the local side when it is the newer one.
  const localNewer = run({
    ...both,
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 4, mtimeMs: 2_000_000 }]),
    conflictStrategy: "last-write-wins",
  });
  assert.deepEqual(kinds(localNewer), ["upload-update"]);
});

test("unchanged on both sides plans nothing (I3)", () => {
  const ops = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 10, mtimeMs: 1000 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 10, updatedAt: 100, version: 1 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(ops, []);
});

test("changed on the server only downloads; changed locally only uploads", () => {
  const remoteEdit = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 10, mtimeMs: 1000 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 20, updatedAt: 300, version: 2 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(kinds(remoteEdit), ["download-update"]);

  const localEdit = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 33, mtimeMs: 7777 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 10, updatedAt: 100, version: 1 }]),
    base: makeBase([baseRecord()]),
  });
  assert.deepEqual(kinds(localEdit), ["upload-update"]);
});

test("changed on BOTH sides conflicts under keep-both (I4)", () => {
  const ops = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 33, mtimeMs: 7777 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 20, updatedAt: 300, version: 2 }]),
    base: makeBase([baseRecord()]),
    conflictStrategy: "keep-both",
  });
  assert.equal(ops.length, 1);
  assert.equal(ops[0].kind, "conflict");
});

test("changed on BOTH sides picks the newer side under last-write-wins", () => {
  const remoteNewer = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 33, mtimeMs: 1_000 }]),      // 1 second
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 20, updatedAt: 500, version: 2 }]), // 500 s
    base: makeBase([baseRecord()]),
    conflictStrategy: "last-write-wins",
  });
  assert.deepEqual(kinds(remoteNewer), ["download-update"]);

  const localNewer = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 33, mtimeMs: 900_000 }]),    // 900 s
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 20, updatedAt: 500, version: 2 }]),
    base: makeBase([baseRecord()]),
    conflictStrategy: "last-write-wins",
  });
  assert.deepEqual(kinds(localNewer), ["upload-update"]);
});

test("the reinstall sentinel (mtime 0, size matches) is adopted, not re-uploaded", () => {
  const ops = run({
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 10, mtimeMs: 424242 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 10, updatedAt: 100, version: 1 }]),
    base: makeBase([baseRecord({ localMtimeMs: 0 })]),
  });
  assert.deepEqual(ops, []);
});

test("an incomplete local scan suppresses every deletion (I1)", () => {
  const ops = run({
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 10, updatedAt: 100, version: 1 }]),
    base: makeBase([baseRecord()]),
    localScanIncomplete: true,
  });
  assert.deepEqual(ops, []);
});

test("folders are created on whichever side lacks them", () => {
  const ops = run({
    local: makeLocal([], ["OnlyLocal"]),
    remote: makeRemote([], [{ remoteId: "fo_9", relPath: "OnlyRemote" }]),
  });
  assert.deepEqual(kinds(ops), ["create-local-folder", "create-remote-folder"]);
});

// ── Push-only (no remote snapshot) ──────────────────────────────────

test("push-only: new uploads, size change uploads, mtime-only defers to a content check", () => {
  const ops = run({
    remote: null,
    local: makeLocal([
      { relPath: "new.txt", sizeBytes: 5, mtimeMs: 1 },
      { relPath: "resized.txt", sizeBytes: 99, mtimeMs: 1000 },
      { relPath: "touched.txt", sizeBytes: 10, mtimeMs: 8888 },
      { relPath: "same.txt", sizeBytes: 10, mtimeMs: 1000 },
    ]),
    base: makeBase([
      baseRecord({ remoteId: "f_r", localPath: "resized.txt" }),
      baseRecord({ remoteId: "f_t", localPath: "touched.txt" }),
      baseRecord({ remoteId: "f_s", localPath: "same.txt" }),
    ]),
  });
  assert.deepEqual(kinds(ops), ["check-content", "upload-new", "upload-update"]);
  const check = ops.find((o) => o.kind === "check-content")!;
  assert.equal(check.relPath, "touched.txt");
});

test("push-only still PLANS remote deletions so the mode filter stays testable (I5)", () => {
  const ops = run({ remote: null, base: makeBase([baseRecord()]) });
  assert.deepEqual(ops, [{ kind: "delete-remote", remoteId: "f_1", relPath: "a.txt" }]);
  assert.deepEqual(filterOpsForMode(ops, "push-safe"), []);
  assert.deepEqual(filterOpsForMode(ops, "push"), ops);
});

// ── Rename detection (push path) ────────────────────────────────────

test("a renamed file moves on the server instead of re-uploading", () => {
  // The whole point: renaming a 2 GB file should cost nothing.
  const ops = run({
    remote: null,
    local: makeLocal([{ relPath: "new.bin", sizeBytes: 10, mtimeMs: 99, contentHash: "H" } as any]),
    base: makeBase([baseRecord({ remoteId: "f_1", localPath: "old.bin", localSizeBytes: 10, contentHash: "H" })]),
  });
  assert.deepEqual(ops, [{ kind: "move-remote", fromRelPath: "old.bin", toRelPath: "new.bin", remoteId: "f_1" }]);
});

test("a moved file is NOT also deleted from the server", () => {
  // With a complete local view the base row looks missing, and without the
  // move bookkeeping it would be deleted right after being moved.
  const ops = run({
    remote: null,
    local: makeLocal([{ relPath: "new.bin", sizeBytes: 10, mtimeMs: 99, contentHash: "H" } as any]),
    base: makeBase([baseRecord({ remoteId: "f_1", localPath: "old.bin", localSizeBytes: 10, contentHash: "H" })]),
    localScanIncomplete: false,
  });
  assert.equal(ops.some((o) => o.kind === "delete-remote"), false);
});

test("a COPY is not a move: the original still exists locally", () => {
  const ops = run({
    remote: null,
    local: makeLocal([
      { relPath: "old.bin", sizeBytes: 10, mtimeMs: 1000, contentHash: "H" } as any,
      { relPath: "copy.bin", sizeBytes: 10, mtimeMs: 99, contentHash: "H" } as any,
    ]),
    base: makeBase([baseRecord({ remoteId: "f_1", localPath: "old.bin", localSizeBytes: 10, contentHash: "H" })]),
  });
  assert.deepEqual(kinds(ops), ["upload-new"]);
});

test("a record with no stored hash never matches, so NULL is not a wildcard", () => {
  const ops = run({
    remote: null,
    local: makeLocal([{ relPath: "new.bin", sizeBytes: 10, mtimeMs: 99, contentHash: "H" } as any]),
    base: makeBase([baseRecord({ remoteId: "f_1", localPath: "old.bin", localSizeBytes: 10, contentHash: undefined })]),
    localScanIncomplete: true,
  });
  assert.deepEqual(kinds(ops), ["upload-new"]);
});

test("size must match too - the same hash at a different size is not a move", () => {
  const ops = run({
    remote: null,
    local: makeLocal([{ relPath: "new.bin", sizeBytes: 999, mtimeMs: 99, contentHash: "H" } as any]),
    base: makeBase([baseRecord({ remoteId: "f_1", localPath: "old.bin", localSizeBytes: 10, contentHash: "H" })]),
    localScanIncomplete: true,
  });
  assert.deepEqual(kinds(ops), ["upload-new"]);
});

test("two identical files matching one missing record: one moves, the other uploads", () => {
  // Pairing inside an identical-content group is a tiebreak, not a decision -
  // either way both paths end up on the server with the right bytes.
  const ops = run({
    remote: null,
    local: makeLocal([
      { relPath: "b.bin", sizeBytes: 10, mtimeMs: 99, contentHash: "H" } as any,
      { relPath: "c.bin", sizeBytes: 10, mtimeMs: 99, contentHash: "H" } as any,
    ]),
    base: makeBase([baseRecord({ remoteId: "f_1", localPath: "a.bin", localSizeBytes: 10, contentHash: "H" })]),
    localScanIncomplete: true,
  });
  assert.deepEqual(kinds(ops), ["move-remote", "upload-new"]);
  assert.equal(ops.filter((o) => o.kind === "move-remote").length, 1);
});

test("without a supplied hash nothing is treated as a move", () => {
  // The engine only hashes rename CANDIDATES; everything else arrives with no
  // hash and must behave exactly as it did before this feature existed.
  const ops = run({
    remote: null,
    local: makeLocal([{ relPath: "new.bin", sizeBytes: 10, mtimeMs: 99 }]),
    base: makeBase([baseRecord({ remoteId: "f_1", localPath: "old.bin", localSizeBytes: 10, contentHash: "H" })]),
    localScanIncomplete: true,
  });
  assert.deepEqual(kinds(ops), ["upload-new"]);
});

test("move-remote is an upload-side op: present in push modes, absent from pull", () => {
  const ops: PlanOp[] = [{ kind: "move-remote", fromRelPath: "a", toRelPath: "b", remoteId: "f" }];
  assert.deepEqual(kinds(filterOpsForMode(ops, "push-safe")), ["move-remote"]);
  assert.deepEqual(kinds(filterOpsForMode(ops, "push")), ["move-remote"]);
  assert.deepEqual(kinds(filterOpsForMode(ops, "two-way")), ["move-remote"]);
  assert.deepEqual(filterOpsForMode(ops, "pull"), []);
  assert.deepEqual(filterOpsForMode(ops, "pull-safe"), []);
});

// ── Mode filters (spec table 1.4) ───────────────────────────────────

test("every mode filters exactly the table's rows", () => {
  const all: PlanOp[] = [
    { kind: "create-remote-folder", relPath: "d" },
    { kind: "create-local-folder", relPath: "d", remoteFolderId: "fo" },
    { kind: "upload-new", relPath: "a", sizeBytes: 1 },
    { kind: "upload-update", relPath: "b", sizeBytes: 1, baseRemoteId: "f" },
    { kind: "check-content", relPath: "c", sizeBytes: 1, baseRemoteId: "f" },
    { kind: "download-new", relPath: "e", remoteId: "f", sizeBytes: 1 },
    { kind: "download-update", relPath: "g", remoteId: "f", sizeBytes: 1 },
    { kind: "delete-remote", remoteId: "f", relPath: "h" },
    { kind: "delete-local", relPath: "i", baseRemoteId: "f" },
    { kind: "move-local", fromRelPath: "j", toRelPath: "k", remoteId: "f" },
    { kind: "conflict", relPath: "l", remoteId: "f", localMtimeMs: 1, localSizeBytes: 1, remoteUpdatedAt: 1, remoteSizeBytes: 1, remoteName: "l" },
  ];
  const expected: Record<SyncMode, string[]> = {
    "two-way": all.map((o) => o.kind).sort(),
    push: ["check-content", "conflict", "create-remote-folder", "delete-remote", "upload-new", "upload-update"],
    "push-safe": ["check-content", "conflict", "create-remote-folder", "upload-new", "upload-update"],
    pull: ["conflict", "create-local-folder", "delete-local", "download-new", "download-update", "move-local"],
    "pull-safe": ["conflict", "create-local-folder", "download-new", "download-update", "move-local"],
  };
  for (const mode of Object.keys(expected) as SyncMode[]) {
    assert.deepEqual(kinds(filterOpsForMode(all, mode)), expected[mode], mode);
  }
});

test("push-safe can never delete or download; pull-safe can never upload or delete locally (I5)", () => {
  const all: PlanOp[] = [
    { kind: "delete-remote", remoteId: "f", relPath: "h" },
    { kind: "delete-local", relPath: "i", baseRemoteId: "f" },
    { kind: "download-new", relPath: "e", remoteId: "f", sizeBytes: 1 },
    { kind: "upload-new", relPath: "a", sizeBytes: 1 },
  ];
  const pushSafe = filterOpsForMode(all, "push-safe").map((o) => o.kind);
  assert.deepEqual(pushSafe, ["upload-new"]);
  const pullSafe = filterOpsForMode(all, "pull-safe").map((o) => o.kind);
  assert.deepEqual(pullSafe, ["download-new"]);
});

// ── Determinism (P4 precondition) ───────────────────────────────────

test("planning twice over the same inputs returns identical ops", () => {
  const inputs: PlanInputs = {
    local: makeLocal([{ relPath: "a.txt", sizeBytes: 33, mtimeMs: 7777 }, { relPath: "n.txt", sizeBytes: 1, mtimeMs: 2 }]),
    remote: makeRemote([{ remoteId: "f_1", relPath: "a.txt", sizeBytes: 20, updatedAt: 300, version: 2 }]),
    base: makeBase([baseRecord()]),
    conflictStrategy: "keep-both",
  };
  assert.deepEqual(plan(inputs), plan(inputs));
});
