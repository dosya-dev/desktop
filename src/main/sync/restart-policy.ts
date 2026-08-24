/**
 * How the supervisor reacts when the isolated sync engine dies.
 *
 * The whole point of Phase 6 is that an engine crash is survivable, so the
 * default answer is "restart it". The exception is an engine that cannot boot
 * at all - a corrupt index, a failed migration, a bad build - which would
 * otherwise fork in a tight loop and burn a core for as long as the app is
 * open. Three crashes inside a minute is the line: past it the engine is
 * parked and the failure is shown to the user instead of hidden behind an
 * infinite retry.
 *
 * This is pure arithmetic with an injected clock, deliberately: the escalation
 * ladder is the part most likely to be wrong, and it should be provable without
 * forking a process or waiting a real minute.
 *
 * Leaf module: no imports, because `node --test` strips types only and a
 * directly-loaded test module cannot pull values from its siblings.
 */

export interface RestartDecision {
  action: "restart" | "park";
  /** Milliseconds to wait before re-forking. 0 for the first crash. */
  delayMs: number;
  /** Crashes counted inside the window, including this one. */
  recentCrashes: number;
}

export const CRASH_WINDOW_MS = 60_000;
export const MAX_CRASHES_IN_WINDOW = 3;

/**
 * Indexed by crash number within the window. The first crash restarts at once
 * because the overwhelmingly common case is a one-off (an OOM on a huge tree,
 * a driver hiccup) and making the user wait for that would be gratuitous.
 */
export const RESTART_DELAYS_MS = [0, 1_000, 5_000];

/** How long a child must stay up before its run counts as healthy. */
export const HEALTHY_AFTER_MS = 60_000;

export class RestartPolicy {
  private crashes: number[] = [];
  private isParked = false;

  /**
   * Record a crash and decide what to do about it.
   *
   * @param now - injected clock so tests never sleep.
   */
  recordCrash(now: number): RestartDecision {
    if (this.isParked) {
      return { action: "park", delayMs: 0, recentCrashes: this.crashes.length };
    }

    // Drop anything that has aged out before counting. A crash exactly
    // CRASH_WINDOW_MS old is outside the window, not on its edge.
    this.crashes = this.crashes.filter((t) => now - t < CRASH_WINDOW_MS);
    this.crashes.push(now);

    const recentCrashes = this.crashes.length;
    if (recentCrashes >= MAX_CRASHES_IN_WINDOW) {
      this.isParked = true;
      return { action: "park", delayMs: 0, recentCrashes };
    }

    const rung = Math.min(recentCrashes - 1, RESTART_DELAYS_MS.length - 1);
    return { action: "restart", delayMs: RESTART_DELAYS_MS[rung]!, recentCrashes };
  }

  /**
   * Mark the current run healthy, clearing the ladder.
   *
   * Without this an app left open for a week would accumulate three unrelated
   * crashes and park itself, which is not what "three crashes in a minute"
   * means. Deliberately does NOT un-park: a parked engine never ran long
   * enough to earn this call, so reaching it in that state would be a bug
   * worth keeping visible rather than papering over.
   */
  recordHealthy(_now: number): void {
    if (this.isParked) return;
    this.crashes = [];
  }

  get parked(): boolean {
    return this.isParked;
  }

  /** Full reset, for an explicit user-driven retry. */
  reset(): void {
    this.crashes = [];
    this.isParked = false;
  }
}
