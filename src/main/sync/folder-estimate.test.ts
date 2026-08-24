import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { estimateFolder } from "./folder-estimate.ts";

// Preflight for the Add-folder modal: a cheap Dirent-only count so the UI can
// warn "this folder has 500K files" BEFORE the user commits to syncing it.

async function makeTree(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "dosya-est-"));
  await mkdir(join(root, "a/b"), { recursive: true });
  await mkdir(join(root, "c"), { recursive: true });
  await writeFile(join(root, "f1.txt"), "x");
  await writeFile(join(root, "a", "f2.txt"), "x");
  await writeFile(join(root, "a/b", "f3.txt"), "x");
  await writeFile(join(root, "c", "f4.txt"), "x");
  return root;
}

test("counts files and folders in a small tree", async () => {
  const root = await makeTree();
  try {
    const est = await estimateFolder(root);
    assert.equal(est.files, 4);
    assert.equal(est.folders, 3); // a, a/b, c
    assert.equal(est.truncated, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("stops at maxEntries and reports truncated", async () => {
  const root = await makeTree();
  try {
    const est = await estimateFolder(root, { maxEntries: 2 });
    assert.equal(est.truncated, true);
    assert.ok(est.files + est.folders >= 2);
    assert.ok(est.files + est.folders < 7);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a nonexistent root estimates as empty, not an error", async () => {
  const est = await estimateFolder(join(tmpdir(), "dosya-est-definitely-missing"));
  assert.deepEqual(est, { files: 0, folders: 0, truncated: false });
});
