// @vitest-environment node
//
// vault-save.ts now imports longPath from ./sync/paths with an extensionless
// relative specifier (the "moduleResolution": "bundler" style electron-vite
// bundles it with) - Node's own strip-only type stripping cannot resolve
// that, so this file moved from node:test to vitest, exactly like its
// sibling lan-receive.test.ts. See vitest.config.ts's include list and
// package.json's test:unit glob exclusion.
import { test } from "vitest";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  safeVaultFileName,
  openVaultSink,
  writeVaultSink,
  closeVaultSink,
  abortVaultSink,
  abortAllVaultSinks,
  openVaultSinkCount,
  type VaultSinkDeps,
  type VaultSinkFile,
} from "./vault-save.ts";

// Review Focus 1: a name from a Space is untrusted. It may only ever suggest a
// leaf name in the dialog; it must never steer the path.
test("safeVaultFileName reduces traversal and separators to a leaf name", () => {
  assert.equal(safeVaultFileName("../../.ssh/authorized_keys"), "authorized_keys");
  assert.equal(safeVaultFileName("C:\\Windows\\x.txt"), "C__Windows_x.txt");
  assert.equal(safeVaultFileName("report.pdf"), "report.pdf");
});

// Review Focus 2: an empty or dot-only name gets a readable fallback, never a
// hidden file or a crash.
test("safeVaultFileName falls back for empty and dot names", () => {
  assert.equal(safeVaultFileName(""), "vault-file");
  assert.equal(safeVaultFileName("."), "vault-file");
  assert.equal(safeVaultFileName(".."), "vault-file");
  assert.equal(safeVaultFileName("...hidden"), "hidden");
  assert.equal(safeVaultFileName(42), "vault-file");
  assert.equal(safeVaultFileName("x".repeat(600)).length, 255);
});

// ── The incremental sink (DSK-010) ─────────────────────────────────
//
// The whole-buffer path above holds the plaintext twice (renderer heap +
// structured clone into this process). These cover the streaming
// replacement: the renderer opens a sink BY NAME, pushes one decrypted
// chunk at a time, and neither process ever holds the whole file.

const scratch = () => mkdtempSync(join(tmpdir(), "vault-sink-test-"));

function sinkDeps(dir: string, overrides: Partial<VaultSinkDeps> = {}) {
  const calls = { dialogs: [] as { title: string; defaultPath: string }[] };
  const d: VaultSinkDeps = {
    showSaveDialog: async (opts) => {
      calls.dialogs.push(opts);
      return { canceled: false, filePath: join(dir, "chosen.bin") };
    },
    downloadsDir: () => dir,
    ...overrides,
  };
  return { d, calls };
}

