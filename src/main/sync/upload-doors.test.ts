import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildUploadInitBody,
  buildChunksCommitBody,
  buildCommitEntry,
  collectEntryVersionConflicts,
  expectedVersionFor,
  shouldSendVersionGuard,
  versionConflictFrom,
  VersionConflictError,
} from "./upload-metadata.ts";

// Fix round 1, F1: the version guard only covered /api/upload/init, but most
// bytes never go through that door - tryDeltaUpload reaches
// /api/sync/chunks/commit first, and the bulk push path commits through
// /api/sync/commit. A guard that only covers the door least used is not a
// guard. F4: a keep-local resolution (and a last-write-wins pair, which has
// already decided local wins) must send NO guard, or the retry 409s forever.
//
// The real RemoteClient cannot be loaded here (it reaches electron through
// config.ts), so this drives the same body builders the client uses through a
// fake transport and records what each door actually sent.

/** Records every request the doors make, the way a proxy would see them. */
class FakeTransport {
  calls: { path: string; body: Record<string, unknown> }[] = [];
  reply: (path: string) => { status: number; body: any } = () => ({ status: 200, body: { ok: true } });
  post(path: string, body: Record<string, unknown>): { status: number; body: any } {
    this.calls.push({ path, body });
    return this.reply(path);
  }
  bodyFor(path: string): Record<string, unknown> {
    const call = this.calls.find((c) => c.path === path);
    assert.ok(call, `no request to ${path}`);
    return call!.body;
  }
}

/**
 * Sends one upload through every door, exactly as remote-client builds them:
 * the guard is decided ONCE from the base record (expectedVersionFor) and
 * then travels with whichever door the file happens to take.
 */
function sendThroughEveryDoor(t: FakeTransport, baseVersion: number | null, fileId: string | null) {
  const expectedVersion = expectedVersionFor({ baseVersion, isUpdate: fileId !== null, sendGuard: true });
  t.post("/api/upload/init", buildUploadInitBody({
    workspaceId: "ws1", fileName: "a.txt", fileSize: 10, mimeType: "text/plain",
    folderId: "fo1", region: "auto", fileId, expectedVersion,
  }));
  t.post("/api/sync/chunks/commit", buildChunksCommitBody({
    workspaceId: "ws1", region: "auto", fileId, folderId: "fo1", name: "a.txt",
    size: 10, contentType: "application/octet-stream", ext: "txt",
    chunks: [{ hash: "h1", size: 10 }], expectedVersion,
  }));
  t.post("/api/sync/commit", {
    workspace_id: "ws1", region: "auto",
    files: [buildCommitEntry({
      // The bulk path always has a server-assigned id; "update" is decided by
      // whether the base record points at THIS id, which is what the guard says.
      fileId: fileId ?? "f_new", r2Key: "k", name: "a.txt", size: 10, folderId: "fo1",
      contentType: "text/plain", ext: "txt", sourceModifiedAt: 1_725_000_000, expectedVersion,
    })],
  });
}

const DOORS = ["/api/upload/init", "/api/sync/chunks/commit", "/api/sync/commit"];

test("an UPDATE carries expected_version through every upload door", () => {
  const t = new FakeTransport();
  sendThroughEveryDoor(t, 4, "f1");
  assert.deepEqual(t.calls.map((c) => c.path), DOORS);
  assert.equal(t.bodyFor("/api/upload/init").expected_version, 4);
  assert.equal(t.bodyFor("/api/sync/chunks/commit").expected_version, 4);
  const entry = (t.bodyFor("/api/sync/commit").files as Record<string, unknown>[])[0];
  assert.equal(entry.expected_version, 4);
  assert.equal(entry.source_modified_at, 1_725_000_000);
});

test("a CREATE carries no expected_version at any door", () => {
  const t = new FakeTransport();
  sendThroughEveryDoor(t, 4, null); // no file id: this is a new file
  for (const path of DOORS) {
    const body = t.bodyFor(path);
    const target = path === "/api/sync/commit" ? (body.files as Record<string, unknown>[])[0] : body;
    assert.equal("expected_version" in target, false, path);
  }
});

test("an update whose base version is unknown sends no guard either", () => {
  const t = new FakeTransport();
  sendThroughEveryDoor(t, null, "f1");
  for (const path of DOORS) {
    const body = t.bodyFor(path);
    const target = path === "/api/sync/commit" ? (body.files as Record<string, unknown>[])[0] : body;
    assert.equal("expected_version" in target, false, path);
  }
});

