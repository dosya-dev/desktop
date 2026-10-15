import { test } from "node:test";
import assert from "node:assert/strict";

import { buildUploadTree, visibleRows, type UploadTreeNode, type UploadLeaf } from "./upload-tree.ts";

/**
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner.
 *
 * The upload queue used to be one flat list, so a 400-file folder drop read as
 * 400 unrelated rows. These pin how files are grouped back under the folders
 * they came from and how a folder's numbers roll up from everything beneath it.
 */

interface Item { id: string; path: string; size: number; done: number; state: UploadLeaf["state"] }

const item = (id: string, path: string, state: UploadLeaf["state"] = "pending", size = 100, done = 0): Item =>
  ({ id, path, size, done, state });

const leaf = (i: Item): UploadLeaf => ({ path: i.path, size: i.size, bytesDone: i.done, state: i.state });

const names = (nodes: UploadTreeNode<Item>[]): string[] =>
  nodes.map((n) => (n.kind === "folder" ? `${n.name}/` : n.item.id));

test("files with no folder path stay at the top level, in queue order", () => {
  const tree = buildUploadTree([item("a", ""), item("b", "")], leaf);
  assert.deepEqual(names(tree), ["a", "b"]);
});

test("files nest under every folder on their path, folders listed before loose files", () => {
  const tree = buildUploadTree(
    [item("loose", ""), item("p1", "Photos"), item("t1", "Photos/2024/Trip"), item("p2", "Photos")],
    leaf,
  );
  assert.deepEqual(names(tree), ["Photos/", "loose"]);
  const photos = tree[0];
  assert.equal(photos.kind, "folder");
  if (photos.kind !== "folder") return;
  assert.equal(photos.path, "Photos");
  assert.deepEqual(names(photos.children), ["2024/", "p1", "p2"]);
  const y2024 = photos.children[0];
  if (y2024.kind !== "folder") return assert.fail("2024 should be a folder");
  assert.equal(y2024.path, "Photos/2024");
  assert.deepEqual(names(y2024.children), ["Trip/"]);
});

test("a folder's counts and bytes roll up from its whole subtree", () => {
  const tree = buildUploadTree(
    [
      item("a", "Docs", "done", 100, 100),
      item("b", "Docs/Old", "error", 50, 10),
      item("c", "Docs/Old", "active", 200, 50),
      item("d", "Docs/Old/Deep", "pending", 150, 0),
    ],
    leaf,
  );
  const docs = tree[0];
  if (docs.kind !== "folder") return assert.fail("Docs should be a folder");
  assert.equal(docs.fileCount, 4);
  assert.equal(docs.doneCount, 1);
  assert.equal(docs.errorCount, 1);
  assert.equal(docs.activeCount, 1);
  assert.equal(docs.totalBytes, 500);
  // A failed file's partial bytes are not progress: they will be sent again.
  assert.equal(docs.doneBytes, 150);
  const old = docs.children[0];
  if (old.kind !== "folder") return assert.fail("Old should be a folder");
  assert.equal(old.fileCount, 3);
  assert.equal(old.totalBytes, 400);
});

test("ids of everything beneath a folder are collected, for folder-level actions", () => {
  const tree = buildUploadTree([item("a", "X"), item("b", "X/Y"), item("c", "")], leaf);
  const x = tree[0];
  if (x.kind !== "folder") return assert.fail("X should be a folder");
  assert.deepEqual(x.items.map((i) => i.id), ["a", "b"]);
});

test("visibleRows walks the tree depth-first and hides the contents of closed folders", () => {
  const tree = buildUploadTree([item("a", "X"), item("b", "X/Y"), item("c", "")], leaf);
  const open = visibleRows(tree, () => true);
  assert.deepEqual(
    open.map((r) => `${r.depth}:${r.node.kind === "folder" ? r.node.name : r.node.item.id}`),
    ["0:X", "1:Y", "2:b", "1:a", "0:c"],
  );
  const closed = visibleRows(tree, (f) => f.path !== "X/Y");
  assert.deepEqual(
    closed.map((r) => (r.node.kind === "folder" ? r.node.name : r.node.item.id)),
    ["X", "Y", "a", "c"],
  );
});

test("an empty queue is an empty tree", () => {
  assert.deepEqual(buildUploadTree([], leaf), []);
});
