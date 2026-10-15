import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseSyncFolder } from "./sync-folder-choice.ts";

/**
 * The Quick backup presets (Desktop, Documents, ...) set a path with one click.
 * Inside the App Sandbox a path alone grants nothing: the folder has to come
 * through the picker so macOS hands back a security-scoped bookmark. So on
 * the store build a preset opens the picker AT that folder; elsewhere it stays
 * one click.
 */

test("a preset is one click outside the store build", async () => {
  let picked = false;
  const result = await chooseSyncFolder({
    distribution: "direct",
    preset: "/Users/me/Documents",
    pick: async () => {
      picked = true;
      return null;
    },
  });
  assert.deepEqual(result, { path: "/Users/me/Documents" });
  assert.equal(picked, false);
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
