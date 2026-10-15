import { accessSync } from "node:fs";
import type { Distribution } from "../distribution";

export type AccessHandle =
  | { ok: true; release: () => void }
  | { ok: false; reason: "no-bookmark" | "stale" };

/** The one Electron method this module needs, narrowed so tests can fake it. */
export interface AppSeam {
  startAccessingSecurityScopedResource(bookmark: string): () => void;
}

/**
 * Can the folder be reached right now? Only used to decide whether a grant that
 * was just taken actually granted anything, so any failure - gone, renamed, on
 * an unmounted volume, still refused by the sandbox - is one answer: no.
 */
function defaultProbe(path: string): boolean {
  try {
    accessSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Take access to a sync folder for the lifetime of its watcher.
 *
 * Outside the Mac App Store build there is nothing to do: the app has plain
 * filesystem access and a saved absolute path is enough. Inside the sandbox a
 * saved path is inert, and only the security-scoped bookmark captured when
 * the user picked the folder reopens the grant.
 *
 * Never throws. A pair whose bookmark will not resolve is reported so the
 * engine can show "needs permission" with a reselect action, instead of a
 * failure indistinguishable from sync being broken.
 */
export function acquireFolderAccess(
  bookmark: string | undefined,
  {
    distribution,
    app,
    path,
    probe = defaultProbe,
  }: { distribution: Distribution; app: AppSeam | null; path: string; probe?: (path: string) => boolean },
): AccessHandle {
  if (distribution !== "mas") return { ok: true, release: () => {} };
  if (!bookmark) return { ok: false, reason: "no-bookmark" };
  if (!app) return { ok: false, reason: "stale" };

  let stop: () => void;
  try {
    stop = app.startAccessingSecurityScopedResource(bookmark);
  } catch {
    return { ok: false, reason: "stale" };
  }

  // Electron's startAccessingSecurityScopedResource does not promise to throw
  // for a bookmark that no longer resolves - it returns a stop function either
  // way. Without this probe such a pair reads as ok, the engine's own
  // access() a moment later fails, and the user is told "Sync folder not
  // found" with nothing to click, when the truth is the grant is gone and the
  // folder needs reselecting.
  if (!probe(path)) {
    try {
      stop();
    } catch {
      // Nothing was really held; there is nothing to report either.
    }
    return { ok: false, reason: "stale" };
  }

  let released = false;
  return {
    ok: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        stop();
      } catch {
        // Already reclaimed by the OS; nothing left to release.
      }
    },
  };
}
