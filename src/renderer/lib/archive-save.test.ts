// apps/desktop/src/renderer/lib/archive-save.test.ts
//
// Pure-function tests for the folder-save planner and runner, ported from the
// web copy (apps/web/src/lib/archive-save.test.ts). The module under test is
// byte-identical across web, desktop and mobile (test-all diffs the three);
// the test runner differs - node --test here, so the ".ts" extension is
// required on imports and the assertions are node:assert's.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { planFolderSave, runFolderSave, MAX_FOLDER_SAVE_FILES, type SavePlan } from "./archive-save.ts";
import { buildArchiveTree, type ArchiveEntry } from "./archive-tree.ts";

const entry = (i: number, name: string, over: Partial<ArchiveEntry> = {}): ArchiveEntry =>
  ({ i, name, size: 1, csize: 1, method: 8, dir: false, encrypted: false, mtime: null, ...over });

const TREE = buildArchiveTree([
  entry(1, "docs/readme.md"),
  entry(2, "docs/2026/notes.md"),
  entry(3, "docs/2026/q1/plan.md"),
  entry(4, "docs/secret.psd", { encrypted: true }),
  entry(5, "docs/legacy.bin", { method: 99 }),
  entry(6, "docs/empty/", { dir: true }),
  entry(7, "other.txt"),
]);
const docs = TREE.find((n) => n.name === "docs")!;

function makeDeps() {
  let n = 0;
  const created: { parent: string | null; names: string[] }[] = [];
  const saved: { index: number; folderId: string | null; name: string }[] = [];
  const progress: [number, number][] = [];
  return {
    created, saved, progress,
    createFolders: async (parent: string | null, names: string[]) => {
      created.push({ parent, names });
      return new Map(names.map((name) => [name, `fld_${name}_${++n}`]));
    },
    saveEntry: async (index: number, folderId: string | null, name: string) => {
      saved.push({ index, folderId, name });
      return { file_id: `file_${index}`, name };
    },
    onProgress: (d: number, t: number) => { progress.push([d, t]); },
    isCancelled: () => false,
  };
}

describe("planFolderSave", () => {
  it("collects openable files with directories relative to the chosen node, and lists what it skips", () => {
    const plan = planFolderSave(docs.children, "docs") as SavePlan;
    assert.equal(plan.rootName, "docs");
    assert.deepEqual(plan.files, [
      { index: 3, relDir: ["2026", "q1"], name: "plan.md" },
      { index: 2, relDir: ["2026"], name: "notes.md" },
      { index: 1, relDir: [], name: "readme.md" },
    ]);
    assert.deepEqual(plan.dirs, [["2026"], ["empty"], ["2026", "q1"]]);
    assert.deepEqual(plan.skipped, [
      { name: "legacy.bin", reason: "unsupported compression (method 99)" },
      { name: "secret.psd", reason: "password-protected" },
    ]);
  });

  it("refuses more files than the cap", () => {
    const many = buildArchiveTree(Array.from({ length: MAX_FOLDER_SAVE_FILES + 1 }, (_, i) => entry(i, `f${i}.txt`)));
    assert.deepEqual(planFolderSave(many, "all"), { tooMany: MAX_FOLDER_SAVE_FILES + 1 });
  });
});

describe("runFolderSave", () => {
  const plan = planFolderSave(docs.children, "docs") as SavePlan;

  it("creates the wrapping folder, then each level, then saves files one at a time into the right folder", async () => {
    const d = makeDeps();
    const out = await runFolderSave(plan, "dest", d);
    assert.deepEqual(d.created[0], { parent: "dest", names: ["docs"] });
    assert.deepEqual(d.created[1], { parent: "fld_docs_1", names: ["2026", "empty"] });
    assert.deepEqual(d.created[2], { parent: "fld_2026_2", names: ["q1"] });
    assert.deepEqual(d.saved, [
      { index: 3, folderId: "fld_q1_4", name: "plan.md" },
      { index: 2, folderId: "fld_2026_2", name: "notes.md" },
      { index: 1, folderId: "fld_docs_1", name: "readme.md" },
    ]);
    assert.deepEqual(d.progress, [[0, 3], [1, 3], [2, 3], [3, 3]]);
    assert.deepEqual(out, { saved: 3, failed: [], skipped: 2, cancelled: false, rootFolderId: "fld_docs_1" });
  });

  it("continues past a failed file and reports it", async () => {
    const d = makeDeps();
    const out = await runFolderSave(plan, "dest", {
      ...d,
      saveEntry: async (index, _folderId, name) => {
        if (index === 2) throw new Error("Storage limit reached");
        return { file_id: `file_${index}`, name };
      },
    });
    assert.equal(out.saved, 2);
    assert.deepEqual(out.failed, [{ name: "2026/notes.md", message: "Storage limit reached" }]);
  });

  it("stops after the current file when cancelled", async () => {
    const d = makeDeps();
    let calls = 0;
    const out = await runFolderSave(plan, "dest", { ...d, isCancelled: () => ++calls > 1 });
    assert.equal(out.cancelled, true);
    assert.equal(out.saved, 1);
  });

  it("stops before any file when the first folder create is refused", async () => {
    const d = makeDeps();
    let first = true;
    const out = await runFolderSave(plan, null, {
      ...d,
      createFolders: async (parent, names) => {
        if (first) { first = false; throw new Error("This folder is outside the folder you're confined to"); }
        return d.createFolders(parent, names);
      },
    });
    assert.equal(out.saved, 0);
    assert.deepEqual(d.saved, []);
    assert.deepEqual(out.failed, [{ name: "docs", message: "This folder is outside the folder you're confined to" }]);
  });

  it("reports a nested folder that could not be created and every file beneath it, so the counts add up", async () => {
    const d = makeDeps();
    const out = await runFolderSave(plan, "dest", {
      ...d,
      createFolders: async (_parent, names) => new Map(names.filter((n) => n !== "q1").map((name) => [name, `fld_${name}`])),
    });
    assert.deepEqual(out.failed, [
      { name: "2026/q1", message: "Folder could not be created" },
      { name: "2026/q1/plan.md", message: "Its folder could not be created" },
    ]);
    assert.equal(d.saved.find((s) => s.index === 3), undefined);
    assert.equal(out.saved, 2);
    assert.deepEqual(d.progress.at(-1), [3, 3]);
  });
});
