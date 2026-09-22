// apps/desktop/src/renderer/lib/archive-tree.test.ts
//
// Ported from apps/web/src/lib/archive-tree.test.ts - keep in sync with the
// web copy. The builder itself is byte-identical; only the test harness differs.
//
// node --test resolves imports literally: the ".ts" extension is required.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildArchiveTree, type ArchiveEntry } from "./archive-tree.ts";

function entry(over: Partial<ArchiveEntry> & { i: number; name: string }): ArchiveEntry {
  return { size: 0, csize: 0, method: 8, dir: false, encrypted: false, mtime: null, ...over };
}

describe("buildArchiveTree", () => {
  it("nests files under their directories", () => {
    const tree = buildArchiveTree([
      entry({ i: 0, name: "assets/hero.png", size: 10 }),
      entry({ i: 1, name: "README.md", size: 3 }),
    ]);
    assert.deepEqual(tree.map((n) => n.name), ["assets", "README.md"]);
    assert.equal(tree[0]!.kind, "dir");
    assert.deepEqual(tree[0]!.children.map((c) => c.name), ["hero.png"]);
    assert.equal(tree[0]!.children[0]!.index, 0);
  });

  it("creates directories the archive never declared", () => {
    // Real zips often omit directory entries entirely.
    const tree = buildArchiveTree([entry({ i: 0, name: "a/b/c.txt" })]);
    assert.equal(tree[0]!.name, "a");
    assert.equal(tree[0]!.children[0]!.name, "b");
    assert.equal(tree[0]!.children[0]!.children[0]!.name, "c.txt");
  });

  it("sorts directories before files, each alphabetically", () => {
    const tree = buildArchiveTree([
      entry({ i: 0, name: "zeta.txt" }),
      entry({ i: 1, name: "alpha.txt" }),
      entry({ i: 2, name: "src/x.ts" }),
      entry({ i: 3, name: "assets/y.png" }),
    ]);
    assert.deepEqual(tree.map((n) => n.name), ["assets", "src", "alpha.txt", "zeta.txt"]);
  });

  it("keeps an explicit directory entry from becoming a file", () => {
    const tree = buildArchiveTree([entry({ i: 0, name: "empty/", dir: true })]);
    assert.equal(tree.length, 1);
    assert.equal(tree[0]!.kind, "dir");
    assert.deepEqual(tree[0]!.children, []);
  });

  it("carries the entry index, size and flags onto the leaf", () => {
    const tree = buildArchiveTree([entry({ i: 7, name: "secret.psd", size: 99, encrypted: true, method: 0 })]);
    assert.equal(tree[0]!.kind, "file");
    assert.equal(tree[0]!.index, 7);
    assert.equal(tree[0]!.size, 99);
    assert.equal(tree[0]!.encrypted, true);
    assert.equal(tree[0]!.method, 0);
  });

  it("sums a directory total from everything beneath it", () => {
    const tree = buildArchiveTree([
      entry({ i: 0, name: "a/one.bin", size: 100 }),
      entry({ i: 1, name: "a/deep/two.bin", size: 25 }),
    ]);
    assert.equal(tree[0]!.totalBytes, 125);
    assert.equal(tree[0]!.fileCount, 2);
  });

  it("neutralises traversal and absolute paths in displayed names", () => {
    // The server addresses entries by index, so a hostile name cannot reach
    // anything - but it must not be able to draw a misleading tree either.
    const tree = buildArchiveTree([
      entry({ i: 0, name: "../../etc/passwd" }),
      entry({ i: 1, name: "/abs/rooted.txt" }),
    ]);
    assert.equal(JSON.stringify(tree).includes(".."), false);
    assert.equal(tree.every((n) => n.name.length > 0), true);
  });

  it("drops empty path segments rather than rendering blank rows", () => {
    const tree = buildArchiveTree([entry({ i: 0, name: "a//b.txt" })]);
    assert.equal(tree[0]!.name, "a");
    assert.equal(tree[0]!.children[0]!.name, "b.txt");
  });

  it('splits a Windows-written path instead of naming one node "a/b/c.txt"', () => {
    // Separators must be normalised before the split, not after: doing it per
    // segment cannot split anything, and the row ends up displaying slashes.
    const tree = buildArchiveTree([entry({ i: 0, name: "a\\b\\c.txt" })]);
    assert.equal(tree[0]!.name, "a");
    assert.equal(tree[0]!.children[0]!.name, "b");
    assert.equal(tree[0]!.children[0]!.children[0]!.name, "c.txt");
    assert.equal(JSON.stringify(tree).includes("a/b/c.txt"), false);
  });

  it("drops a segment made only of control characters rather than drawing a blank row", () => {
    const tree = buildArchiveTree([entry({ i: 0, name: "bad/\x01\x02/ok.txt" })]);
    assert.equal(tree[0]!.name, "bad");
    assert.equal(tree[0]!.children[0]!.name, "ok.txt");
  });

  it("strips a right-to-left-override spoof rather than drawing a name that lies", () => {
    // "invoice<U+202E>gnp.exe" renders as "invoicexe.png" in every client, and
    // the name travels past the row - into this app's save dialog defaultPath -
    // so a row that merely LOOKS wrong is not the whole of it.
    const tree = buildArchiveTree([
      entry({ i: 0, name: "invoice\u202Egnp.exe" }),
      entry({ i: 1, name: "\u2066reports\u2069/q1\u200e.csv" }),
    ]);
    assert.deepEqual(tree.map((n) => n.name), ["reports", "invoicegnp.exe"]);
    assert.equal(tree[0]!.children[0]!.name, "q1.csv");
    assert.ok(!/[\u200e\u200f\u202a-\u202e\u2066-\u2069]/.test(JSON.stringify(tree)));
  });

  it("returns an empty array for an archive with no entries", () => {
    assert.deepEqual(buildArchiveTree([]), []);
  });
});
