import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import {
  SOURCE_MTIME_HEADER,
  sourceMtimeSeconds,
  sourceMtimeHeaders,
  buildUploadInitBody,
  versionConflictFrom,
  VersionConflictError,
  isVersionConflict,
  applyDownloadedMtime,
} from "./upload-metadata.ts";

// Field report 2026-09-02 (desktop #3 and #9). Contract 1: an update upload
// tells the server which version it is overwriting, and a 409
// version_conflict becomes a conflict for the planner instead of an error.
// Contract 2: every upload carries the local file's mtime so the server can
// keep "Date modified" honest; downloads apply the server's source mtime so
// the same file is not "modified today" on every device it lands on.

test("the source mtime header is unix SECONDS (the web client's shape), floored", () => {
  assert.equal(sourceMtimeSeconds(1_725_000_000_999), 1_725_000_000);
  assert.equal(sourceMtimeSeconds(0), null);
  assert.equal(sourceMtimeSeconds(Number.NaN), null);
  assert.equal(sourceMtimeSeconds(-5), null);
  assert.deepEqual(sourceMtimeHeaders(1_725_000_000_999), { [SOURCE_MTIME_HEADER]: "1725000000" });
  assert.deepEqual(sourceMtimeHeaders(0), {});
  assert.equal(SOURCE_MTIME_HEADER, "X-Dosya-Source-Mtime");
});

test("an update upload sends expected_version equal to the base record's remote version", () => {
  const body = buildUploadInitBody({
    workspaceId: "ws1", fileName: "a.txt", fileSize: 10, mimeType: "text/plain",
    folderId: "fo1", region: "auto", fileId: "f1", expectedVersion: 4,
  });
  assert.equal(body.file_id, "f1");
  assert.equal(body.expected_version, 4);
});

test("a new upload (no file_id) never sends expected_version, and neither does an update without a known version", () => {
  const fresh = buildUploadInitBody({
    workspaceId: "ws1", fileName: "a.txt", fileSize: 10, mimeType: "text/plain",
    folderId: null, region: "auto", fileId: null, expectedVersion: 4,
  });
  assert.equal("file_id" in fresh, false);
  assert.equal("expected_version" in fresh, false);
  const unknown = buildUploadInitBody({
    workspaceId: "ws1", fileName: "a.txt", fileSize: 10, mimeType: "text/plain",
    folderId: null, region: "auto", fileId: "f1", expectedVersion: null,
  });
  assert.equal(unknown.file_id, "f1");
  assert.equal("expected_version" in unknown, false);
});

test("a 409 version_conflict is recognised, carrying the server's current version", () => {
  const err = versionConflictFrom(409, { error: "version_conflict", current_version: 7 });
  assert.ok(err instanceof VersionConflictError);
  assert.equal(err!.currentVersion, 7);
  assert.equal(isVersionConflict(err), true);
  // Other 409s and other errors are not version conflicts.
  assert.equal(versionConflictFrom(409, { error: "name_taken" }), null);
  assert.equal(versionConflictFrom(400, { error: "version_conflict" }), null);
  assert.equal(isVersionConflict(new Error("version_conflict")), false);
});

test("after a download, the file's mtime is set to the server's source_modified_at and the fresh stat is returned", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-mtime-"));
  try {
    const p = join(dir, "a.txt");
    await writeFile(p, "hello");
    const s = await applyDownloadedMtime(p, 1_600_000_000);
    assert.equal(Math.floor(s.mtimeMs / 1000), 1_600_000_000);
    assert.equal(Math.floor((await stat(p)).mtimeMs / 1000), 1_600_000_000);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("a remote row without source_modified_at leaves the download's mtime alone", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-mtime-"));
  try {
    const p = join(dir, "b.txt");
    await writeFile(p, "hello");
    await utimes(p, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    for (const v of [null, undefined, 0, -1, Number.NaN]) {
      const s = await applyDownloadedMtime(p, v as number | null | undefined);
      assert.equal(Math.floor(s.mtimeMs / 1000), 1_700_000_000, String(v));
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
