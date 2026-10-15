/**
 * The About window's words, kept apart from the page so they unit-test
 * without a DOM and so App.tsx's lazyPage sees a module that exports only
 * the component.
 */
export type UpdateState =
  | { state: "idle" } | { state: "checking" } | { state: "available"; version: string }
  | { state: "downloading"; percent: number } | { state: "ready"; version: string }
  | { state: "installing"; version: string }
  | { state: "error"; message: string } | { state: "not-available" } | { state: "store-managed" };

const CHANNEL_NAMES: Record<string, string> = {
  direct: "Direct download",
  mas: "Mac App Store",
  "ms-store": "Microsoft Store",
  snap: "Snap Store",
};

export function channelName(distribution: string): string {
  return CHANNEL_NAMES[distribution] ?? distribution;
}

export interface SyncSummaryInput {
  pairs: { status: string }[];
  globalPaused: boolean;
  activeTransfers: unknown[];
  fileErrorCount?: number;
}

/** One line for the Sync row, from the engine's status. */
export function syncLine(status: SyncSummaryInput | null): string {
  if (!status || status.pairs.length === 0) return "No folders";
  const n = status.pairs.length;
  const folders = `${n} folder${n === 1 ? "" : "s"}`;
  if (status.globalPaused) return `Paused · ${folders}`;
  const errors = status.pairs.filter((p) => p.status === "error" || p.status === "offline").length;
  if (errors > 0) return `${errors} with errors · ${folders}`;
  if (status.pairs.some((p) => p.status === "syncing") || status.activeTransfers.length > 0) return `Syncing · ${folders}`;
  if ((status.fileErrorCount ?? 0) > 0) return `${status.fileErrorCount} files not synced · ${folders}`;
  return `All synced · ${folders}`;
}

/** The update button's label and action for this build and state. */
export function updateButton(
  distribution: string,
  update: UpdateState | null,
): { label: string; action: "check" | "install" | "store" | null; busy: boolean } {
  if (distribution === "snap") return { label: "", action: null, busy: false };
  if (distribution !== "direct") return { label: `Open ${channelName(distribution)}`, action: "store", busy: false };
  if (update?.state === "ready") return { label: "Restart to Update", action: "install", busy: false };
  if (update?.state === "installing") return { label: "Installing…", action: null, busy: true };
  const busy = update?.state === "checking" || update?.state === "downloading";
  const label = update?.state === "downloading"
    ? `Downloading ${update.percent}%`
    : update?.state === "checking" ? "Checking…" : "Check for Updates";
  return { label, action: "check", busy };
}

export function updateHint(update: UpdateState | null): string | null {
  switch (update?.state) {
    case "not-available": return "You're up to date";
    case "available": return `Version ${update.version} is available`;
    case "ready": return `Version ${update.version} is ready to install`;
    case "installing": return `Installing version ${update.version}, dosya will reopen in a moment`;
    case "error": return `Update check failed: ${update.message}`;
    default: return null;
  }
}
