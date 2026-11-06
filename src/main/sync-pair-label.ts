import type { T } from "../i18n/translator";
import { isolate } from "../i18n/bidi.ts";

/**
 * Display names for a sync pair. The pair config stores its folder and
 * workspace names as text, and the app itself writes two of them: "Root"
 * when the pair syncs the workspace root, and "Workspace" when no workspace
 * name was known at the time. Both stay stored in English (translating them
 * would freeze one language into the config). "Root" on a root pair is shown
 * in the chosen language here; "Workspace" is shown as stored, since it
 * cannot be told apart from a workspace really named that. Every other name
 * is user content and shows as stored.
 *
 * Electron-free, shared by the tray (main) and the Sync page and dashboard
 * (renderer), so node --test can load it.
 */

/** Stored as remoteFolderName for a pair on the workspace root. */
export const DEFAULT_ROOT_FOLDER_NAME = "Root";
/** Stored as workspaceName when the active workspace's name was not known. */
export const DEFAULT_WORKSPACE_NAME = "Workspace";

/**
 * The folder name to show. `isRoot` comes from the pair config
 * (remoteFolderId === null): a folder the user really named "Root" is
 * shown as stored.
 */
export function pairFolderLabel(name: string, isRoot: boolean, t: T): string {
  return isRoot && name === DEFAULT_ROOT_FOLDER_NAME ? t("sync.label.root") : name;
}

/** Whether this pair could be showing the root default, so the config is worth reading. */
export function mayShowDefaultName(pair: { remoteFolderName: string }): boolean {
  return pair.remoteFolderName === DEFAULT_ROOT_FOLDER_NAME;
}

/** The ids of the pairs that sync a workspace root, from the pair config. */
export function rootPairIds(pairs: readonly { id: string; remoteFolderId?: string | null }[]): Set<string> {
  return new Set(pairs.filter((p) => p.remoteFolderId == null).map((p) => p.id));
}

/**
 * A name from the pair config (user content, often Latin) inside native menu
 * text: wrapped so it keeps its own order in a right-to-left sentence. Left to
 * right, and for an empty name, it comes back untouched.
 */
export function isolatePairName(name: string, dir: "ltr" | "rtl"): string {
  return dir === "rtl" ? isolate(name) : name;
}
