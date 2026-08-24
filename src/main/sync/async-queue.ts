/**
 * Backpressure: makes a fast producer wait for a slow consumer.
 *
 * The scanner can enumerate a tree far faster than the network can upload it.
 * Without a brake, planned work piles up without limit - which is how the
 * ops table would grow to half a million rows while the uplink is still
 * working through the first thousand, and how "memory is O(queue depth)"
 * stops being true.
 *
 * Two marks rather than one, so the producer is not woken on every single
 * completion: it stops at `high` and is not released until the queue has
 * drained to `low`.
 *
 * Recovery is event-driven, never polled: `remove()` is what resolves the
 * waiters, so there are no timers, no wasted wake-ups while busy, and no
 * added latency once the queue drains.
 *
 * Pure and dependency-free so `node --test` can load it directly.
 */

export interface WaterMarks {
  /** Producer stops once the queue is at least this deep. */
  high: number;
  /** ...and resumes once it has drained to this. */
  low: number;
}

export class Backpressure {
  private readonly high: number;
  private readonly low: number;
  private count = 0;
  private isPaused = false;
  private released = false;
  private waiters: (() => void)[] = [];

  // Explicit field declarations, not constructor parameter properties: the
  // test runner strips types without transforming and rejects those.
  constructor(marks: WaterMarks) {
    this.high = Math.max(1, marks.high);
    this.low = Math.max(0, Math.min(marks.low, this.high - 1));
  }

  get depth(): number {
    return this.count;
  }

  get paused(): boolean {
    return this.isPaused;
  }

  /** Producer: `n` more items are now in flight. */
  add(n: number): void {
    if (n <= 0) return;
    this.count += n;
    if (this.count >= this.high) this.isPaused = true;
  }

  /** Consumer: `n` items are finished. Releases the producer at the low mark. */
  remove(n: number): void {
    if (n <= 0) return;
    this.count = Math.max(0, this.count - n);
    if (this.isPaused && this.count <= this.low) this.wake();
  }

  /** Resolves at once unless paused; otherwise once the queue drains to `low`. */
  waitUntilDrained(): Promise<void> {
    if (!this.isPaused || this.released) return Promise.resolve();
    return new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  /**
   * Unblock everything and stay unblocked - for pause, stop and teardown. A
   * scanner parked on a queue that will never drain would hang the pair.
   */
  release(): void {
    this.released = true;
    this.wake();
  }

  private wake(): void {
    this.isPaused = false;
    const waiting = this.waiters;
    this.waiters = [];
    for (const resolve of waiting) resolve();
  }
}
