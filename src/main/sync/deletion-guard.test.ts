import { test } from "node:test";
import assert from "node:assert/strict";
import {
  exceedsDeletionThreshold,
  collectLocalDeletions,
  deletionDecision,
  removeLocalFile,
  trackedSnapshot,
  type LocalDeletionEvent,
} from "./deletion-guard.ts";

// Field report 2026-09-02 (desktop #2). Two gaps in an otherwise well-guarded
// engine: local deletes were a plain unlink (no OS trash, so a wrong delete
// was unrecoverable), and the watcher's unlink/unlinkDir fan-out in push and
// two-way mode batch-deleted the cloud copies with NO threshold - an
// unplugged external drive was a mass cloud soft-delete. The reconciler's
// valve (>5 and >50% of tracked files) is now shared, and a batch over it is
// HELD for the user instead of applied.

test("the deletion threshold is the reconciler's: more than 5 AND more than half of tracked, with a floor", () => {
  assert.equal(exceedsDeletionThreshold(12, 20), true);
  assert.equal(exceedsDeletionThreshold(3, 20), false);   // few
  assert.equal(exceedsDeletionThreshold(6, 20), false);   // >5 but not >50%
  assert.equal(exceedsDeletionThreshold(6, 8), false);    // tiny pair: below the floor of 10 tracked
  assert.equal(exceedsDeletionThreshold(11, 11), true);
  assert.equal(exceedsDeletionThreshold(0, 0), false);
});

test("a watcher batch's deletions are collected across unlink and unlinkDir, deduped, with the folders to drop", () => {
  const out = collectLocalDeletions(
    [
      { type: "unlink", relPath: "a.txt" },
      { type: "unlink", relPath: "ghost.txt" },      // never tracked - nothing to delete
      { type: "unlink", relPath: "Dir/x.txt" },      // also covered by the unlinkDir below
      { type: "unlinkDir", relPath: "Dir" },
    ],
    trackedSnapshot(
      [
        { remoteId: "f_a", localPath: "a.txt" },
        { remoteId: "f_x", localPath: "Dir/x.txt" },
        { remoteId: "f_y", localPath: "Dir/Sub/y.txt" },
        { remoteId: "f_z", localPath: "Other/z.txt" },
      ],
      ["Dir", "Dir/Sub", "Other"],
    ),
  );
  assert.deepEqual(out.files.map((f) => f.remoteId).sort(), ["f_a", "f_x", "f_y"]);
  assert.deepEqual(out.folders.sort(), ["Dir", "Dir/Sub"]);
});

test("a batch over the threshold is held for confirmation; a small one is applied", () => {
  assert.equal(deletionDecision(12, 20), "confirm");
  assert.equal(deletionDecision(3, 20), "apply");
  assert.equal(deletionDecision(0, 20), "apply");
});

test("delete-local goes to the OS trash first and only unlinks when trashing rejects", async () => {
  const calls: string[] = [];
  const trashOk = { trash: async (p: string) => { calls.push(`trash:${p}`); }, unlink: async (p: string) => { calls.push(`unlink:${p}`); } };
  assert.equal(await removeLocalFile("/u/Docs/a.txt", trashOk), "trashed");
  assert.deepEqual(calls, ["trash:/u/Docs/a.txt"]);

  calls.length = 0;
  const trashFails = {
    trash: async (p: string) => { calls.push(`trash:${p}`); throw new Error("no trash on this volume"); },
    unlink: async (p: string) => { calls.push(`unlink:${p}`); },
  };
  assert.equal(await removeLocalFile("/u/Docs/b.txt", trashFails), "unlinked");
  assert.deepEqual(calls, ["trash:/u/Docs/b.txt", "unlink:/u/Docs/b.txt"]);
});

test("a file that is already gone is reported as missing, not thrown", async () => {
  const enoent = Object.assign(new Error("gone"), { code: "ENOENT" });
  const io = { trash: async () => { throw enoent; }, unlink: async () => { throw enoent; } };
  assert.equal(await removeLocalFile("/u/Docs/c.txt", io), "missing");
});

