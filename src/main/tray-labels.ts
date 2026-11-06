import { isolatePairName } from "./sync-pair-label.ts";

/**
 * Pure label builders for the tray menu, loadable by node:test.
 *
 * The workspace and folder names are user content. In a right-to-left
 * language the whole "workspace/folder" path is one isolated unit, so the
 * slash and a Latin name keep their order inside an Arabic or Hebrew row.
 */

/** One pair row: indented, state icon, the path, then " - state" when there is a state word. */
export function trayPairLabel(icon: string, workspace: string, folder: string, text: string, dir: "ltr" | "rtl"): string {
  return `  ${icon} ${isolatePairName(`${workspace}/${folder}`, dir)}${text ? ` - ${text}` : ""}`;
}

/** A folder name as an item of the open-sync-folder submenu. */
export const trayFolderName = (folder: string, dir: "ltr" | "rtl"): string => isolatePairName(folder, dir);
