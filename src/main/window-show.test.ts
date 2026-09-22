import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldShowOnReady, launchedHidden } from "./window-show.ts";

// Field report 2026-09-02 (desktop #13): ready-to-show always called
// win.show() + win.focus(), so "launch at login (hidden)" still put a window
// in the user's face at every boot. The decision is pure so it can be tested.

test("a normal launch shows the window when it is ready", () => {
  assert.equal(shouldShowOnReady({ openedAsHidden: false }), true);
});

test("a hidden launch (login item) keeps the window hidden - the tray is the entry point", () => {
  assert.equal(shouldShowOnReady({ openedAsHidden: true }), false);
});

test("hidden launch is detected from macOS login-item state or the Windows --hidden argument", () => {
  assert.equal(launchedHidden({ argv: ["/Applications/dosya.app"], wasOpenedAsHidden: true }), true);
  assert.equal(launchedHidden({ argv: ["dosya.exe", "--hidden"], wasOpenedAsHidden: false }), true);
  assert.equal(launchedHidden({ argv: ["dosya.exe", "--hidden"], wasOpenedAsHidden: undefined }), true);
  assert.equal(launchedHidden({ argv: ["dosya.exe", "dosya://sync?x=1"], wasOpenedAsHidden: false }), false);
  assert.equal(launchedHidden({ argv: [], wasOpenedAsHidden: undefined }), false);
});
