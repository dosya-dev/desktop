import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildRemotePaths,
  placeUnknownParents,
  unknownParentError,
  UNKNOWN_PARENT_MESSAGE,
} from "./remote-paths.ts";
import type { RemoteFileInfo, RemoteFolderInfo, SyncFileRecord } from "./types.ts";

// Field report 2026-09-02 (desktop #1): a remote file whose folder_id was not
// in the snapshot's folder map fell back to the sync ROOT (reconciler.ts:197,
// index.ts:2945, index.ts:3803). A delta poll that drops a folder tombstone
// before its files, or a folder the caller cannot see yet, therefore
// downloaded the file to the wrong place - and could then read as a move or a
// spurious delete on the next cycle. Unknown parents are now left OUT of the
// plan and reported, so the file waits until the folder is known.

function file(o: Partial<RemoteFileInfo> = {}): RemoteFileInfo {
  return {
    id: "f_1", name: "a.txt", size_bytes: 10, mime_type: "text/plain", extension: "txt",
    region: "auto", folder_id: null, updated_at: 100, current_version: 1, ...o,
  };
}
function folder(o: Partial<RemoteFolderInfo> = {}): RemoteFolderInfo {
  return { id: "fo_1", name: "Dir", parent_id: null, file_count: 0, ...o };
}
function base(o: Partial<SyncFileRecord> = {}): SyncFileRecord {
  return {
    remoteId: "f_1", remoteName: "a.txt", remoteFolderId: "fo_missing", remoteSizeBytes: 10,
    remoteUpdatedAt: 100, remoteVersion: 1, localPath: "Dir/a.txt", localSizeBytes: 10,
    localMtimeMs: 1, syncedAt: 1, ...o,
  };
}

test("files under known folders resolve to their full relative path; root files to their name", () => {
  const out = buildRemotePaths(
    new Map([["f_1", file({ folder_id: "fo_1" })], ["f_2", file({ id: "f_2", name: "root.txt" })]]),
    new Map([["fo_1", folder()]]),
    null,
  );
  assert.equal(out.filePathMap.get("f_1"), "Dir/a.txt");
  assert.equal(out.filePathMap.get("f_2"), "root.txt");
  assert.deepEqual(out.unknownParent, []);
});

test("a file whose folder_id is absent from the folder map is omitted, never placed at the root", () => {
  const out = buildRemotePaths(
    new Map([["f_1", file({ folder_id: "fo_missing" })]]),
    new Map([["fo_1", folder()]]),
    null,
  );
  assert.equal(out.filePathMap.has("f_1"), false);
  assert.equal(out.unknownParent.length, 1);
  assert.equal(out.unknownParent[0].id, "f_1");
});

test("a folder whose own parent is unknown is omitted too, along with its subtree", () => {
  // The old builder resolved an unknown parent chain to "" and then filed the
  // folder at the root - the same flattening, one level up.
  const out = buildRemotePaths(
    new Map([["f_1", file({ folder_id: "fo_child" })]]),
    new Map([["fo_child", folder({ id: "fo_child", name: "Child", parent_id: "fo_gone" })]]),
    null,
  );
  assert.equal(out.folderPathMap.has("fo_child"), false);
  assert.deepEqual(out.unknownFolders, ["fo_child"]);
  assert.equal(out.filePathMap.has("f_1"), false);
  assert.equal(out.unknownParent[0].id, "f_1");
});

test("a cyclic parent chain is treated as unknown rather than recursing or flattening", () => {
  const out = buildRemotePaths(
    new Map(),
    new Map([
      ["a", folder({ id: "a", name: "A", parent_id: "b" })],
      ["b", folder({ id: "b", name: "B", parent_id: "a" })],
    ]),
    null,
  );
  assert.equal(out.folderPathMap.size, 0);
  assert.deepEqual([...out.unknownFolders].sort(), ["a", "b"]);
});

test("the next cycle, with the folder present, resolves the same file to the right path", () => {
  const files = new Map([["f_1", file({ folder_id: "fo_1" })]]);
  const first = buildRemotePaths(files, new Map(), null);
  assert.equal(first.filePathMap.has("f_1"), false);
  const second = buildRemotePaths(files, new Map([["fo_1", folder()]]), null);
  assert.equal(second.filePathMap.get("f_1"), "Dir/a.txt");
  assert.deepEqual(second.unknownParent, []);
});

test("names pass through the caller's normalizer (NFC for the reconciler)", () => {
  const nfd = "Döcs"; // "Döcs" decomposed, as macOS reports it
  const out = buildRemotePaths(
    new Map([["f_1", file({ folder_id: "fo_1", name: nfd })]]),
    new Map([["fo_1", folder({ name: nfd })]]),
    null,
    (s) => s.normalize("NFC"),
  );
  assert.equal(out.filePathMap.get("f_1"), "Döcs/Döcs");
});

