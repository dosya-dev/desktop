import type { RendererDistribution } from "./use-distribution";

export type PickedFolder = { path: string; bookmark?: string };
export type FolderPicker = (opts?: { defaultPath?: string }) => Promise<PickedFolder | null>;

/**
 * Resolve the folder for a new sync pair from either the Browse button (no
 * preset) or a Quick backup preset.
 *
 * Outside the Mac App Store build a preset is the answer by itself. Inside
 * the sandbox a path alone grants nothing, so the preset only steers the
 * picker: macOS returns the security-scoped bookmark alongside the path and
 * that bookmark is what keeps the folder reachable after a relaunch. While the
 * distribution is still unknown the picker is used too, because a pair
 * created without a bookmark on the store build would start unusable.
 */
export async function chooseSyncFolder({
  distribution,
  preset,
  pick,
}: {
  distribution: RendererDistribution | null;
  preset?: string;
  pick: FolderPicker;
}): Promise<PickedFolder | null> {
  if (preset && distribution !== null && distribution !== "mas") return { path: preset };
  return pick(preset ? { defaultPath: preset } : undefined);
}
