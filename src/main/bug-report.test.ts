import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describePlatform, tailLines, tailOfFile, LOG_TAIL_LINES, LOG_TAIL_MAX_BYTES } from "./bug-report.ts";

test("describePlatform names the OS the way a user would and keeps the kernel release", () => {
  assert.equal(describePlatform({ platform: "darwin", release: "24.6.0" }), "macOS 24.6.0");
  assert.equal(describePlatform({ platform: "win32", release: "10.0.26100" }), "Windows 10.0.26100");
  assert.equal(describePlatform({ platform: "linux", release: "6.8.0-45-generic" }), "Linux 6.8.0-45-generic");
  assert.equal(describePlatform({ platform: "freebsd", release: "14.1" }), "freebsd 14.1");
});

test("tailLines keeps the last n lines and drops a trailing newline's empty line", () => {
  assert.equal(tailLines("a\nb\nc\n", 2), "b\nc");
  assert.equal(tailLines("a\nb\nc", 5), "a\nb\nc");
  assert.equal(tailLines("", 5), "");
  assert.equal(tailLines("only", 1), "only");
});

test("tailOfFile reads only the end of a big file and returns the last lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bug-report-"));
  const path = join(dir, "main.log");
  const lines = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(40)}`);
  await writeFile(path, lines.join("\n") + "\n");
  const tail = await tailOfFile(path, 200);
  const got = tail.split("\n");
  assert.equal(got.length, 200);
  assert.equal(got[199], lines[4999]);
  assert.equal(got[0], lines[4800]);
  await rm(dir, { recursive: true, force: true });
});

test("tailOfFile never reads more than maxBytes, and drops the partial first line that a byte cut leaves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bug-report-"));
  const path = join(dir, "main.log");
  const lines = Array.from({ length: 100 }, (_, i) => `row ${i} ${"y".repeat(100)}`);
  await writeFile(path, lines.join("\n"));
  const tail = await tailOfFile(path, 200, 1000);
  const got = tail.split("\n");
  // 1000 bytes covers ~9 full lines of ~108 bytes; the cut-off first fragment is dropped.
  assert.ok(got.length >= 8 && got.length <= 9, `got ${got.length} lines`);
  assert.ok(got[0].startsWith("row "), `first line is whole: ${got[0]}`);
  assert.equal(got[got.length - 1], lines[99]);
  await rm(dir, { recursive: true, force: true });
});

test("tailOfFile never pads a short read with NUL bytes when maxBytes exceeds the file size", async () => {
  const dir = await mkdtemp(join(tmpdir(), "bug-report-"));
  const path = join(dir, "main.log");
  await writeFile(path, "line one\nline two\n");
  const tail = await tailOfFile(path, 200, 64 * 1024);
  assert.equal(tail, "line one\nline two");
  assert.ok(!tail.includes("\u0000"));
  await rm(dir, { recursive: true, force: true });
});

test("tailOfFile resolves to an empty string for a missing file", async () => {
  assert.equal(await tailOfFile(join(tmpdir(), "does-not-exist-" + Date.now(), "main.log"), 200), "");
});

test("the constants are the spec's", () => {
  assert.equal(LOG_TAIL_LINES, 200);
  assert.equal(LOG_TAIL_MAX_BYTES, 64 * 1024);
});
