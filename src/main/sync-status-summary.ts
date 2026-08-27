/**
 * One-line summary of overall sync health, shared by the tray context menu
 * and the tray tooltip so the two can never disagree about what state the
 * app is in. Priority: a deliberate pause always wins, then real errors,
 * then active work, then a partial pause, else everything is caught up.
 */
export function summarizeSyncStatus(status: {
  pairs: { status: string }[];
  activeTransfers: unknown[];
  globalPaused: boolean;
}): string {
  const { pairs, activeTransfers, globalPaused } = status;
  const errors = pairs.filter((p) => p.status === "error").length;
  const paused = pairs.filter((p) => p.status === "paused").length;
  const syncing = pairs.filter((p) => p.status === "syncing").length;
  const transferCount = activeTransfers.length;

  if (globalPaused || (paused > 0 && paused === pairs.length)) return "Paused";
  if (errors > 0) return `${errors} error${errors > 1 ? "s" : ""}`;
  if (syncing > 0 || transferCount > 0)
    return `Syncing ${transferCount} file${transferCount !== 1 ? "s" : ""}…`;
  if (paused > 0) return `${paused} paused`;
  return "All synced";
}
