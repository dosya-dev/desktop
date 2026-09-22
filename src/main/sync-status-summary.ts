/**
 * One-line summary of overall sync health, shared by the tray context menu
 * and the tray tooltip so the two can never disagree about what state the
 * app is in. Priority: a deliberate pause always wins, then real errors, then
 * a folder waiting on the user, then active work, then files that failed to
 * sync, then a partial pause, else everything is caught up.
 *
 * `fileErrorCount` is the fix for the 2026-09-02 field report: a pair ends
 * its cycle "idle" even when files were left in the error ledger, so the old
 * status-only check read "All synced" over a folder that was not. It is
 * optional only so an older status shape (no count) degrades to the previous
 * behaviour rather than crashing the tray.
 */
export function summarizeSyncStatus(status: {
  pairs: { status: string }[];
  activeTransfers: unknown[];
  globalPaused: boolean;
  fileErrorCount?: number;
  /** A platform switch paused this surface - see remote-client.ts's
   *  MaintenanceError. Outranks every other state: the pairs it drove
   *  offline are not really erroring or waiting on the user, and retrying
   *  them faster will not help. */
  maintenance?: boolean;
}): string {
  if (status.maintenance) return "Sync paused · maintenance";
  const { pairs, activeTransfers, globalPaused } = status;
  const errors = pairs.filter((p) => p.status === "error").length;
  const paused = pairs.filter((p) => p.status === "paused").length;
  const syncing = pairs.filter((p) => p.status === "syncing").length;
  const attention = pairs.filter((p) => p.status === "needs-confirmation").length;
  const offline = pairs.filter((p) => p.status === "offline").length;
  const transferCount = activeTransfers.length;
  const failedFiles = status.fileErrorCount ?? 0;

  if (globalPaused || (paused > 0 && paused === pairs.length)) return "Paused";
  if (errors > 0) return `${errors} error${errors > 1 ? "s" : ""}`;
  // Offline outranks everything below it, including files that failed to
  // sync: the network is WHY they failed, and "All synced" over a machine
  // that cannot reach the server is the exact claim this all exists to stop.
  if (offline > 0) return offline === pairs.length ? "Offline" : `${offline} offline`;
  if (attention > 0) return `${attention} folder${attention > 1 ? "s" : ""} need${attention > 1 ? "" : "s"} attention`;
  if (syncing > 0 || transferCount > 0)
    return `Syncing ${transferCount} file${transferCount !== 1 ? "s" : ""}…`;
  if (failedFiles > 0) return `${failedFiles} file${failedFiles !== 1 ? "s" : ""} not synced`;
  if (paused > 0) return `${paused} paused`;
  return "All synced";
}
