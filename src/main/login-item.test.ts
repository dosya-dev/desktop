import { test } from "node:test";
import assert from "node:assert/strict";
import { loginItemMode } from "./login-item.ts";

/**
 * A sandboxed (Mac App Store) build cannot use Electron's login-helper
 * mechanism; SMAppService ("mainAppService") replaces it on macOS 13+. On an
 * older macOS the store build has no working mechanism, and the UI hides the
 * toggle rather than offering one that throws.
 */

test("direct and non-Apple stores keep the helper mechanism everywhere", () => {
  assert.equal(loginItemMode({ distribution: "direct", platform: "darwin", osVersion: "14.1.2" }), "helper");
  assert.equal(loginItemMode({ distribution: "ms-store", platform: "win32", osVersion: "10.0.19045" }), "helper");
  assert.equal(loginItemMode({ distribution: "snap", platform: "linux", osVersion: "6.8.0" }), "helper");
});

test("the store build uses SMAppService on macOS 13 and newer", () => {
  assert.equal(loginItemMode({ distribution: "mas", platform: "darwin", osVersion: "13.0" }), "mainAppService");
  assert.equal(loginItemMode({ distribution: "mas", platform: "darwin", osVersion: "14.1.2" }), "mainAppService");
  assert.equal(loginItemMode({ distribution: "mas", platform: "darwin", osVersion: "26.0.1" }), "mainAppService");
});

test("the store build on macOS 12, or with an unreadable version, has no mechanism", () => {
  assert.equal(loginItemMode({ distribution: "mas", platform: "darwin", osVersion: "12.7.6" }), "unsupported");
  assert.equal(loginItemMode({ distribution: "mas", platform: "darwin", osVersion: "" }), "unsupported");
  assert.equal(loginItemMode({ distribution: "mas", platform: "darwin", osVersion: "garbage" }), "unsupported");
});
