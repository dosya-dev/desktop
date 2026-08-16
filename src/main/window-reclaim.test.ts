import { test } from "node:test";
import assert from "node:assert/strict";

import { createWindowReclaimer } from "./window-reclaim.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron. The
 * reclaimer is the decision logic behind destroy-on-hide: WHEN a hidden
 * window's renderer should be torn down to give its memory back. It takes the
 * clock and the window probes as injected functions so the timing can be
 * driven synchronously here; src/main/index.ts wires the real setTimeout and
 * BrowserWindow.
 */

/** Manual clock: timers fire only when the test says so. */
function fakeClock() {
  let nextId = 1;
  const pending = new Map<number, { fn: () => void; ms: number }>();
  return {
    schedule: (fn: () => void, ms: number): number => {
      const id = nextId++;
      pending.set(id, { fn, ms });
      return id;
    },
    cancel: (id: number): void => {
      pending.delete(id);
    },
    /** Fire every pending timer, as if its delay elapsed. */
    fire(): void {
      const entries = [...pending.values()];
      pending.clear();
      for (const { fn } of entries) fn();
    },
    pendingCount: () => pending.size,
    pendingDelays: () => [...pending.values()].map((p) => p.ms),
  };
}

function makeReclaimer(overrides: Partial<Parameters<typeof createWindowReclaimer>[0]> = {}) {
  const clock = fakeClock();
  let destroyed = 0;
  const reclaimer = createWindowReclaimer({
    delayMs: 5_000,
    isQuitting: () => false,
    isHidden: () => true,
    destroy: () => {
      destroyed++;
    },
    schedule: clock.schedule,
    cancel: clock.cancel,
    ...overrides,
  });
  return { clock, reclaimer, destroyedCount: () => destroyed };
}

test("destroys the window once the delay elapses while it is still hidden", () => {
  const { clock, reclaimer, destroyedCount } = makeReclaimer();

  reclaimer.onHide();
  assert.equal(destroyedCount(), 0, "must not destroy before the delay");
  assert.deepEqual(clock.pendingDelays(), [5_000], "timer must use the configured delay");

  clock.fire();
  assert.equal(destroyedCount(), 1);
});

test("a show before the delay cancels the destroy", () => {
  const { clock, reclaimer, destroyedCount } = makeReclaimer();

  reclaimer.onHide();
  reclaimer.onShow();
  clock.fire();

  assert.equal(destroyedCount(), 0);
  assert.equal(clock.pendingCount(), 0, "no timer may be left behind");
});

test("hide-show-hide destroys only after the LAST hide's delay", () => {
  const { clock, reclaimer, destroyedCount } = makeReclaimer();

  reclaimer.onHide();
  reclaimer.onShow();
  reclaimer.onHide();

  assert.equal(clock.pendingCount(), 1, "exactly one live timer");
  clock.fire();
  assert.equal(destroyedCount(), 1);
});

test("a duplicate hide never stacks a second destroy", () => {
  const { clock, reclaimer, destroyedCount } = makeReclaimer();

  reclaimer.onHide();
  reclaimer.onHide();

  assert.equal(clock.pendingCount(), 1, "second hide must replace the timer, not add one");
  clock.fire();
  assert.equal(destroyedCount(), 1);
});

test("never destroys while the app is quitting", () => {
  // before-quit's own shutdown owns the window then - a destroy underneath it
  // would race the sync-state flush.
  const { clock, reclaimer, destroyedCount } = makeReclaimer({ isQuitting: () => true });

  reclaimer.onHide();
  clock.fire();

  assert.equal(destroyedCount(), 0);
});

test("never destroys a window that became visible again without a show event", () => {
  // Belt-and-braces for visibility paths that bypass our listeners
  // (e.g. win.showInactive, or an OS-level restore).
  let hidden = true;
  const { clock, reclaimer, destroyedCount } = makeReclaimer({ isHidden: () => hidden });

  reclaimer.onHide();
  hidden = false;
  clock.fire();

  assert.equal(destroyedCount(), 0);
});

test("dispose cancels a pending destroy for good", () => {
  // Wired to the window's own "closed" event: a window closed for any other
  // reason must not leave a timer that later destroys its successor.
  const { clock, reclaimer, destroyedCount } = makeReclaimer();

  reclaimer.onHide();
  reclaimer.dispose();
  clock.fire();

  assert.equal(destroyedCount(), 0);
  assert.equal(clock.pendingCount(), 0);
});

test("hide after dispose is inert", () => {
  const { clock, reclaimer, destroyedCount } = makeReclaimer();

  reclaimer.dispose();
  reclaimer.onHide();

  assert.equal(clock.pendingCount(), 0);
  clock.fire();
  assert.equal(destroyedCount(), 0);
});

test("delayMs of zero disables reclaim entirely", () => {
  // DOSYA_WINDOW_RECLAIM_MS=0 is the documented off switch.
  const { clock, reclaimer, destroyedCount } = makeReclaimer({ delayMs: 0 });

  reclaimer.onHide();

  assert.equal(clock.pendingCount(), 0, "disabled reclaimer must schedule nothing");
  clock.fire();
  assert.equal(destroyedCount(), 0);
});
