import { test } from "node:test";
import assert from "node:assert/strict";
import { throttleTrailing } from "./throttle.ts";

/** A fake clock whose timers fire only when `advance` reaches them. */
function fakeClock() {
  let now = 0;
  const timers: { at: number; fn: () => void }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => { timers.push({ at: now + ms, fn }); return timers.length; },
    advance(ms: number) {
      now += ms;
      for (const t of timers.splice(0).sort((a, b) => a.at - b.at)) {
        if (t.at <= now) t.fn(); else timers.push(t);
      }
    },
  };
}

test("the first call runs at once and later calls in the window collapse into one trailing run", () => {
  const clock = fakeClock();
  const seen: string[] = [];
  const run = throttleTrailing((v: string) => seen.push(v), 1000, clock);
  run("a");
  assert.deepEqual(seen, ["a"]);
  run("b");
  run("c");
  assert.deepEqual(seen, ["a"], "nothing more until the window closes");
  clock.advance(999);
  assert.deepEqual(seen, ["a"]);
  clock.advance(1);
  assert.deepEqual(seen, ["a", "c"], "the trailing run carries the latest value, never an intermediate one");
});

test("a call after a quiet window runs immediately again", () => {
  const clock = fakeClock();
  const seen: number[] = [];
  const run = throttleTrailing((v: number) => seen.push(v), 500, clock);
  run(1);
  clock.advance(2000);
  run(2);
  assert.deepEqual(seen, [1, 2]);
});
