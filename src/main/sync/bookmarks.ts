import { isMasBuild } from "../mas";

export type AccessHandle =
  | { ok: true; release: () => void }
  | { ok: false; reason: "no-bookmark" | "stale" };

/** The one Electron method this module needs. Narrow so tests can fake it. */
export type AppSeam = Pick<Electron.App, "startAccessingSecurityScopedResource">;

// Injected once at startup from src/main/index.ts. Kept as a seam so this
// module stays unit-testable without booting Electron.
let electronApp: AppSeam | null = null;
export function setElectronApp(app: AppSeam | null): void {
  electronApp = app;
}

/**
 * Take access to a sync folder for the lifetime of its watcher.
 *
 * Outside the Mac App Store build there is nothing to do: the app has plain
 * filesystem access and a saved absolute path is enough. Inside the sandbox a
 * saved path is inert, and only a security-scoped bookmark reopens the grant
 * the user gave when they picked the folder.
 *
 * Never throws. A pair whose bookmark will not resolve is reported so the
 * engine can surface "needs-permission", rather than failing silently - which
 * would be indistinguishable from sync being broken.
 */
export function acquireFolderAccess(bookmark: string | undefined): AccessHandle {
  if (!isMasBuild()) return { ok: true, release: () => {} };
  if (!bookmark) return { ok: false, reason: "no-bookmark" };
  if (!electronApp) return { ok: false, reason: "stale" };

  try {
    const stop = electronApp.startAccessingSecurityScopedResource(bookmark);
    let released = false;
    return {
      ok: true,
      release: () => {
        if (released) return;
        released = true;
        try {
          stop();
        } catch {
          // Already reclaimed by the OS - nothing left to release.
        }
      },
    };
  } catch {
    return { ok: false, reason: "stale" };
  }
}
