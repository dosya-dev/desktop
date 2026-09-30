import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_VAULT_SAVE_BYTES, safeVaultFileName, saveVaultBytes, type VaultSaveDeps } from "./vault-save.ts";

function deps(overrides: Partial<VaultSaveDeps> = {}) {
  const calls = { dialogs: [] as { title: string; defaultPath: string }[], writes: [] as { path: string; bytes: Uint8Array }[] };
  const d: VaultSaveDeps = {
    showSaveDialog: async (opts) => { calls.dialogs.push(opts); return { canceled: false, filePath: "/Users/x/Downloads/chosen.bin" }; },
    downloadsDir: () => "/Users/x/Downloads",
    write: async (path, bytes) => { calls.writes.push({ path, bytes }); },
    ...overrides,
  };
  return { d, calls };
}

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

test("saveVaultBytes asks for a path under Downloads and writes the bytes there", async () => {
  const { d, calls } = deps();
  const bytes = new Uint8Array([1, 2, 3]);
  const result = await saveVaultBytes("../notes.txt", bytes, d);
  assert.deepEqual(result, { ok: true, path: "/Users/x/Downloads/chosen.bin" });
  assert.equal(calls.dialogs.length, 1);
  assert.equal(calls.dialogs[0].defaultPath, "/Users/x/Downloads/notes.txt");
  assert.equal(calls.writes.length, 1);
  assert.equal(calls.writes[0].path, "/Users/x/Downloads/chosen.bin");
  assert.deepEqual([...calls.writes[0].bytes], [1, 2, 3]);
});

test("saveVaultBytes accepts an ArrayBuffer (structured clone may hand one over)", async () => {
  const { d, calls } = deps();
  await saveVaultBytes("a.bin", new Uint8Array([9]).buffer, d);
  assert.deepEqual([...calls.writes[0].bytes], [9]);
});

test("a canceled dialog writes nothing and says so", async () => {
  const { d, calls } = deps({ showSaveDialog: async () => ({ canceled: true }) });
  const result = await saveVaultBytes("a.bin", new Uint8Array([1]), d);
  assert.deepEqual(result, { ok: false, canceled: true });
  assert.equal(calls.writes.length, 0);
});

test("refuses non-byte payloads and oversized ones before showing a dialog", async () => {
  const { d, calls } = deps();
  await assert.rejects(saveVaultBytes("a.bin", "not bytes", d), /Invalid bytes/);
  // A real Uint8Array that REPORTS one byte over the cap, so the size branch
  // (not the instanceof branch) is what refuses it - without allocating 2 GiB.
  const huge = new Uint8Array(1);
  Object.defineProperty(huge, "byteLength", { value: MAX_VAULT_SAVE_BYTES + 1 });
  await assert.rejects(saveVaultBytes("a.bin", huge, d), /Invalid bytes/);
  assert.equal(calls.dialogs.length, 0);
});
