/**
 * Memoizes the per-pair op-queue counts getStatus() reads.
 *
 * `countOpsByState` is `SELECT COUNT(*) FROM ops WHERE pair_id=? AND state=?`,
 * which SQLite must answer by walking every matching index entry - 14.22 ms at
 * 500 000 queued ops (measured). `emitStatus()` called it at up to 2 Hz per
 * pair, and only while `rt.syncing`, i.e. exactly when the queue is deepest:
 * 85 ms/s with three pairs, and on the Mac App Store build that runs on the
 * MAIN process's event loop (DSK-005).
 *
 * A TTL window is the contained fix. `pendingFileCount` genuinely needs the
 * queued count (it is the truth for push-mode pairs), and the exact-tally
 * alternative would have to thread a pairId through `completeOp(id)`/
 * `failOp(id)`, which take an op id - a change that ripples into the engine
 * for a number the user glances at. The visible progress counters
 * (totalFilesInBatch / completedFilesInBatch) still move at the full rate; only
 * the push-mode queue depth lags by up to `ttlMs`.
 *
 * No electron imports: this is a pure leaf so plain `node --test` can load it.
 */
export function createOpCountCache(ttlMs: number, now: () => number = Date.now) {
  const entries = new Map<string, { at: number; value: number }>();
  return {
    get(pairId: string, compute: () => number): number {
      const hit = entries.get(pairId);
      const t = now();
      if (hit && t - hit.at < ttlMs) return hit.value;
      const value = compute();
      entries.set(pairId, { at: t, value });
      return value;
    },
    drop(pairId: string): void { entries.delete(pairId); },
    clear(): void { entries.clear(); },
  };
}

export type OpCountCache = ReturnType<typeof createOpCountCache>;
