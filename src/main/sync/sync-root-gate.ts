/**
 * The main-process gate on a renderer-supplied sync root (sync:add-pair,
 * sync:update-pair's localPath, sync:estimate-local-folder).
 *
 * Two independent conditions, both required:
 *  1. the user picked this folder in the native picker in this session
 *     (picked-folders.ts) - the renderer cannot name a directory by itself;
 *  2. the folder is not one no sync root may ever be: a drive root, the home
 *     folder or anything containing it, a system tree, or a credential /
 *     autostart folder (system-paths.ts). Checked on the path as given AND on
 *     its real path, so a symlink cannot smuggle ~/.ssh in under another name.
 *
 * Pure (everything injected) so node --test can load it.
 */
import { isAbsolute, resolve } from "path";
import type { PickedFolders } from "./picked-folders";
import { forbiddenSyncRootReason } from "./system-paths.ts";

export interface SyncRootGateDeps {
  picked: Pick<PickedFolders, "has">;
  platform: NodeJS.Platform;
  home: string;
  tmpDir?: string;
  /** fs.realpathSync, or null when the path cannot be resolved (missing). */
  realpath: (p: string) => string | null;
}

export const NOT_PICKED_MESSAGE =
  "Choose the folder with Browse first - a sync folder can only be one you picked in this window.";

/** null when the path may be used as a sync root, otherwise the reason it may not. */
export function syncRootRefusal(path: unknown, deps: SyncRootGateDeps): string | null {
  if (typeof path !== "string" || path.length === 0 || path.length > 1000) {
    return "Invalid localPath: must be a non-empty string";
  }
  if (!isAbsolute(path)) return "localPath must be an absolute path";
  const forbidden =
    forbiddenSyncRootReason(resolve(path), deps.platform, deps.home, deps.tmpDir) ??
    (() => {
      const real = deps.realpath(path);
      if (!real) return null;
      // Compared in real-path space throughout: macOS's $TMPDIR is
      // /var/folders/..., which really lives at /private/var/folders/...
      const realTmp = deps.tmpDir ? (deps.realpath(deps.tmpDir) ?? deps.tmpDir) : undefined;
      const realHome = deps.realpath(deps.home) ?? deps.home;
      return forbiddenSyncRootReason(real, deps.platform, realHome, realTmp);
    })();
  if (forbidden) return forbidden;
  if (!deps.picked.has(path)) return NOT_PICKED_MESSAGE;
  return null;
}

/**
 * The global sync settings the renderer may change through sync:save-config.
 * Anything else - above all `pairs`, which the engine would Object.assign into
 * the saved config and start on the next launch, and `userId` - is dropped, so
 * this channel can never become a way round the sync-root gate.
 */
export const RENDERER_CONFIG_KEYS = [
  "globalPollIntervalMs",
  "maxConcurrentTransfers",
  "maxUploadBytesPerSec",
  "maxDownloadBytesPerSec",
  "pauseOnBattery",
] as const;

export function pickRendererConfig(updates: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of RENDERER_CONFIG_KEYS) {
    if (Object.prototype.hasOwnProperty.call(updates, k)) out[k] = updates[k];
  }
  return out;
}
