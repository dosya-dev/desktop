import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldRunEngineInProcess } from "./engine-selection.ts";

/**
 * The engine normally runs in its own utility process so a crash costs a
 * re-fork, not the app. Two things pull it back in-process: the debugging
 * escape hatch, and the Mac App Store build, where the folder grants from
 * security-scoped bookmarks are held by the main process and whether a child
 * inherits them is unverified.
 */
test("isolated by default", () => {
  assert.equal(shouldRunEngineInProcess({ env: {}, distribution: "direct" }), false);
  assert.equal(shouldRunEngineInProcess({ env: {}, distribution: "ms-store" }), false);
  assert.equal(shouldRunEngineInProcess({ env: {}, distribution: "snap" }), false);
});

test("the debugging escape hatch wins everywhere", () => {
  assert.equal(shouldRunEngineInProcess({ env: { DOSYA_SYNC_IN_PROCESS: "1" }, distribution: "direct" }), true);
  assert.equal(shouldRunEngineInProcess({ env: { DOSYA_SYNC_IN_PROCESS: "0" }, distribution: "direct" }), false);
});

test("the store build runs in-process", () => {
  assert.equal(shouldRunEngineInProcess({ env: {}, distribution: "mas" }), true);
});