test("an unknown-parent file WITH a base record keeps its last known path (no phantom delete)", () => {
  // Leaving it out of the remote view entirely would make the planner read
  // "gone from the server" and delete the local copy. Its content may still
  // be compared and updated in place; only its position is unknown.
  const { placed, unresolved } = placeUnknownParents(
    [file({ folder_id: "fo_missing" }), file({ id: "f_new", folder_id: "fo_missing" })],
    (id) => (id === "f_1" ? base() : undefined),
  );
  assert.deepEqual([...placed], [["f_1", "Dir/a.txt"]]);
  assert.equal(unresolved.length, 1);
  assert.equal(unresolved[0].id, "f_new");
});

test("an unresolved file becomes a non-permanent, retryable error the UI can show", () => {
  const err = unknownParentError(file({ id: "f_new", name: "photo.jpg", folder_id: "fo_missing" }), 1234);
  assert.equal(err.error, UNKNOWN_PARENT_MESSAGE);
  assert.equal(UNKNOWN_PARENT_MESSAGE, "parent folder not yet known; will retry");
  assert.equal(err.permanent, false);
  assert.equal(err.retryCount, 0);
  assert.equal(err.lastAttemptAt, 1234);
  // Keyed so it can never overwrite the ledger row of a real root-level file
  // that happens to share the name.
  assert.notEqual(err.filePath, "photo.jpg");
  assert.ok(err.filePath.endsWith("photo.jpg"));
});

// ── Fix round 1, F2 ─────────────────────────────────────────────────
// placeUnknownParents was fed `(id) => storedState.files[id]`, and
// loadPairState (config.ts) returns `files: {}` - the base tree lives in
// SQLite. So the lookup answered "never synced" for every file, the placement
// branch was dead, and a synced file whose folder vanished from a snapshot
// went straight back to being planned as a deletion. The lookup is now a
// REQUIRED argument, so no caller can leave it out.

import { plan, type BaseView, type LocalView, type RemoteView } from "./planner.ts";
import { resolveRemotePaths } from "./remote-paths.ts";

test("a synced file whose folder is missing keeps its path and is NOT planned as delete-local", () => {
  const files = new Map([["f_1", file({ folder_id: "fo_gone", name: "a.txt" })]]);
  const stored = base({ remoteId: "f_1", localPath: "Dir/a.txt", remoteFolderId: "fo_gone" });

  // The index-backed lookup the engine passes (SQLite, not storedState.files).
  const resolved = resolveRemotePaths({
    files, folders: new Map(), rootFolderId: null,
    baseById: (id) => (id === "f_1" ? stored : undefined),
  });
  assert.equal(resolved.filePathMap.get("f_1"), "Dir/a.txt");
  assert.deepEqual(resolved.unresolved, []);

  // Fed to the planner, that placement is what keeps the local copy alive.
  const remote: RemoteView = {
    filesByPath: new Map([["Dir/a.txt", { remoteId: "f_1", relPath: "Dir/a.txt", name: "a.txt", folderId: "fo_gone", sizeBytes: 10, updatedAt: 100, version: 1 }]]),
    filesById: new Map([["f_1", { remoteId: "f_1", relPath: "Dir/a.txt", name: "a.txt", folderId: "fo_gone", sizeBytes: 10, updatedAt: 100, version: 1 }]]),
    foldersByPath: new Map(),
  };
  const local: LocalView = { files: new Map([["Dir/a.txt", { relPath: "Dir/a.txt", sizeBytes: 10, mtimeMs: 1 }]]), folders: new Set(["Dir"]) };
  const baseView: BaseView = {
    fileByPath: (k) => (k === "Dir/a.txt" ? stored : undefined),
    fileById: (id) => (id === "f_1" ? stored : undefined),
    files: () => [stored],
    folderByPath: () => undefined,
    folders: () => [],
  };
  const ops = plan({ local, remote, base: baseView, conflictStrategy: "keep-both" });
  assert.equal(ops.some((o) => o.kind === "delete-local"), false, JSON.stringify(ops));

  // Proof the placement is what does it: with an EMPTY base lookup - what the
  // reconciler actually passed - the same file is planned for deletion.
  const empty = resolveRemotePaths({ files, folders: new Map(), rootFolderId: null, baseById: () => undefined });
  assert.equal(empty.filePathMap.has("f_1"), false);
  const opsWithout = plan({
    local, base: baseView, conflictStrategy: "keep-both",
    remote: { filesByPath: new Map(), filesById: new Map(), foldersByPath: new Map() },
  });
  assert.equal(opsWithout.some((o) => o.kind === "delete-local"), true);
});

test("resolveRemotePaths reports only the files it could not place", () => {
  const stored = base({ remoteId: "f_1", localPath: "Dir/a.txt" });
  const out = resolveRemotePaths({
    files: new Map([
      ["f_1", file({ id: "f_1", folder_id: "fo_gone" })],
      ["f_2", file({ id: "f_2", name: "new.txt", folder_id: "fo_gone" })],
      ["f_3", file({ id: "f_3", name: "root.txt", folder_id: null })],
    ]),
    folders: new Map(), rootFolderId: null,
    baseById: (id) => (id === "f_1" ? stored : undefined),
  });
  assert.equal(out.filePathMap.get("f_1"), "Dir/a.txt");
  assert.equal(out.filePathMap.get("f_3"), "root.txt");
  assert.deepEqual(out.unresolved.map((f) => f.id), ["f_2"]);
});

