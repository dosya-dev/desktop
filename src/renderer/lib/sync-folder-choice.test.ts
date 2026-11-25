import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSyncFolder } from "./sync-folder-choice.ts";

/**
 * The Quick backup presets (Desktop, Documents, ...) open the native picker AT
 * that folder on every build. Inside the App Sandbox the picker's bookmark is
 * what keeps the folder reachable; everywhere, the main process accepts a sync
 * root only if the user chose it in that picker (main/sync/picked-folders.ts),
 * so a renderer script cannot name ~/.ssh by itself (desktop 3.1.10 bounty).
 */

test("a preset outside the store build still goes through the picker, opened at that folder", async () => {
  let seen: { defaultPath?: string } | undefined;
  const result = await chooseSyncFolder({
    distribution: "direct",
    preset: "/Users/me/Documents",
    pick: async (opts) => {
      seen = opts;
      return { path: "/Users/me/Documents" };
    },
  });
  assert.deepEqual(seen, { defaultPath: "/Users/me/Documents" });
  assert.deepEqual(result, { path: "/Users/me/Documents" });
});

test("a preset never resolves without the picker (a cancelled picker adds nothing)", async () => {
  const result = await chooseSyncFolder({ distribution: "direct", preset: "/Users/me/Documents", pick: async () => null });
  assert.equal(result, null);
});

test("a preset on the store build opens the picker at that folder and keeps the bookmark", async () => {
  let seen: { defaultPath?: string } | undefined;
  const result = await chooseSyncFolder({
    distribution: "mas",
    preset: "/Users/me/Documents",
    pick: async (opts) => {
      seen = opts;
      return { path: "/Users/me/Documents", bookmark: "bm1" };
    },
  });
  assert.deepEqual(seen, { defaultPath: "/Users/me/Documents" });
  assert.deepEqual(result, { path: "/Users/me/Documents", bookmark: "bm1" });
});

test("the Browse button is the picker on every build, without a default path", async () => {
  let seen: unknown = "untouched";
  const result = await chooseSyncFolder({
    distribution: "direct",
    pick: async (opts) => {
      seen = opts;
      return { path: "/x" };
    },
  });
  assert.equal(seen, undefined);
  assert.deepEqual(result, { path: "/x" });
});

test("a cancelled picker changes nothing", async () => {
  const result = await chooseSyncFolder({ distribution: "mas", preset: "/Users/me/Desktop", pick: async () => null });
  assert.equal(result, null);
});

test("before the distribution is known a preset goes through the picker (the safe side)", async () => {
  let picked = false;
  await chooseSyncFolder({ distribution: null, preset: "/p", pick: async () => { picked = true; return null; } });
  assert.equal(picked, true);
});
