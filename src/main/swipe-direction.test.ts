import { test } from "node:test";
import assert from "node:assert/strict";
import { swipeToHistory } from "./swipe-direction.ts";

/** Run with `npm run test:unit`. macOS three-finger swipe -> history, mirrored in RTL. */

test("left to right: a right swipe goes back, a left swipe goes forward (as before)", () => {
  assert.equal(swipeToHistory("right", "ltr"), "back");
  assert.equal(swipeToHistory("left", "ltr"), "forward");
});

test("right to left: the same swipes are mirrored", () => {
  assert.equal(swipeToHistory("right", "rtl"), "forward");
  assert.equal(swipeToHistory("left", "rtl"), "back");
});

test("vertical swipes do nothing in either direction", () => {
  for (const dir of ["ltr", "rtl"] as const) {
    assert.equal(swipeToHistory("up", dir), null);
    assert.equal(swipeToHistory("down", dir), null);
    assert.equal(swipeToHistory("", dir), null);
  }
});
