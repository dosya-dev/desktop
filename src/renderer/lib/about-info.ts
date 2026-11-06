/**
 * The About window's words, kept apart from the page so they unit-test
 * without a DOM and so App.tsx's lazyPage sees a module that exports only
 * the component. Translated at call time through `tl` (relative `.ts`
 * imports, so node --test loads it without a bundler).
 */
import { tl } from "./locale-state.ts";
import type { MessageKey } from "../../i18n/keys.ts";
import type { T } from "../../i18n/translator.ts";

export type UpdateState =
  | { state: "idle" } | { state: "checking" } | { state: "available"; version: string }
  | { state: "downloading"; percent: number } | { state: "ready"; version: string }
  | { state: "installing"; version: string }
  | { state: "error"; message: string } | { state: "not-available" } | { state: "store-managed" };

const CHANNEL_NAMES: Record<string, MessageKey> = {
  direct: "about.label.directDownload",
  mas: "common.label.macAppStore",
  "ms-store": "common.label.microsoftStore",
  snap: "common.label.snapStore",
};

/** `tr` defaults to the chosen language; Copy Details passes English. */
export function channelName(distribution: string, tr: T = tl): string {
  const key = CHANNEL_NAMES[distribution];
  return key ? tr(key) : distribution;
}

export interface SyncSummaryInput {
  pairs: { status: string }[];
  globalPaused: boolean;
  activeTransfers: unknown[];
  fileErrorCount?: number;
}

type SyncState = "none" | "paused" | "errors" | "syncing" | "notSynced" | "synced";

/** The Sync row's state, from the engine's status: a stable value to test
 *  against (the line itself is translated). */
export function syncState(status: SyncSummaryInput | null): SyncState {
  if (!status || status.pairs.length === 0) return "none";
  if (status.globalPaused) return "paused";
  if (status.pairs.some((p) => p.status === "error" || p.status === "offline")) return "errors";
  if (status.pairs.some((p) => p.status === "syncing") || status.activeTransfers.length > 0) return "syncing";
  if ((status.fileErrorCount ?? 0) > 0) return "notSynced";
  return "synced";
}

/** One line for the Sync row, from the engine's status. */
export function syncLine(status: SyncSummaryInput | null, tr: T = tl): string {
  const state = syncState(status);
  if (!status || state === "none") return tr("about.label.noFolders");
  const folderCount = status.pairs.length;
  switch (state) {
    case "paused": return tr("about.label.pausedFolder", { folderCount });
    case "errors": {
      const errors = status.pairs.filter((p) => p.status === "error" || p.status === "offline").length;
      return tr("about.label.errorsWithErrorsFolder", { folderCount, errors });
    }
    case "syncing": return tr("about.label.syncingFolder", { folderCount });
    case "notSynced": return tr("about.label.fileerrorcountFilesNotSyncedFolder", { folderCount, fileErrorCount: status.fileErrorCount ?? 0 });
    default: return tr("about.label.allSyncedFolder", { folderCount });
  }
}

/** The update button's label and action for this build and state. */
export function updateButton(
  distribution: string,
  update: UpdateState | null,
): { label: string; action: "check" | "install" | "store" | null; busy: boolean } {
  if (distribution === "snap") return { label: "", action: null, busy: false };
  if (distribution !== "direct") return { label: tl("common.action.openStore", { store: channelName(distribution) }), action: "store", busy: false };
  if (update?.state === "ready") return { label: tl("about.action.restartToUpdate"), action: "install", busy: false };
  if (update?.state === "installing") return { label: tl("common.status.installing"), action: null, busy: true };
  const busy = update?.state === "checking" || update?.state === "downloading";
  const label = update?.state === "downloading"
    ? tl("common.label.downloadingPercent", { percent: update.percent })
    : update?.state === "checking" ? tl("common.status.checking") : tl("about.label.checkForUpdates");
  return { label, action: "check", busy };
}

export function updateHint(update: UpdateState | null): string | null {
  switch (update?.state) {
    case "not-available": return tl("about.label.youReUpToDate");
    case "available": return tl("about.label.versionVersionIsAvailable", { version: update.version });
    case "ready": return tl("common.label.versionVersionIsReadyToInstall", { version: update.version });
    case "installing": return tl("common.label.installingVersionVersionDosyaWillReopenInAMoment", { version: update.version });
    case "error": return tl("about.error.updateCheckFailedMessage", { message: update.message });
    default: return null;
  }
}

/** What the main process reports about this build (getAboutInfo). */
export interface AboutInfo {
  version: string;
  distribution: string;
  platform: string;
  arch: string;
  electron: string;
  chrome: string;
}

/** One details row: label, value, and whether the value is a healthy state. */
export type AboutRow = [label: string, value: string, ok?: boolean];

/**
 * The details rows the About window and Profile > About both show, in one
 * language: the chosen one on screen, English for Copy Details. Profile >
 * About leaves the Engine row off screen (`engine: false`); Copy Details
 * always carries it, since support needs it.
 */
export function aboutRows(
  tr: T,
  info: AboutInfo | null,
  email: string | null | undefined,
  sync: SyncSummaryInput | null,
  finder: { available: boolean; enabled: boolean } | null,
  { engine = true }: { engine?: boolean } = {},
): AboutRow[] {
  const list: AboutRow[] = [];
  if (info) {
    list.push([tr("about.label.channel"), channelName(info.distribution, tr)]);
    list.push([tr("common.label.system"), `${info.platform} · ${info.arch}`]);
    if (engine) list.push([tr("about.label.engine"), tr("about.label.electronElectronChromiumChrome", { electron: info.electron, chrome: info.chrome })]);
  }
  list.push([tr("about.label.signedInAs"), email ?? tr("about.description.notSignedIn")]);
  list.push([tr("common.label.sync"), syncLine(sync, tr), syncState(sync) === "synced"]);
  if (finder?.available) list.push([tr("about.label.finderLocation"), finder.enabled ? tr("about.status.on") : tr("common.status.off"), finder.enabled]);
  return list;
}

/** The text Copy Details puts on the clipboard: a header line, then the rows. */
export function detailsText(tr: T, info: AboutInfo | null, rows: AboutRow[]): string {
  return [
    tr("about.description.dosyaVersionPlatform", { version: info?.version ?? "", platform: info ? channelName(info.distribution, tr) : "unknown channel" }),
    ...rows.map(([k, v]) => `${k}: ${v}`),
  ].join("\n");
}
