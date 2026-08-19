/**
 * Squirrel.Mac never clears a failed pending install, and ShipIt resumes it
 * forever - force-moving the stale staged bundle over whatever is in
 * /Applications (the "2.4.9 keeps coming back" incident). If this app is
 * running, any surviving pending state is by definition stale: a successful
 * install consumes it before relaunch.
 *
 * Deleting the cache files is not enough. Squirrel submits ShipIt as a
 * launchd job that outlives the app, the caches, and the deleted state
 * plist, sitting in "spawn scheduled" until its program path exists again.
 * The moment a fresh dosya.app lands in /Applications, launchd spawns ShipIt
 * from the new still-quarantined bundle, and macOS Sequoia hard-denies
 * launchd-spawned quarantined executables with "Apple could not verify
 * 'dosya' is free of malware" - before the user has opened the app at all
 * (the 2026-08-19 incident). So the job must be booted out too, and
 * unconditionally: the cache directory being gone says nothing about the
 * job still being loaded.
 *
 * Side effects are injected (same DI pattern as window-state.ts) so the
 * whole chain is unit-testable without Electron.
 */
import { join } from "path";
import { existsSync, readdirSync, rmSync } from "fs";

/** appId from electron-builder.yml - names both the cache dir and the launchd job. */
export const SHIPIT_JOB_LABEL = "dev.dosya.desktop.ShipIt";

export interface ShipItCleanupDeps {
  platform: NodeJS.Platform;
  isPackaged: boolean;
  /** ~/Library/Caches */
  cachesDir: string;
  /** process.getuid() - null when unavailable, which skips the bootout. */
  uid: number | null;
  /** Runs `launchctl bootout <target>`; failure (job not loaded) is expected. */
  bootoutJob: (domainTarget: string) => void;
}

export function discardStaleShipItState(deps: ShipItCleanupDeps): void {
  if (deps.platform !== "darwin" || !deps.isPackaged) return;

  if (deps.uid !== null) {
    try {
      deps.bootoutJob(`gui/${deps.uid}/${SHIPIT_JOB_LABEL}`);
    } catch {
      // Job not loaded, or launchctl unavailable - nothing to unstick.
    }
  }

  try {
    const shipItDir = join(deps.cachesDir, SHIPIT_JOB_LABEL);
    if (!existsSync(shipItDir)) return;
    const state = join(shipItDir, "ShipItState.plist");
    if (existsSync(state)) rmSync(state, { force: true });
    for (const entry of readdirSync(shipItDir)) {
      if (entry.startsWith("update.")) {
        rmSync(join(shipItDir, entry), { recursive: true, force: true });
      }
    }
  } catch {
    // Cache cleanup must never block startup.
  }
}
