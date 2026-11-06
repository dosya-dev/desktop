import { test } from "node:test";
import assert from "node:assert/strict";
import { createSwipeTracker, swipeDirection, SWIPE_IDLE_MS, type WheelSample } from "./swipe-nav.ts";

const sample = (over: Partial<WheelSample>): WheelSample => ({
  deltaX: 0, deltaY: 0, inverted: true, ctrlKey: false, shiftKey: false, scrollableX: false, time: 0, ...over,
});

/** Feeds a swipe as 10 wheel events 16 ms apart and returns what fired. */
function swipe(feed: ReturnType<typeof createSwipeTracker>, deltaX: number, start = 0, extra: Partial<WheelSample> = {}) {
  const fired = [];
  for (let i = 0; i < 10; i++) {
    const r = feed(sample({ deltaX, time: start + i * 16, ...extra }));
    if (r.fire) fired.push(r.fire);
  }
  return fired;
}

test("fingers moving right go back, under natural scrolling and without it", () => {
  assert.equal(swipeDirection(-50, true), "back");
  assert.equal(swipeDirection(50, false), "back");
  assert.equal(swipeDirection(50, true), "forward");
});

test("a two-finger swipe right fires back exactly once, momentum included", () => {
  const feed = createSwipeTracker();
  assert.deepEqual(swipe(feed, -30), ["back"]);
});

test("a new swipe after a pause fires again", () => {
  const feed = createSwipeTracker();
  swipe(feed, -30);
  assert.deepEqual(swipe(feed, 30, 160 + SWIPE_IDLE_MS + 1), ["forward"]);
});

test("a short nudge only reports progress", () => {
  const feed = createSwipeTracker();
  const r = feed(sample({ deltaX: -70 }));
  assert.equal(r.fire, null);
  assert.equal(r.dir, "back");
  assert.ok(r.progress > 0.4 && r.progress < 0.6);
});

test("vertical scrolling, pinch, Shift+wheel and sideways-scrolling content never navigate", () => {
  for (const extra of [{ deltaY: 80 }, { ctrlKey: true }, { shiftKey: true }, { scrollableX: true }]) {
    const feed = createSwipeTracker();
    assert.deepEqual(swipe(feed, -30, 0, extra), [], JSON.stringify(extra));
  }
});
