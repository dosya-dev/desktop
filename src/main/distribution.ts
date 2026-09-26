/**
 * Which channel this running copy of the app was installed from.
 *
 * The same build tree ships four ways, and the channel decides who owns
 * updates: a direct download updates itself through electron-updater, while
 * every store forbids an app fetching executable code from outside the store
 * and runs its own update pipeline that would race ours for the same install.
 * There is deliberately no build-time flag for this - a flag has to be kept in
 * sync with the packaging matrix, and the signals below are set by the
 * platform itself, cost nothing, and are false everywhere else.
 *
 *   ms-store  Electron sets process.windowsStore only when the app runs inside
 *             an AppX/MSIX container.
 *   snap      snapd exports SNAP and SNAP_NAME to every process of a snap.
 *             SNAP_NAME is checked against our own name so an AppImage launched
 *             from a terminal that itself runs inside some other snap is not
 *             mistaken for a Snap Store install (that would silently disable
 *             its updates).
 *   mas       Electron sets process.mas for a Mac App Store build. Not shipped
 *             yet; recognised now so nothing here needs rewiring when it is.
 *
 * Pure: no Electron import, so Node's test runner covers every branch.
 */

export type Distribution = "direct" | "ms-store" | "snap" | "mas";

/** The name registered on the Snap Store; must match electron-builder.yml `snap.name`. */
export const SNAP_NAME = "dosya";

export interface DistributionSignals {
  /** `process.windowsStore` */
  windowsStore?: boolean;
  /** `process.mas` */
  mas?: boolean;
  /** `process.env` or a test's stand-in */
  env: Record<string, string | undefined>;
}

export function detectDistribution(signals: DistributionSignals): Distribution {
  if (signals.windowsStore === true) return "ms-store";
  if (signals.mas === true) return "mas";
  if (signals.env.SNAP && signals.env.SNAP_NAME === SNAP_NAME) return "snap";
  return "direct";
}

/** True when a store, not electron-updater, delivers updates for this install. */
export function isStoreManaged(distribution: Distribution): boolean {
  return distribution !== "direct";
}

/** Human name of the store, for the Settings > Updates copy. */
export function storeDisplayName(distribution: Distribution): string | null {
  switch (distribution) {
    case "ms-store": return "Microsoft Store";
    case "snap": return "Snap Store";
    case "mas": return "Mac App Store";
    default: return null;
  }
}

/**
 * Where "open the store's update page" should go, or null when the store has
 * no such page: snapd refreshes in the background on its own schedule and
 * offers nothing to click, so the snap build shows no button at all.
 */
export function storeUpdatesUrl(distribution: Distribution): string | null {
  switch (distribution) {
    // The Store's own "Downloads and updates" pane, where a Store user
    // actually triggers an update check.
    case "ms-store": return "ms-windows-store://downloadsandupdates";
    case "mas": return "macappstore://showUpdatesPage";
    default: return null;
  }
}
