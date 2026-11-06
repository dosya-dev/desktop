import { test } from "node:test";
import assert from "node:assert/strict";
import { baselineFor, baselineFromStat, localMatchesRecord, LocalChangedDuringDownloadError, updateMayReplace } from "./download-guard.ts";

const record = { localSizeBytes: 10, localMtimeMs: 1234.5 };

test("a file with the record's size and mtime matches", () => {
  assert.equal(localMatchesRecord({ size: 10, mtimeMs: 1234.5 }, record), true);
});

test("a different mtime means the user edited the file after the scan", () => {
  assert.equal(localMatchesRecord({ size: 10, mtimeMs: 9999 }, record), false);
});

test("a different size means the file changed", () => {
  assert.equal(localMatchesRecord({ size: 11, mtimeMs: 1234.5 }, record), false);
});

test("a file that is gone does not match (the plan assumed it was there)", () => {
  assert.equal(localMatchesRecord(null, record), false);
});

test("legacy record compares size only", () => {
  // Rows written before mtimes were recorded carry localMtimeMs 0. The
  // simulator (sim-fs.ts localMatchesBase) treats them as size-only; the
  // real guard must agree or every legacy download-update would be refused.
  assert.equal(localMatchesRecord({ size: 10, mtimeMs: 777 }, { localSizeBytes: 10, localMtimeMs: 0 }), true);
  assert.equal(localMatchesRecord({ size: 11, mtimeMs: 777 }, { localSizeBytes: 10, localMtimeMs: 0 }), false);
});

test("the error names the path so the engine can raise a conflict for it", () => {
  const err = new LocalChangedDuringDownloadError("Docs/a.txt");
  assert.equal(err.relPath, "Docs/a.txt");
  assert.match(err.message, /changed on this device/);
});

test("updateMayReplace: a path the user deleted is safe to fill (renaming onto nothing destroys no bytes)", () => {
  assert.equal(updateMayReplace(null, record), true);
});

test("updateMayReplace: an unchanged file may be replaced, a changed one may not", () => {
  assert.equal(updateMayReplace({ size: 10, mtimeMs: 1234.5 }, record), true);
  assert.equal(updateMayReplace({ size: 10, mtimeMs: 9999 }, record), false);
});

test("baselineFor: the scan-time view wins over the base record", () => {
  const existingRecord = { localSizeBytes: 10, localMtimeMs: 1234.5 };
  assert.deepEqual(
    baselineFor({ existingRecord, expectedLocal: { sizeBytes: 44, mtimeMs: 5678 } }),
    { localSizeBytes: 44, localMtimeMs: 5678 },
  );
  assert.deepEqual(baselineFor({ existingRecord }), existingRecord);
});

test("baselineFor: a stat taken at decision time maps to a baseline", () => {
  assert.deepEqual(baselineFromStat({ size: 3, mtimeMs: 9 }), { localSizeBytes: 3, localMtimeMs: 9 });
});
