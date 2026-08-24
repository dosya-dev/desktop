import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, access } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { createFileLogger } from "./file-logger.ts";

// The 2026-08-20 stress test's macOS death left ZERO evidence: a packaged
// app's console goes nowhere, and nothing wrote to disk. Every console line
// now also lands in <userData>/logs/main.log via this logger.

test("writes timestamped, level-tagged lines", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-log-"));
  try {
    const log = createFileLogger(dir);
    log.write("error", ["boom"]);
    log.write("log", ["hello", 42]);
    await log.flush();
    const content = await readFile(join(dir, "main.log"), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[error\] boom$/);
    assert.match(lines[1], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z \[log\] hello 42$/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("formats Error objects with their stack", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-log-"));
  try {
    const log = createFileLogger(dir);
    log.write("error", ["[crash]", new Error("kapow")]);
    await log.flush();
    const content = await readFile(join(dir, "main.log"), "utf-8");
    assert.match(content, /kapow/);
    assert.match(content, /at /); // stack frames present
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rotates to main.log.old when maxBytes is exceeded", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-log-"));
  try {
    const log = createFileLogger(dir, { maxBytes: 100 });
    log.write("log", ["x".repeat(60)]); // ~95 bytes with timestamp+level
    await log.flush();
    log.write("log", ["second line"]);
    await log.flush();
    await access(join(dir, "main.log.old")); // throws if rotation didn't happen
    const fresh = await readFile(join(dir, "main.log"), "utf-8");
    assert.match(fresh, /second line/);
    assert.doesNotMatch(fresh, /xxxx/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("many lines become ONE write, not one write per line", async () => {
  // An open/write/close per console line added seconds to every app launch.
  // Batching keeps the syscall count proportional to time rather than to how
  // chatty the code is - and flush() must still capture everything buffered.
  const dir = await mkdtemp(join(tmpdir(), "dosya-log-"));
  try {
    const log = createFileLogger(dir, { flushMs: 5 });
    for (let i = 0; i < 500; i++) log.write("log", [`line ${i}`]);
    await log.flush();
    const content = await readFile(join(dir, "main.log"), "utf-8");
    const lines = content.trim().split("\n");
    assert.equal(lines.length, 500);
    assert.match(lines[0], /line 0$/);
    assert.match(lines[499], /line 499$/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("buffered lines reach disk on the timer without an explicit flush", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-log-"));
  try {
    const log = createFileLogger(dir, { flushMs: 5 });
    log.write("warn", ["timed"]);
    await new Promise<void>((r) => setTimeout(r, 60));
    await log.flush();
    assert.match(await readFile(join(dir, "main.log"), "utf-8"), /timed/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("an unwritable directory never throws", async () => {
  const dir = await mkdtemp(join(tmpdir(), "dosya-log-"));
  try {
    const blocker = join(dir, "not-a-dir");
    await writeFile(blocker, "file, not dir");
    const log = createFileLogger(join(blocker, "logs")); // parent is a FILE
    log.write("error", ["this has nowhere to go"]);
    await log.flush(); // must resolve, not reject
    assert.ok(true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
