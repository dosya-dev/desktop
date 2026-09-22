import { test } from "node:test";
import assert from "node:assert/strict";

import { buildDownloadUrl } from "./download-url.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * The bug this guards: the archive pane's "Download this file" button called
 * the same file:download IPC as every other download affordance, which only
 * ever fetched `/api/files/:id/download` - the whole zip - regardless of
 * which entry was selected. A button labelled "Download this file" handing
 * over the entire archive instead of the entry inside it is worse than no
 * button.
 */

const API = "https://api.dosya.dev";

test("an absent archive entry index builds the plain whole-file download URL", () => {
  assert.equal(buildDownloadUrl(API, { fileId: "f1" }), "https://api.dosya.dev/api/files/f1/download");
});

test("a version carries through to the whole-file download URL", () => {
  assert.equal(
    buildDownloadUrl(API, { fileId: "f1", version: 3 }),
    "https://api.dosya.dev/api/files/f1/download?version=3",
  );
});

test("a valid archive entry index builds the per-entry URL with dl=1", () => {
  assert.equal(
    buildDownloadUrl(API, { fileId: "f1", archiveEntryIndex: 4 }),
    "https://api.dosya.dev/api/files/f1/archive/entry?i=4&dl=1",
  );
});

// Regression target: a version alongside an entry index used to fall through
// to the whole-file branch if the check were `archiveEntryIndex ? ... : ...`
// instead of an explicit `!== undefined` - and index 0 is falsy, so that
// bug would have silently downloaded the whole archive for the very first
// entry in it.
//
// The version must survive into the entry URL rather than being dropped: an
// index only means something against ONE version of the zip, because a
// re-upload renumbers the central directory. Dropping it saved v3's entry N
// while the viewer was showing v1's.
test("an entry index and a version both survive, and index 0 is a real entry, not absent", () => {
  assert.equal(
    buildDownloadUrl(API, { fileId: "f1", version: 3, archiveEntryIndex: 0 }),
    "https://api.dosya.dev/api/files/f1/archive/entry?i=0&dl=1&version=3",
  );
});

test("an entry index with no version asks for the current one, with no stray parameter", () => {
  assert.equal(
    buildDownloadUrl(API, { fileId: "f1", archiveEntryIndex: 2 }),
    "https://api.dosya.dev/api/files/f1/archive/entry?i=2&dl=1",
  );
});

test("rejects a negative index", () => {
  assert.throws(() => buildDownloadUrl(API, { fileId: "f1", archiveEntryIndex: -1 }), /Invalid archive entry index/);
});

test("rejects a non-integer index", () => {
  assert.throws(() => buildDownloadUrl(API, { fileId: "f1", archiveEntryIndex: 1.5 }), /Invalid archive entry index/);
});

test("rejects an index past the sanity bound", () => {
  assert.throws(
    () => buildDownloadUrl(API, { fileId: "f1", archiveEntryIndex: 1_000_001 }),
    /Invalid archive entry index/,
  );
});

test("encodes the file id in both branches", () => {
  assert.equal(buildDownloadUrl(API, { fileId: "a b" }), "https://api.dosya.dev/api/files/a%20b/download");
  assert.equal(
    buildDownloadUrl(API, { fileId: "a b", archiveEntryIndex: 1 }),
    "https://api.dosya.dev/api/files/a%20b/archive/entry?i=1&dl=1",
  );
});
