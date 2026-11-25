import type { RendererDistribution } from "./use-distribution";

export type PickedFolder = { path: string; bookmark?: string };
export type FolderPicker = (opts?: { defaultPath?: string }) => Promise<PickedFolder | null>;

/**
 * Resolve the folder for a new sync pair from either the Browse button (no
 * preset) or a Quick backup preset.
 *
 * A preset only steers the native picker (it opens AT that folder); the user
 * still confirms it there, on every build. Two reasons:
 *  - the main process accepts a sync root only if the user chose it in that
 *    picker this session (main/sync/picked-folders.ts), so the renderer -
 *    which also runs remote script - can never name a folder by itself;
 *  - inside the Mac App Store sandbox a path alone grants nothing, and the
 *    picker returns the security-scoped bookmark that keeps the folder
 *    reachable after a relaunch.
 *
 * `distribution` is kept in the signature for callers; it no longer changes
 * the outcome.
 */
export async function chooseSyncFolder({
  preset,
  pick,
}: {
  distribution?: RendererDistribution | null;
  preset?: string;
  pick: FolderPicker;
}): Promise<PickedFolder | null> {
  return pick(preset ? { defaultPath: preset } : undefined);
}
