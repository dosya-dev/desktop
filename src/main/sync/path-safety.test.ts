import { test } from "node:test";
import assert from "node:assert/strict";
import { isPathWithinRoot } from "./paths.ts";

/**
 * Containment for remote-derived paths.
 *
 * The reconciler builds relPaths by concatenating workspace-controlled folder
 * and file names (normalizeRel is NFC only, it does not sanitise), so every
 * sink that turns one into an absolute path has to gate on this. The engine's
 * download and create-folder sinks always did; move-local did not, and its
 * failure branch downloads the remote file to the escaped path.
 */

const ROOT = "/home/victim/dosya";

test("accepts ordinary relative paths", () => {
  for (const ok of ["a.txt", "dir/a.txt", "a/b/c/d.txt", "Don't Stop.mp3", "5\" nails.jpg", ".gitignore", "..hidden.txt", "a..b/c.txt"]) {
    assert.equal(isPathWithinRoot(ROOT, ok), true, ok);
  }
});

test("rejects traversal segments", () => {
  for (const bad of ["..", "../evil", "innocent/../evil", "a/b/../../../etc/passwd", ".", "./a", "a/./b"]) {
    assert.equal(isPathWithinRoot(ROOT, bad), false, bad);
  }
});

test("rejects backslash traversal even on POSIX", () => {
  // path.resolve treats "\\" as an ordinary character on POSIX, so resolve()
  // alone would pass these. The same snapshot bytes are dangerous on Windows.
  for (const bad of ["..\\evil", "innocent\\..\\evil", "a\\..\\..\\Windows\\System32"]) {
    assert.equal(isPathWithinRoot(ROOT, bad), false, bad);
  }
});

test("rejects absolute paths and control characters", () => {
  for (const bad of ["/etc/passwd", "/home/victim/.bashrc", "a\x00b.txt", "a\x1fb.txt"]) {
    assert.equal(isPathWithinRoot(ROOT, bad), false, JSON.stringify(bad));
  }
});

test("rejects an empty path and a non-string", () => {
  assert.equal(isPathWithinRoot(ROOT, ""), false);
  assert.equal(isPathWithinRoot(ROOT, undefined as unknown as string), false);
});

test("a sibling directory sharing the root's name is not inside it", () => {
  // The separator must be part of the prefix comparison, or "/home/victim/dosya-evil"
  // reads as a child of "/home/victim/dosya".
  assert.equal(isPathWithinRoot("/home/victim/dosya", "../dosya-evil/x.txt"), false);
});

test("the exact PoC from the bug report is refused", () => {
  assert.equal(isPathWithinRoot("/home/user/Desktop", "innocent/../ESCAPED.txt"), false);
});