test("every door recognises a 409 version_conflict the same way", () => {
  for (const path of DOORS) {
    const t = new FakeTransport();
    t.reply = () => ({ status: 409, body: { error: "version_conflict", current_version: 9 } });
    const res = t.post(path, {});
    const conflict = versionConflictFrom(res.status, res.body);
    assert.ok(conflict instanceof VersionConflictError, path);
    assert.equal(conflict!.currentVersion, 9, path);
  }
});

test("a per-entry version_conflict in a bulk commit response is collected by file id", () => {
  const conflicts = collectEntryVersionConflicts([
    { file_id: "f1", ok: false, error: "version_conflict", current_version: 7 },
    { file_id: "f2", ok: false, error: "A file with this name already exists" },
    { id: "f3", ok: false, error: "version_conflict" },
    { file_id: "f4", ok: true },
  ]);
  assert.deepEqual([...conflicts.entries()].sort(), [["f1", 7], ["f3", null]]);
});

test("expectedVersionFor: only an update of a file we have a version for", () => {
  assert.equal(expectedVersionFor({ baseVersion: 4, isUpdate: true, sendGuard: true }), 4);
  assert.equal(expectedVersionFor({ baseVersion: 4, isUpdate: false, sendGuard: true }), null);
  assert.equal(expectedVersionFor({ baseVersion: undefined, isUpdate: true, sendGuard: true }), null);
  assert.equal(expectedVersionFor({ baseVersion: 0, isUpdate: true, sendGuard: true }), null);
  assert.equal(expectedVersionFor({ baseVersion: 4, isUpdate: true, sendGuard: false }), null);
});

test("keep-local resolution sends no guard - it is the user overruling the server", () => {
  // The old code re-uploaded with the SAME stale expected_version, so the
  // server 409'd again and "keep local" could never resolve anything.
  assert.equal(shouldSendVersionGuard({ conflictStrategy: "keep-both", reason: "keep-local" }), false);
  assert.equal(shouldSendVersionGuard({ conflictStrategy: "last-write-wins", reason: "keep-local" }), false);
});

test("a last-write-wins pair sends no guard - it has already decided local wins", () => {
  assert.equal(shouldSendVersionGuard({ conflictStrategy: "last-write-wins", reason: "sync" }), false);
  assert.equal(shouldSendVersionGuard({ conflictStrategy: "keep-both", reason: "sync" }), true);
  // The default when a pair predates the setting is keep-both (ipc-handlers).
  assert.equal(shouldSendVersionGuard({ conflictStrategy: undefined, reason: "sync" }), true);
});

// ── Wave 2 follow-up: the delta door keeps the file's own date ───────
// /api/sync/chunks/commit now stores the client's modification time (body
// `source_modified_at` in unix seconds wins over the X-Dosya-Source-Mtime
// header). It was the last door still dropping it, so a block-level version
// bump stored NULL and the file read as "modified today" everywhere.

test("a chunks-commit body carries the source mtime for an update", () => {
  const t = new FakeTransport();
  t.post("/api/sync/chunks/commit", buildChunksCommitBody({
    workspaceId: "ws1", region: "auto", fileId: "f1", folderId: "fo1", name: "a.txt",
    size: 10, contentType: "application/octet-stream", ext: "txt",
    chunks: [{ hash: "h1", size: 10 }], expectedVersion: 4,
    sourceModifiedAt: 1_725_000_000,
  }));
  const body = t.bodyFor("/api/sync/chunks/commit");
  assert.equal(body.source_modified_at, 1_725_000_000);
  assert.equal(body.expected_version, 4); // still guarded, unchanged
});

test("a chunks-commit body carries the source mtime for a create too - the date is the file's, not the update's", () => {
  const t = new FakeTransport();
  t.post("/api/sync/chunks/commit", buildChunksCommitBody({
    workspaceId: "ws1", region: "auto", fileId: null, folderId: "fo1", name: "a.txt",
    size: 10, contentType: "application/octet-stream", ext: "txt",
    chunks: [{ hash: "h1", size: 10 }], expectedVersion: null,
    sourceModifiedAt: 1_725_000_000,
  }));
  const body = t.bodyFor("/api/sync/chunks/commit");
  assert.equal(body.source_modified_at, 1_725_000_000);
  assert.equal("expected_version" in body, false);
});

test("an unknown or implausible mtime is omitted rather than sent as null", () => {
  for (const value of [null, undefined, 0, -1]) {
    const body = buildChunksCommitBody({
      workspaceId: "ws1", region: "auto", fileId: "f1", folderId: null, name: "a.txt",
      size: 10, contentType: "application/octet-stream", ext: "txt",
      chunks: [{ hash: "h1", size: 10 }],
      sourceModifiedAt: value as number | null | undefined,
    });
    assert.equal("source_modified_at" in body, false, String(value));
  }
});
