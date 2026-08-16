import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  captureWindowState, resolveWindowState, readWindowState, writeWindowState, WINDOW_STATE_FILE,
} from "./window-state.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron. The
 * module takes displays and the state directory as arguments instead of
 * calling `screen` / `app.getPath` itself (same pattern as device-id.ts),
 * which is what lets a saved-on-a-disconnected-monitor state be tested here.
 */

const DISPLAY: { x: number; y: number; width: number; height: number } = { x: 0, y: 0, width: 1920, height: 1080 };
const DEFAULTS = { width: 1200, height: 800, minWidth: 900, minHeight: 600 };
const tempDir = () => mkdtemp(join(tmpdir(), "dosya-winstate-"));

test("captureWindowState snapshots normal bounds plus the maximized flag", () => {
  const state = captureWindowState({
    isMaximized: () => true,
    getNormalBounds: () => ({ x: 40, y: 50, width: 1000, height: 700 }),
  });
  assert.deepEqual(state, { x: 40, y: 50, width: 1000, height: 700, maximized: true });
});

test("a valid on-screen state is used as saved", () => {
  const saved = { x: 100, y: 80, width: 1100, height: 750, maximized: false };
  const { bounds, maximized } = resolveWindowState(saved, [DISPLAY], DEFAULTS);
  assert.deepEqual(bounds, { x: 100, y: 80, width: 1100, height: 750 });
  assert.equal(maximized, false);
});

test("the maximized flag round-trips", () => {
  const saved = { x: 100, y: 80, width: 1100, height: 750, maximized: true };
  assert.equal(resolveWindowState(saved, [DISPLAY], DEFAULTS).maximized, true);
});

test("garbage state falls back to defaults (null bounds)", () => {
  for (const raw of [null, undefined, "x", 7, {}, { x: 1 }, { x: NaN, y: 0, width: 1000, height: 700, maximized: false }, { x: 0, y: 0, width: "1000", height: 700, maximized: false }]) {
    const { bounds, maximized } = resolveWindowState(raw, [DISPLAY], DEFAULTS);
    assert.equal(bounds, null, `expected null bounds for ${JSON.stringify(raw)}`);
    assert.equal(maximized, false);
  }
});

test("a window saved on a now-disconnected monitor recenters instead of opening off-screen", () => {
  // Second monitor to the right was removed: nothing of the window intersects.
  const saved = { x: 2200, y: 100, width: 1000, height: 700, maximized: false };
  assert.equal(resolveWindowState(saved, [DISPLAY], DEFAULTS).bounds, null);
});

test("a mostly-off-screen window with a usable sliver stays where it was", () => {
  // 120x1080 of it is still on the display - enough to grab and drag back.
  const saved = { x: 1800, y: 0, width: 1000, height: 700, maximized: false };
  assert.deepEqual(resolveWindowState(saved, [DISPLAY], DEFAULTS).bounds, { x: 1800, y: 0, width: 1000, height: 700 });
});

test("saved size below the window minimums is clamped up", () => {
  const saved = { x: 10, y: 10, width: 500, height: 300, maximized: false };
  assert.deepEqual(resolveWindowState(saved, [DISPLAY], DEFAULTS).bounds, { x: 10, y: 10, width: 900, height: 600 });
});

test("saved size larger than every display is clamped to the biggest work area", () => {
  const saved = { x: 0, y: 0, width: 5000, height: 4000, maximized: false };
  assert.deepEqual(resolveWindowState(saved, [DISPLAY], DEFAULTS).bounds, { x: 0, y: 0, width: 1920, height: 1080 });
});

test("write/read round-trips through <dir>/window-state.json", async () => {
  const dir = await tempDir();
  const state = { x: 5, y: 6, width: 1000, height: 700, maximized: false };
  writeWindowState(dir, state);
  assert.deepEqual(readWindowState(dir), state);
});

test("a corrupt state file reads as null, not a crash", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, WINDOW_STATE_FILE), "{not json");
  assert.equal(readWindowState(dir), null);
});

test("a missing state file reads as null", async () => {
  assert.equal(readWindowState(await tempDir()), null);
});