test("a vault sink writes chunks in order and yields the final path", async () => {
  const dir = scratch();
  try {
    const { d, calls } = sinkDeps(dir);
    const opened = await openVaultSink("../../notes.txt", d);
    assert.equal(opened.ok, true);
    assert.ok(opened.id);
    // The untrusted name may only ever suggest a leaf, same rule as the
    // whole-buffer path above.
    assert.equal(calls.dialogs[0].defaultPath, join(dir, "notes.txt"));
    assert.equal(openVaultSinkCount(), 1);

    await writeVaultSink(opened.id!, new Uint8Array([1, 2]), 0);
    await writeVaultSink(opened.id!, new Uint8Array([3, 4]), 1);
    await writeVaultSink(opened.id!, new Uint8Array([5]), 2);
    const { path } = await closeVaultSink(opened.id!);

    assert.equal(path, join(dir, "chosen.bin"));
    assert.deepEqual([...readFileSync(path)], [1, 2, 3, 4, 5]);
    assert.equal(openVaultSinkCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// `PlainChunkSink` is documented to be called in manifest order and the sink
// APPENDS, so order IS the file's correctness. Asserted explicitly - and
// enforced by the sink's own index check - so a future concurrent
// implementation cannot silently interleave two chunks into a corrupt file.
test("a chunk that arrives out of order is refused and the partial file removed", async () => {
  const dir = scratch();
  try {
    const { d } = sinkDeps(dir);
    const opened = await openVaultSink("a.bin", d);
    await writeVaultSink(opened.id!, new Uint8Array([1]), 0);
    await assert.rejects(
      writeVaultSink(opened.id!, new Uint8Array([3]), 2),
      /out of order/i,
    );
    assert.equal(existsSync(join(dir, "chosen.bin")), false);
    assert.equal(openVaultSinkCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// Review Focus #5: disk full midway must not leave a truncated plaintext
// file that looks like a complete decrypted document.
test("a failed write removes the partial file and rejects", async () => {
  const dir = scratch();
  try {
    const target = join(dir, "chosen.bin");
    let closed = false;
    const failingOpen = async (path: string): Promise<VaultSinkFile> => {
      // A REAL file, so the removal this test is about is the real unlink.
      writeFileSync(path, new Uint8Array(), { mode: 0o600 });
      let writes = 0;
      return {
        async write(bytes) {
          if (++writes === 2) throw new Error("ENOSPC: no space left on device");
          writeFileSync(path, bytes, { flag: "a" });
        },
        async close() { closed = true; },
      };
    };
    const { d } = sinkDeps(dir, { open: failingOpen });
    const opened = await openVaultSink("a.bin", d);
    await writeVaultSink(opened.id!, new Uint8Array([1]), 0);
    assert.equal(existsSync(target), true);

    await assert.rejects(
      writeVaultSink(opened.id!, new Uint8Array([2]), 1),
      /ENOSPC/,
    );

    assert.equal(existsSync(target), false); // no truncated plaintext left behind
    assert.equal(closed, true); // the handle is not leaked either
    assert.equal(openVaultSinkCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("abortVaultSink and abortAllVaultSinks remove the partial file", async () => {
  const dir = scratch();
  try {
    const { d } = sinkDeps(dir);
    const first = await openVaultSink("a.bin", d);
    await writeVaultSink(first.id!, new Uint8Array([1]), 0);
    await abortVaultSink(first.id!);
    assert.equal(existsSync(join(dir, "chosen.bin")), false);
    assert.equal(openVaultSinkCount(), 0);
    // An id that is already gone is a no-op, never a throw: the renderer
    // aborts in a catch block it cannot sequence against this process.
    await abortVaultSink(first.id!);
    await abortVaultSink("nope");

    const second = await openVaultSink("b.bin", d);
    await writeVaultSink(second.id!, new Uint8Array([2]), 0);
    await abortAllVaultSinks();
    assert.equal(openVaultSinkCount(), 0);
    assert.equal(existsSync(join(dir, "chosen.bin")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a canceled dialog opens no sink", async () => {
  const dir = scratch();
  try {
    const { d } = sinkDeps(dir, { showSaveDialog: async () => ({ canceled: true }) });
    const opened = await openVaultSink("a.bin", d);
    assert.deepEqual(opened, { ok: false });
    assert.equal(openVaultSinkCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a sink id that no longer exists is rejected, not an unhandled throw", async () => {
  await assert.rejects(writeVaultSink("nope", new Uint8Array([1]), 0), /No such save/);
  await assert.rejects(closeVaultSink("nope"), /No such save/);
  await assert.rejects(writeVaultSink(42, new Uint8Array([1]), 0), /Invalid save id/);
});

test("refuses an implausible name, a non-byte chunk and too many open sinks", async () => {
  const dir = scratch();
  try {
    const { d } = sinkDeps(dir);
    await assert.rejects(openVaultSink("x".repeat(600), d), /Invalid file name/);
    await assert.rejects(openVaultSink(42, d), /Invalid file name/);

    const opened = await openVaultSink("a.bin", d);
    await assert.rejects(writeVaultSink(opened.id!, "not bytes", 0), /Invalid chunk/);
    // An ArrayBuffer survives the structured clone as one; accept it like the
    // whole-buffer path does.
    await writeVaultSink(opened.id!, new Uint8Array([7]).buffer, 0);

    for (let i = 0; i < 3; i++) await openVaultSink(`b${i}.bin`, d);
    await assert.rejects(openVaultSink("one-too-many.bin", d), /Too many/);

    await abortAllVaultSinks();
    assert.equal(openVaultSinkCount(), 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
