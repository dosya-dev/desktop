import { test } from "node:test";
import assert from "node:assert/strict";
import { plan, filterOpsForMode, type BaseView, type LocalView, type PlanOp, type RemoteView } from "./planner.ts";
import type { SyncFileRecord } from "./types.ts";
import { SimWorld } from "./sim-fs.ts";

// The very first sync of a pair whose remote folder is not empty.
//
// Reported 2026-09-17: create a Full Sync pair where either side already holds
// files and the first pass raises a conflict on each one; under keep-both the
// engine resolves it itself and RENAMES the user's file to a conflict copy.
//
// Root cause: `prePopulateStateFromRemote` (index.ts) seeds a base row for
// every file in the remote snapshot, with the localMtimeMs=0 sentinel, BEFORE
// anything has been downloaded. A base row means "both sides agreed on this at
// the last successful sync", so the very next plan reads those rows as tracked
// files that have gone missing from disk, and plans delete-remote for each.
// The deletion guard then withholds them and the reconciler turns withheld
// deletions into conflicts, which keep-both resolves by renaming.
//
// The conflict is the visible half. The dangerous half is when the guard does
// NOT fire: it needs `storedCount > 10 && deleteCount > 5 && deleteCount >
// storedCount * 0.5` (deletion-guard.ts), so a user who already had most of
// the folder on disk falls under the threshold and the deletes go through
// against their cloud copy.

function seededRow(o: Partial<SyncFileRecord> = {}): SyncFileRecord {
  // Exactly what prePopulateStateFromRemote writes: remote facts, the local
  // size assumed equal to the remote one, and mtime 0 meaning "never seen".
  return {
    remoteId: "f_1", remoteName: "QA checklist.pdf", remoteFolderId: null,
    remoteSizeBytes: 120, remoteUpdatedAt: 900, remoteVersion: 1,
    localPath: "QA checklist.pdf", localSizeBytes: 120, localMtimeMs: 0,
    syncedAt: 1, ...o,
  };
}

function viewsFor(rows: SyncFileRecord[], localPaths: Map<string, { sizeBytes: number; mtimeMs: number }>) {
  const byPath = new Map(rows.map((r) => [r.localPath, r]));
  const byId = new Map(rows.map((r) => [r.remoteId, r]));
  const base: BaseView = {
    fileByPath: (k) => byPath.get(k),
    fileById: (id) => byId.get(id),
    files: () => rows,
    folderByPath: () => undefined,
    folders: () => [],
  };
  const local: LocalView = {
    files: new Map([...localPaths].map(([p, f]) => [p, { relPath: p, ...f }])),
    folders: new Set<string>(),
  };
  const remoteFiles = rows.map((r) => ({
    remoteId: r.remoteId, relPath: r.localPath, name: r.remoteName, folderId: null,
    sizeBytes: r.remoteSizeBytes, updatedAt: r.remoteUpdatedAt, version: r.remoteVersion,
  }));
  const remote: RemoteView = {
    filesByPath: new Map(remoteFiles.map((r) => [r.relPath, r])),
    filesById: new Map(remoteFiles.map((r) => [r.remoteId, r])),
    foldersByPath: new Map(),
  };
  return { base, local, remote };
}

test("a file adopted from the server but never downloaded is fetched, not deleted from the server", () => {
  const { base, local, remote } = viewsFor([seededRow()], new Map());

  const ops = plan({ local, remote, base, conflictStrategy: "keep-both" });

  assert.deepEqual(ops, [
    { kind: "download-new", relPath: "QA checklist.pdf", remoteId: "f_1", sizeBytes: 120 },
  ]);
});

test("adoption rows below the deletion guard's threshold are still never deleted", () => {
  // The guard needs deleteCount > 5 AND more than half the tracked files
  // missing. Twelve adopted files with ten already on disk clears neither
  // bar, so nothing stands between a delete-remote and the user's cloud copy
  // except the planner getting this right.
  const rows: SyncFileRecord[] = [];
  const localPaths = new Map<string, { sizeBytes: number; mtimeMs: number }>();
  for (let i = 0; i < 12; i++) {
    const relPath = `file-${i}.txt`;
    rows.push(seededRow({ remoteId: `f_${i}`, remoteName: relPath, localPath: relPath }));
    if (i < 10) localPaths.set(relPath, { sizeBytes: 120, mtimeMs: 7_000 });
  }
  const { base, local, remote } = viewsFor(rows, localPaths);

  const ops = plan({ local, remote, base, conflictStrategy: "keep-both" });

  assert.deepEqual(ops.filter((o) => o.kind === "delete-remote"), []);
  assert.deepEqual(
    ops.map((o) => o.kind).sort(),
    ["download-new", "download-new"],
  );
});

test("a real local deletion of a downloaded file still deletes on the server", () => {
  // The fix must not blunt the actual delete path: a row with a real mtime is
  // a file this pair genuinely had on disk, so its absence IS a deletion.
  const { base, local, remote } = viewsFor([seededRow({ localMtimeMs: 7_000 })], new Map());

  const ops = plan({ local, remote, base, conflictStrategy: "keep-both" });

  assert.deepEqual(ops, [
    { kind: "delete-remote", remoteId: "f_1", relPath: "QA checklist.pdf" },
  ]);
});

// ── Whole-cycle regressions, through the simulator ──────────────────
//
// These run every round to a fixed point rather than one plan() call, because
// the reported symptom was about what the SECOND round sees after the first
// one transferred. They passed before the fix above and must keep passing.

function syncToFixedPoint(world: SimWorld, maxRounds = 12): { rounds: number; lastOps: PlanOp[] } {
  let rounds = 0;
  let lastOps: PlanOp[] = [];
  for (; rounds < maxRounds; rounds++) {
    const views = world.views();
    const ops = filterOpsForMode(
      plan({ local: views.local, remote: views.remote, base: views.base, conflictStrategy: world.strategy }),
      "two-way",
    );
    lastOps = ops;
    if (ops.length === 0 || ops.every((o) => o.kind === "conflict")) break;
    world.executeOps(ops);
  }
  return { rounds, lastOps };
}

test("a pre-existing local file syncs on the first pass without raising a conflict", () => {
  const world = new SimWorld("keep-both");
  world.local.set("Landing v3.png", { content: "PNG-BYTES", mtimeMs: 5_000 });

  const { lastOps } = syncToFixedPoint(world);

  assert.deepEqual(world.conflicts, [], "the first sync of an existing file must not conflict");
  assert.deepEqual(lastOps, [], "sync must reach a fixed point");
  assert.deepEqual(
    [...world.localSnapshot().entries()].sort(),
    [...world.remoteSnapshot().entries()].sort(),
  );
});

test("a pre-existing remote file syncs on the first pass without raising a conflict", () => {
  const world = new SimWorld("keep-both");
  world.remote.set("r_1", {
    remoteId: "r_1", relPath: "QA checklist.pdf", content: "PDF-BYTES", updatedAt: 900, version: 1,
  });

  const { lastOps } = syncToFixedPoint(world);

  assert.deepEqual(world.conflicts, [], "the first sync of a cloud-only file must not conflict");
  assert.deepEqual(lastOps, [], "sync must reach a fixed point");
  assert.deepEqual(
    [...world.localSnapshot().entries()].sort(),
    [...world.remoteSnapshot().entries()].sort(),
  );
});
