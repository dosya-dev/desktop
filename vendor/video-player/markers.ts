/** Position of a marker on the scrub bar as a 0..100 percentage. */
export function markerLeftPercent(ms: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0 || !Number.isFinite(ms)) return 0;
  const pct = (ms / 1000 / durationSec) * 100;
  return Math.min(100, Math.max(0, pct));
}