test("unknown-parent error rows are keyed by folder id, so same-named files do not collapse", () => {
  // Two "photo.jpg" under two different unknown folders are two problems.
  const a = unknownParentError(file({ id: "f_a", name: "photo.jpg", folder_id: "fo_1" }), 1);
  const b = unknownParentError(file({ id: "f_b", name: "photo.jpg", folder_id: "fo_2" }), 1);
  assert.notEqual(a.filePath, b.filePath);
  assert.ok(a.filePath.includes("fo_1"));
  assert.ok(a.filePath.endsWith("photo.jpg"));
});

// ── Re-audit: the same rule, in the UPLOAD direction ─────────────────
// The download and snapshot paths stopped resolving an unknown parent to the
// sync root, but three upload-side sites still did - and those are the ones
// that WRITE to the user's cloud: every large file (uploadLargeFiles ->
// uploadLocalFile), every queued move-remote, and every watcher-detected
// move. A directory whose remote folder was never created therefore dumped
// its files at the pair root. Same rule, same answer: defer with a retryable
// error row, never place at the root.

import { readFileSync } from "node:fs";
import {
  resolveParentFolderId,
  missingParentError,
  MISSING_PARENT_MESSAGE,
} from "./remote-paths.ts";

/** The index lookup each call site passes, as a plain map. */
const folders = (known: Record<string, string>) => (relPath: string) => known[relPath];

test("a file at the sync root resolves to the pair root, which is not a fallback", () => {
  const out = resolveParentFolderId("a.txt", { rootFolderId: "fo_root", folderIdFor: folders({}) });
  assert.deepEqual(out, { known: true, folderId: "fo_root" });
  // A pair with no remote root folder yet is still a known answer: null.
  assert.deepEqual(
    resolveParentFolderId("a.txt", { rootFolderId: null, folderIdFor: folders({}) }),
    { known: true, folderId: null },
  );
});

test("a known parent resolves to that folder", () => {
  const out = resolveParentFolderId("Dir/Sub/a.txt", {
    rootFolderId: "fo_root",
    folderIdFor: folders({ "Dir/Sub": "fo_sub" }),
  });
  assert.deepEqual(out, { known: true, folderId: "fo_sub" });
});

test("site 1 - uploadLocalFile: an unknown parent defers the file instead of rooting it", () => {
  const out = resolveParentFolderId("Dir/Sub/big.iso", {
    rootFolderId: "fo_root",
    folderIdFor: folders({ Dir: "fo_dir" }), // "Dir/Sub" was never created
  });
  assert.deepEqual(out, { known: false, parentRelPath: "Dir/Sub" });
});

test("site 2 - queued move-remote: an unknown TARGET parent defers the move", () => {
  const out = resolveParentFolderId("New/Home/report.docx", {
    rootFolderId: "fo_root",
    folderIdFor: folders({}),
  });
  assert.deepEqual(out, { known: false, parentRelPath: "New/Home" });
});

test("site 3 - watcher move detection: an unknown new parent defers rather than moving to the root", () => {
  const out = resolveParentFolderId("Moved/Into/here.txt", {
    rootFolderId: "fo_root",
    folderIdFor: folders({ Moved: "fo_moved" }),
  });
  assert.deepEqual(out, { known: false, parentRelPath: "Moved/Into" });
});

test("the deferral is a retryable ledger row that names the folder and counts attempts", () => {
  const err = missingParentError("Dir/Sub/big.iso", "Dir/Sub", 5000);
  assert.equal(err.filePath, "Dir/Sub/big.iso");
  assert.equal(err.error, MISSING_PARENT_MESSAGE("Dir/Sub"));
  assert.match(err.error, /Dir\/Sub/);
  assert.equal(err.permanent, false);
  assert.equal(err.retryCount, 1);
  assert.equal(err.lastAttemptAt, 5000);
  // A repeat attempt advances the ladder rather than resetting it.
  assert.equal(missingParentError("Dir/Sub/big.iso", "Dir/Sub", 6000, err).retryCount, 2);
});

test("no upload path in the engine resolves an unknown parent to the pair root any more", () => {
  // A behavioural guard on the source itself: the engine cannot be loaded by
  // node --test (it imports electron), and this exact expression is what the
  // re-audit found still live at three sites. If it comes back, this fails.
  const engine = readFileSync(new URL("./index.ts", import.meta.url), "utf-8");
  const offenders = engine
    .split("\n")
    .map((line, i) => [i + 1, line] as const)
    .filter(([, line]) => /\?\?\s*(rt\.)?pair\.remoteFolderId/.test(line));
  assert.deepEqual(offenders, [], `sync-root fallback still present:\n${offenders.map(([n, l]) => `  index.ts:${n}: ${l.trim()}`).join("\n")}`);
});
