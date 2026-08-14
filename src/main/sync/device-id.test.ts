import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEVICE_ID_FILE, DEVICE_ID_HEADER, isValidDeviceId, loadOrCreateDeviceId, currentDeviceId, ensureDeviceId,
} from "./device-id.ts";

/**
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner, no
 * dependency and no Electron. That is why this module takes its directory as an
 * argument instead of calling `app.getPath("userData")` itself.
 */

const tempDir = () => mkdtemp(join(tmpdir(), "dosya-device-"));

test("mints an id on first run and persists it", async () => {
  const dir = await tempDir();
  const id = await loadOrCreateDeviceId(dir);

  assert.ok(isValidDeviceId(id), `minted id is not valid: ${id}`);
  const stored = JSON.parse(await readFile(join(dir, DEVICE_ID_FILE), "utf-8"));
  assert.equal(stored.deviceId, id);
});

test("reuses the persisted id on the next call, and across a restart", async () => {
  const dir = await tempDir();
  const first = await loadOrCreateDeviceId(dir);
  const second = await loadOrCreateDeviceId(dir);
  assert.equal(second, first);

  // A restart is a fresh module instance reading the same directory: nothing
  // in memory, everything from the file.
  const fresh = await import(new URL("./device-id.ts?restart=1", import.meta.url).href) as typeof import("./device-id.ts");
  assert.equal(await fresh.loadOrCreateDeviceId(dir), first);
});

test("is stable per installation, not per account: it lives outside sync-config.json", async () => {
  const dir = await tempDir();
  const id = await loadOrCreateDeviceId(dir);

  // What an account switch does to the sync config (index.ts empties the pair
  // list and rewrites it). The machine is still the same machine.
  await writeFile(join(dir, "sync-config.json"), JSON.stringify({ pairs: [], userId: "usr_new" }));
  assert.equal(await loadOrCreateDeviceId(dir), id);
});

test("replaces an unusable store rather than failing", async () => {
  const dir = await tempDir();

  await writeFile(join(dir, DEVICE_ID_FILE), "{ truncated");
  const afterCorrupt = await loadOrCreateDeviceId(dir);
  assert.ok(isValidDeviceId(afterCorrupt));

  // A 0-byte file is what a crash mid-write used to leave behind.
  await writeFile(join(dir, DEVICE_ID_FILE), "");
  const afterEmpty = await loadOrCreateDeviceId(dir);
  assert.ok(isValidDeviceId(afterEmpty));

  // An id the SERVER would reject is not an id: it would be dropped on arrival
  // and the device would look like it never reported.
  await writeFile(join(dir, DEVICE_ID_FILE), JSON.stringify({ deviceId: "x" }));
  const afterJunk = await loadOrCreateDeviceId(dir);
  assert.ok(isValidDeviceId(afterJunk));
  assert.notEqual(afterJunk, "x");
});

test("still returns a usable id when the store cannot be written - sync must not depend on it", async () => {
  const parent = await tempDir();
  // A read-only directory: mkdir and the atomic write both fail with EACCES.
  const dir = join(parent, "locked", "sync");
  await mkdir(join(parent, "locked"));
  await chmod(join(parent, "locked"), 0o500);
  try {
    const id = await loadOrCreateDeviceId(dir);
    assert.ok(isValidDeviceId(id), "a failed persist must still yield an id for this session");
  } finally {
    await chmod(join(parent, "locked"), 0o700);
  }
});

test("resolves once per process, however many callers race for it", async () => {
  const dir = await tempDir();
  const mod = await import(new URL("./device-id.ts?race=1", import.meta.url).href) as typeof import("./device-id.ts");

  assert.equal(mod.currentDeviceId(), null, "nothing is known before the first call");
  const [a, b, c] = await Promise.all([
    mod.ensureDeviceId(dir), mod.ensureDeviceId(dir), mod.ensureDeviceId(dir),
  ]);
  assert.equal(a, b);
  assert.equal(b, c);
  assert.equal(mod.currentDeviceId(), a);

  // Memoised: a later call does not go back to disk, even if the file changes.
  await writeFile(join(dir, DEVICE_ID_FILE), JSON.stringify({ deviceId: "something-else-entirely" }));
  assert.equal(await mod.ensureDeviceId(dir), a);
});

test("the id passes the shape the server validates on", () => {
  // Mirrors apps/api/src/lib/sync/device-state.ts's parseDeviceId. An id this
  // app persists but the server ignores is a device that never reports.
  assert.ok(isValidDeviceId("3f1a9c5e-3b6e-4a0e-9a2b-9d1f8a2c7e41"));
  assert.ok(!isValidDeviceId("short"));
  assert.ok(!isValidDeviceId("a".repeat(129)));
  assert.ok(!isValidDeviceId("has a space"));
  assert.ok(!isValidDeviceId(42));
  assert.ok(!isValidDeviceId(undefined));
});

test("names the header the server reads", () => {
  assert.equal(DEVICE_ID_HEADER.toLowerCase(), "x-dosya-device");
});

test("starts with nothing loaded, so a caller that cannot await knows to skip it", async () => {
  const mod = await import(new URL("./device-id.ts?cold=1", import.meta.url).href) as typeof import("./device-id.ts");
  assert.equal(mod.currentDeviceId(), null);
  assert.equal(currentDeviceId.name, "currentDeviceId");
});
