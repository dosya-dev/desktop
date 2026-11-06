import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";

import {
  NEW_FILE_TYPES, blankFileBytes, defaultFileName, withExtension, baseNameEnd, sameName, nameTaken, nameTakenInFolder,
} from "./blank-files.ts";

/** Run with `npm run test:unit` in apps/desktop - Node's own test runner. */

/** Reads a zip's central directory: entry name -> decompressed bytes. */
function unzip(bytes: Uint8Array): Map<string, Buffer> {
  const buf = Buffer.from(bytes);
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(eocd >= 0, "has an end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const compressed = buf.readUInt32LE(p + 20);
    const raw = buf.subarray(dataStart, dataStart + compressed);
    out.set(name, method === 8 ? inflateRawSync(raw) : Buffer.from(raw));
    assert.equal(out.get(name)!.length, size);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test("markdown and text start empty", () => {
  assert.equal(blankFileBytes("markdown").length, 0);
  assert.equal(blankFileBytes("text").length, 0);
});

test("the blank Word document is a real docx package", () => {
  const bytes = blankFileBytes("word");
  assert.equal(bytes.length, 1735);
  assert.equal(String.fromCharCode(bytes[0], bytes[1]), "PK");
  const parts = unzip(bytes);
  assert.ok(parts.has("[Content_Types].xml"));
  assert.ok(parts.has("word/document.xml"));
  assert.match(parts.get("word/document.xml")!.toString("utf8"), /<w:document[\s>]/);
  assert.match(parts.get("[Content_Types].xml")!.toString("utf8"), /wordprocessingml\.document\.main\+xml/);
});

test("each call hands out its own copy", () => {
  const a = blankFileBytes("word");
  a[0] = 0;
  assert.equal(blankFileBytes("word")[0], 0x50);
});

test("mime types", () => {
  assert.equal(NEW_FILE_TYPES.markdown.mime, "text/markdown");
  assert.equal(NEW_FILE_TYPES.text.mime, "text/plain");
  assert.equal(NEW_FILE_TYPES.word.mime, "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
});

test("default names", () => {
  assert.equal(defaultFileName("markdown", "Untitled"), "Untitled.md");
  assert.equal(defaultFileName("text", "Untitled"), "Untitled.txt");
  assert.equal(defaultFileName("word", "Untitled"), "Untitled.docx");
});

test("the extension always matches the kind", () => {
  assert.equal(withExtension("notes", "markdown"), "notes.md");
  assert.equal(withExtension("notes.md", "markdown"), "notes.md");
  assert.equal(withExtension("  notes.md  ", "markdown"), "notes.md");
  assert.equal(withExtension("Notes.MD", "markdown"), "Notes.MD");
  assert.equal(withExtension("notes.txt", "markdown"), "notes.txt.md");
  assert.equal(withExtension("report.doc", "word"), "report.doc.docx");
  assert.equal(withExtension("todo", "text"), "todo.txt");
  assert.equal(withExtension("   ", "text"), "");
});

test("only the base name is selected", () => {
  assert.equal(baseNameEnd("Untitled.md", "markdown"), 8);
  assert.equal(baseNameEnd("Untitled.docx", "word"), 8);
  assert.equal(baseNameEnd("Untitled", "text"), 8);
  assert.equal(baseNameEnd(".txt", "text"), 4);
});

test("name clashes ignore case, files and folders alike", () => {
  assert.ok(sameName("Notes.md", "notes.MD"));
  assert.ok(!sameName("notes.md", "notes.md.md"));
  assert.ok(nameTaken("readme.md", [{ name: "Docs" }, { name: "README.md" }]));
  assert.ok(nameTaken("docs", [{ name: "Docs" }]));
  assert.ok(!nameTaken("readme.txt", [{ name: "README.md" }]));
});

test("asks the API for the exact folder and name", async () => {
  const paths: string[] = [];
  const get = async <T,>(path: string): Promise<T> => {
    paths.push(path);
    return { files: [{ name: "Plan.md" }, { name: "Plan.md.bak" }], folders: [] } as T;
  };
  assert.equal(await nameTakenInFolder(get, "ws1", "f9", "plan.md"), true);
  assert.equal(await nameTakenInFolder(get, "ws1", null, "other.md"), false);
  const first = new URL(`https://x${paths[0]}`);
  assert.equal(first.pathname, "/api/files");
  assert.equal(first.searchParams.get("workspace_id"), "ws1");
  assert.equal(first.searchParams.get("folder_id"), "f9");
  assert.equal(first.searchParams.get("q"), "plan.md");
  assert.equal(first.searchParams.get("per_page"), "100");
  assert.equal(new URL(`https://x${paths[1]}`).searchParams.has("folder_id"), false);
});
