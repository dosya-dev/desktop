/**
 * When a sync run has finished, expressed as a pure function so it can be
 * tested without a store, a query client or a DOM.
 *
 * The sync engine lives in the main process and writes files the renderer never
 * hears about, so a file pulled down while the Files page was open used to stay
 * invisible until that page's data went stale on a timer. sync-store calls this
 * on every status tick and invalidates the file queries when it returns true.
 */

/** Just the parts of a pair's status this decision needs. */
export interface SettledPair {
  pairId: string;
  status: string;
}

export interface SettledStatus {
  pairs: SettledPair[];
}

/**
 * True when at least one pair that was syncing no longer is.
 *
 * Deliberately an edge, not a state. `syncing` ticks repeatedly through a
 * single batch - progress counters change on every file - so reacting to the
 * state itself would refetch the listing continuously for the length of a large
 * transfer. The transition is the moment new files exist server-side and the
 * listing is actually worth asking for again.
 */
export function syncJustSettled(
  prev: SettledStatus | null | undefined,
  next: SettledStatus,
): boolean {
  if (!prev) return false;
  const wasSyncing = new Set(
    prev.pairs.filter((p) => p.status === "syncing").map((p) => p.pairId),
  );
  if (wasSyncing.size === 0) return false;
  return next.pairs.some((p) => wasSyncing.has(p.pairId) && p.status !== "syncing");
}
