// apps/desktop/src/renderer/lib/storage-percent.ts
//
// One rule for every storage meter (sidebar, dashboard, workspace dashboard,
// family pool). Each used to round used/cap to a whole percent on its own, so
// 2 MB of 5 GB read "0%" with an empty-looking bar: the account looked unused.
// Node-safe on purpose (no imports): node:test loads it directly.

/** The smallest bar that still reads as "something is here". */
export const MIN_SLIVER_PX = 4;

export interface StoragePercent {
  /** Whole percent, 0-100, for thresholds (quota colours). */
  pct: number;
  /** What to show before the "%" sign: "<1" when used is above zero but rounds to 0. */
  label: string;
  /** CSS width for the bar fill: 0 when nothing is used, never thinner than a sliver otherwise. */
  barWidth: string;
}

export function storagePercent(used: number, cap: number): StoragePercent {
  if (!(cap > 0) || !(used > 0)) return { pct: 0, label: "0", barWidth: "0%" };
  const exact = Math.min(100, (used / cap) * 100);
  const pct = Math.round(exact);
  return {
    pct,
    label: pct === 0 ? "<1" : String(pct),
    barWidth: `max(${Number(exact.toFixed(4))}%, ${MIN_SLIVER_PX}px)`,
  };
}
