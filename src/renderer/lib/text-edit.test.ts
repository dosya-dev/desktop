import { test } from "node:test";
import assert from "node:assert/strict";

import {
  TEXT_EDIT_MAX_BYTES,
  canEditText,
  changedSince,
  countWords,
  pickCopyName,
  textEditorKind,
} from "./text-edit.ts";

// ── Which files open in the editor ─────────────────────────

test("markdown and plain text are editable kinds, case-insensitive", () => {
  assert.equal(textEditorKind("notes.md"), "markdown");
  assert.equal(textEditorKind("README.MARKDOWN"), "markdown");
  assert.equal(textEditorKind("todo.txt"), "text");
  assert.equal(textEditorKind("Todo.TXT"), "text");
  assert.equal(textEditorKind("report.docx"), null);
  assert.equal(textEditorKind("md"), null);
  assert.equal(textEditorKind("archive.md.zip"), null);
});

test("the editor takes files up to 2 MB that are not password locked", () => {
  const file = { name: "a.md", size_bytes: 10, lock_mode: "none" };
  assert.equal(canEditText(file), true);
  assert.equal(canEditText({ ...file, size_bytes: TEXT_EDIT_MAX_BYTES }), true);
  assert.equal(canEditText({ ...file, size_bytes: TEXT_EDIT_MAX_BYTES + 1 }), false);
  assert.equal(canEditText({ ...file, lock_mode: "full_lock" }), false);
  assert.equal(canEditText({ ...file, lock_mode: "view_only" }), true);
  assert.equal(canEditText({ ...file, name: "a.pdf" }), false);
});

// ── Conflict check ─────────────────────────────────────────

test("a new version number means the file changed", () => {
  assert.equal(changedSince({ current_version: 3, updated_at: 100 }, { current_version: 4, updated_at: 100 }), true);
  assert.equal(changedSince({ current_version: 3, updated_at: 100 }, { current_version: 3, updated_at: 100 }), false);
});

test("the version wins over updated_at, which a rename or a lock also moves", () => {
  assert.equal(changedSince({ current_version: 3, updated_at: 100 }, { current_version: 3, updated_at: 200 }), false);
});

test("without version numbers, updated_at decides", () => {
  assert.equal(changedSince({ updated_at: 100 }, { updated_at: 200 }), true);
  assert.equal(changedSince({ updated_at: 100 }, { updated_at: 100 }), false);
  assert.equal(changedSince({ current_version: 2, updated_at: 100 }, { updated_at: 100 }), false);
});

// ── Save as copy ───────────────────────────────────────────

const label = (base: string, n: number) => (n === 1 ? `${base} (copy)` : `${base} (copy ${n})`);

test("the copy keeps the extension and takes the first free name", async () => {
  const taken = new Set(["plan (copy).md"]);
  const name = await pickCopyName("plan.md", async (n) => taken.has(n), label);
  assert.equal(name, "plan (copy 2).md");
});

test("a free first choice is used as is", async () => {
  assert.equal(await pickCopyName("notes.txt", async () => false, label), "notes (copy).txt");
});

test("a name without an extension still gets a copy name", async () => {
  assert.equal(await pickCopyName("README", async () => false, label), "README (copy)");
});

test("gives up after many tries rather than looping forever", async () => {
  await assert.rejects(pickCopyName("a.md", async () => true, label));
});

// ── Word count ─────────────────────────────────────────────

test("counts words, not Markdown syntax", () => {
  assert.equal(countWords(""), 0);
  assert.equal(countWords("   \n\t"), 0);
  assert.equal(countWords("# Q4 launch plan"), 3);
  assert.equal(countWords("- [x] Fix the **QA** report"), 4);
  assert.equal(countWords("one,two three-four"), 4);
});
