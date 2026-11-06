import { test } from "node:test";
import assert from "node:assert/strict";
import { findCaseCollisions } from "./case-collisions.ts";

const files = [
  { remoteId: "a", relPath: "Docs/Report.txt" },
  { remoteId: "b", relPath: "Docs/report.txt" },
  { remoteId: "c", relPath: "Docs/other.txt" },
  { remoteId: "d", relPath: "docs/OTHER.txt" },
  { remoteId: "e", relPath: "unique.txt" },
];

test("groups paths that differ only by case when the filesystem folds case", () => {
  const groups = findCaseCollisions(files, true);
  assert.deepEqual([...groups.keys()].sort(), ["docs/other.txt", "docs/report.txt"]);
  assert.deepEqual(groups.get("docs/report.txt")!.map((f) => f.remoteId), ["a", "b"]);
});

test("no collision on case-sensitive platforms", () => {
  assert.equal(findCaseCollisions(files, false).size, 0);
});

test("NFD and NFC spellings of the same name collide on every platform", () => {
  const nfd = "Café.txt";
  const nfc = "Café.txt";
  const groups = findCaseCollisions([{ remoteId: "x", relPath: nfd }, { remoteId: "y", relPath: nfc }], false);
  assert.equal(groups.size, 1);
});
