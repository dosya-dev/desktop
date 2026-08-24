import { test } from "node:test";
import assert from "node:assert/strict";

import {
  readDroppedEntries, orderedDirs, createFolderTree, resolveTargets,
  type DroppedTree,
} from "./dropped-entries.ts";

/**
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner.
 *
 * Dropping a folder used to hand the uploader a phantom directory handle that
 * failed as an opaque "could not be uploaded". These cover the two things that
 * make the walk correct - reading the item list before the first await, and
 * calling readEntries in a loop - plus the rule that a folder which fails to
 * create must not dump its files into the root.
 */

function fileEntry(name: string): FileSystemFileEntry {
  const file = new File(["xyz"], name, { type: "text/plain" });
  return {
    isFile: true, isDirectory: false, name,
    file: (cb: (f: File) => void) => cb(file),
  } as unknown as FileSystemFileEntry;
}

/** `batchSize` mimics the browser's per-call cap on readEntries. */
function dirEntry(name: string, children: FileSystemEntry[], batchSize = 100): FileSystemDirectoryEntry {
  return {
    isFile: false, isDirectory: true, name,
    createReader: () => {
      let cursor = 0;
      return {
        readEntries: (ok: (e: FileSystemEntry[]) => void) => {
          const batch = children.slice(cursor, cursor + batchSize);
          cursor += batch.length;
          ok(batch);
        },
      };
    },
  } as unknown as FileSystemDirectoryEntry;
}

/** `neuter` reproduces dataTransfer dying when the drop handler returns. */
function dataTransfer(entries: FileSystemEntry[], files: File[] = [], neuter = false): DataTransfer {
  let live = true;
  if (neuter) queueMicrotask(() => { live = false; });
  return {
    get items() {
      return (live ? entries : []).map((entry) => ({
        kind: "file", webkitGetAsEntry: () => entry,
      })) as unknown as DataTransferItemList;
    },
    get files() { return (live ? files : []) as unknown as FileList; },
  } as unknown as DataTransfer;
}

const tree = (paths: string[], dirs: string[]): DroppedTree => ({
  entries: paths.map((p, i) => ({ path: p, file: new File(["x"], `f${i}.txt`) })),
  dirs, hadDirectory: dirs.length > 0, skipped: 0,
});

test("a plain file drop gets an empty folder path", async () => {
  const res = await readDroppedEntries(dataTransfer([fileEntry("a.txt")]));
  assert.deepEqual(res.entries.map((e) => [e.path, e.file.name]), [["", "a.txt"]]);
  assert.equal(res.hadDirectory, false);
});

test("a dropped folder expands into its files, keeping nested paths", async () => {
  const dt = dataTransfer([
    dirEntry("Photos", [fileEntry("a.jpg"), dirEntry("2024", [fileEntry("b.jpg")])]),
  ]);
  const res = await readDroppedEntries(dt);
  assert.deepEqual(
    res.entries.map((e) => `${e.path}/${e.file.name}`).sort(),
    ["Photos/2024/b.jpg", "Photos/a.jpg"],
  );
  assert.deepEqual(res.dirs.sort(), ["Photos", "Photos/2024"]);
});

test("readEntries is called until the directory is exhausted", async () => {
  const many = Array.from({ length: 250 }, (_, i) => fileEntry(`f${i}.txt`));
  const res = await readDroppedEntries(dataTransfer([dirEntry("Big", many, 100)]));
  assert.equal(res.entries.length, 250);
});

test("the item list is read before the first await, so neutering cannot empty it", async () => {
  const dt = dataTransfer([dirEntry("Photos", [fileEntry("a.jpg")])], [], true);
  const res = await readDroppedEntries(dt);
  assert.deepEqual(res.entries.map((e) => e.file.name), ["a.jpg"]);
});

test("OS metadata junk is dropped instead of uploaded", async () => {
  const dt = dataTransfer([dirEntry("Photos", [fileEntry(".DS_Store"), fileEntry("a.jpg")])]);
  const res = await readDroppedEntries(dt);
  assert.deepEqual(res.entries.map((e) => e.file.name), ["a.jpg"]);
});

test("the cap reports what it left out", async () => {
  const many = Array.from({ length: 12 }, (_, i) => fileEntry(`f${i}.txt`));
  const res = await readDroppedEntries(dataTransfer([dirEntry("Big", many)]), 5);
  assert.equal(res.entries.length, 5);
  assert.equal(res.skipped, 7);
});

test("folders are ordered parents-first", () => {
  assert.deepEqual(
    orderedDirs(tree([], ["Photos/2024/raw", "Photos", "Photos/2024"])),
    ["Photos", "Photos/2024", "Photos/2024/raw"],
  );
});

test("each folder is created under its own parent's id", async () => {
  const calls: Array<[string, string | null]> = [];
  const plan = await createFolderTree(["Photos", "Photos/2024"], "fld_root", async (name, parent) => {
    calls.push([name, parent]);
    return `id_${name}`;
  });
  assert.deepEqual(calls, [["Photos", "fld_root"], ["2024", "id_Photos"]]);
  assert.equal(plan.ids.get("Photos/2024"), "id_2024");
});

test("a folder that fails takes its whole subtree out, not into the root", async () => {
  const attempted: string[] = [];
  const plan = await createFolderTree(["Photos", "Photos/2024", "Docs"], null, async (name) => {
    attempted.push(name);
    if (name === "Photos") throw new Error("Folder name is too long");
    return `id_${name}`;
  });
  assert.deepEqual(attempted, ["Photos", "Docs"]);
  assert.deepEqual(plan.failed, ["Photos", "Photos/2024"]);
  assert.equal(plan.error, "Folder name is too long");

  const { targets, skipped } = resolveTargets(
    tree(["Photos", "Photos/2024", ""], []).entries, plan, null,
  );
  assert.equal(skipped, 2);
  assert.deepEqual(targets.map((t) => [t.file.name, t.folderId]), [["f2.txt", null]]);
});

test("files land in the folder their path resolved to", () => {
  const plan = { ids: new Map([["Photos", "id_p"]]) };
  const { targets } = resolveTargets(tree(["Photos", ""], []).entries, plan, "fld_root");
  assert.deepEqual(targets.map((t) => t.folderId), ["id_p", "fld_root"]);
});
