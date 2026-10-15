/**
 * Throttle with a guaranteed trailing run. The first call runs at once; calls
 * inside the window are collapsed into one run at the window's end, carrying
 * the latest value. A trailing debounce would reset its timer on every event
 * and could starve forever during a busy sync; this always lands within `ms`.
 * (The tray has the same logic inline; this is the shared, tested form.)
 */
export function throttleTrailing<T>(
  fn: (value: T) => void,
  ms: number,
  clock: { now: () => number; setTimer: (fn: () => void, ms: number) => unknown } = {
    now: Date.now,
    setTimer: (f, d) => setTimeout(f, d),
  },
): (value: T) => void {
  let lastRun = -Infinity;
  let pending = false;
  let latest: T;
  return (value: T) => {
    latest = value;
    const since = clock.now() - lastRun;
    if (since >= ms) {
      lastRun = clock.now();
      fn(latest);
      return;
    }
    if (pending) return;
    pending = true;
    clock.setTimer(() => {
      pending = false;
      lastRun = clock.now();
      fn(latest);
    }, ms - since);
  };
}