test("an unlink failure other than ENOENT propagates so the caller can decide", async () => {
  const eperm = Object.assign(new Error("locked"), { code: "EPERM" });
  const io = { trash: async () => { throw new Error("no trash"); }, unlink: async () => { throw eperm; } };
  await assert.rejects(() => removeLocalFile("/u/Docs/d.txt", io), /locked/);
});

// ── Fix round 1, F3 ─────────────────────────────────────────────────
// The engine passed callbacks that each materialised the WHOLE index
// (`[...iterFiles(pairId)]`) per call, and collectLocalDeletions called
// foldersUnder twice per unlinkDir - so a batch of N events over M tracked
// files was O(N x M) index reads before a single delete was decided. One
// snapshot is now built per batch and searched.

test("one snapshot answers path, prefix and folder queries without re-reading the index", () => {
  const snap = trackedSnapshot(
    [
      { remoteId: "f_a", localPath: "a.txt" },
      { remoteId: "f_x", localPath: "Dir/x.txt" },
      { remoteId: "f_y", localPath: "Dir/Sub/y.txt" },
      { remoteId: "f_z", localPath: "Other/z.txt" },
      { remoteId: "f_d", localPath: "Dirty/keep.txt" }, // shares the "Dir" prefix but is NOT under it
    ],
    ["Dir", "Dir/Sub", "Other", "Dirty"],
  );
  assert.equal(snap.fileByPath("Dir/x.txt")?.remoteId, "f_x");
  assert.equal(snap.fileByPath("nope.txt"), undefined);
  assert.deepEqual(snap.filesUnder("Dir/").map((f) => f.remoteId).sort(), ["f_x", "f_y"]);
  assert.deepEqual(snap.foldersUnder("Dir/").sort(), ["Dir/Sub"]);
  assert.equal(snap.hasFolder("Dir"), true);
  assert.equal(snap.hasFolder("Nope"), false);
});

test("a few hundred events over a few thousand tracked files stays fast", () => {
  const files: { remoteId: string; localPath: string }[] = [];
  const folders: string[] = [];
  for (let d = 0; d < 200; d++) {
    folders.push(`d${d}`);
    for (let f = 0; f < 25; f++) files.push({ remoteId: `f_${d}_${f}`, localPath: `d${d}/file${f}.bin` });
  }
  assert.equal(files.length, 5000);

  const events: LocalDeletionEvent[] = [];
  for (let d = 0; d < 100; d++) events.push({ type: "unlinkDir", relPath: `d${d}` });
  for (let f = 0; f < 25; f++) events.push({ type: "unlink", relPath: `d150/file${f}.bin` });

  const started = Date.now();
  const snap = trackedSnapshot(files, folders);
  const out = collectLocalDeletions(events, snap);
  const elapsed = Date.now() - started;

  assert.equal(out.files.length, 100 * 25 + 25); // 100 whole folders plus one folder's files
  assert.deepEqual(out.folders.sort(), Array.from({ length: 100 }, (_, i) => `d${i}`).sort());
  assert.ok(elapsed < 500, `took ${elapsed}ms - the guard is scanning the whole index per event again`);
});

// ── Re-audit: a withheld deletion has to be visible ──────────────────
// The cloud-side case asks the user (needs-confirmation). The LOCAL-side case
// only ever wrote a console.warn, so a user whose deletions were withheld was
// never told anything at all.

import { deletionSuppressedNotice } from "./deletion-guard.ts";

test("a suppressed batch of deletions produces a notice that says what was NOT done", () => {
  const msg = deletionSuppressedNotice(12, "scan-incomplete");
  assert.match(msg, /12 file/);
  assert.match(msg, /not deleted|did not delete/i);
  assert.match(msg, /could not be read/i);
  assert.equal(msg.includes("—"), false); // no em dashes in user-facing copy
});

test("the two reasons read differently, because they mean different things", () => {
  const incomplete = deletionSuppressedNotice(12, "scan-incomplete");
  const threshold = deletionSuppressedNotice(12, "over-threshold");
  assert.notEqual(incomplete, threshold);
  assert.match(threshold, /unusually large|too many|safety/i);
  assert.match(threshold, /12 file/);
});

test("one file is singular", () => {
  assert.match(deletionSuppressedNotice(1, "over-threshold"), /1 file\b/);
});
