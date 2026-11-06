/**
 * The application menu as data. Pure: no Electron import, so the whole shape
 * (which menus exist per platform, what is enabled, what is checked) is
 * unit-tested on Node, and menu.ts only turns `action`s into click handlers.
 *
 * Layout (chosen 2026-10-04, "Option C"):
 *   macOS:          dosya · File · Edit · View · Go · Sync · Window · Help
 *   Windows/Linux:  File · Edit · View · Go · Sync · Window · Help
 * Windows and Linux hide the native menu bar (the window uses a custom title
 * bar), so there the same template is popped from a ☰ button instead.
 */
/**
 * Same values as distribution.ts's Distribution. Spelled out here, with no
 * import, because this module is shared with the preload and renderer type
 * graphs (tsconfig.web.json), which do not admit the rest of src/main.
 */
import type { MessageKey } from "../i18n/keys";
import type { T } from "../i18n/translator";
import { isolatePairName } from "./sync-pair-label.ts";

export type MenuDistribution = "direct" | "ms-store" | "snap" | "mas";

// Mirrors distribution.ts's storeDisplayName, for the same reason.
const STORE_NAMES: Record<Exclude<MenuDistribution, "direct">, MessageKey> = {
  "ms-store": "common.label.microsoftStore",
  snap: "common.label.snapStore",
  mas: "common.label.macAppStore",
};

export type MenuPlatform = "darwin" | "win32" | "linux";

/** Update states the menu reacts to; a subset of updater.ts's UpdateStatus. */
export type MenuUpdateState =
  | "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error" | "not-available" | "store-managed";

/** What the renderer reports so the menu can enable and check the right items. */
export interface MenuState {
  /** Current route path without the hash, e.g. "/files". */
  route: string;
  /** Files page layout, null when the page is not showing a folder listing. */
  viewMode: "table" | "card" | null;
  sidebarVisible: boolean;
  appearance: "light" | "dark" | "system";
  /** Files and folders selected on the Files page. */
  selectionCount: number;
  canGoBack: boolean;
  canGoForward: boolean;
  signedIn: boolean;
}

export function defaultMenuState(): MenuState {
  return {
    route: "/",
    viewMode: null,
    sidebarVisible: true,
    appearance: "system",
    selectionCount: 0,
    canGoBack: false,
    canGoForward: false,
    signedIn: true,
  };
}

export interface MenuSyncPair {
  pairId: string;
  /** The remote folder's name, as the tray shows it. */
  name: string;
  localPath: string;
}

/** The slice of sync status the menu shows; null when the engine is off. */
export interface MenuSyncInfo {
  summary: string;
  globalPaused: boolean;
  unresolvedConflicts: number;
  pairs: MenuSyncPair[];
}

export interface MenuContext {
  platform: MenuPlatform;
  isDev: boolean;
  distribution: MenuDistribution;
  updateState: MenuUpdateState;
  sync: MenuSyncInfo | null;
  state: MenuState;
  /** Labels in the chosen language. Only `role` items are left to the OS. */
  t: T;
  /** Layout direction of the chosen language; absent means left to right. */
  dir?: "ltr" | "rtl";
}

export type SimpleActionId =
  | "about"
  | "check-for-updates"
  | "install-update"
  | "open-store"
  | "sign-out"
  | "new-folder"
  | "download-selected"
  | "share-selected"
  | "find"
  | "toggle-sidebar"
  | "toggle-details"
  | "go-back"
  | "go-forward"
  | "sync-now-all"
  | "sync-pause"
  | "sync-pause-hour"
  | "sync-resume"
  | "shortcuts"
  | "open-log-folder"
  | "report-problem";

export type MenuAction =
  | { kind: "simple"; id: SimpleActionId }
  | { kind: "navigate"; path: string }
  | { kind: "view"; mode: "table" | "card" }
  | { kind: "appearance"; mode: "light" | "dark" | "system" }
  | { kind: "open-sync-folder"; pairId: string }
  | { kind: "external"; url: string };

/** A MenuItemConstructorOptions look-alike with an `action` instead of `click`. */
export interface TemplateItem {
  label?: string;
  role?: string;
  type?: "separator" | "checkbox" | "radio";
  accelerator?: string;
  enabled?: boolean;
  checked?: boolean;
  submenu?: TemplateItem[];
  action?: MenuAction;
}

const SEP: TemplateItem = { type: "separator" };
/**
 * Electron hard-codes English labels for role items, and the OS does not
 * translate them, so every role carries its own label. The role still does
 * the work and supplies the accelerator.
 */
const role = (r: string, label: string): TemplateItem => ({ role: r, label });

/** The quit item's label, which Electron spells differently per platform. */
const quitLabel = (ctx: MenuContext): string =>
  ctx.t(ctx.platform === "darwin" ? "menus.action.quitDosya" : ctx.platform === "win32" ? "menus.action.exit" : "menus.action.quit");

/** The close item's label: "Close Window" on macOS, "Close" elsewhere. */
const closeLabel = (ctx: MenuContext): string =>
  ctx.t(ctx.platform === "darwin" ? "menus.action.closeWindow" : "menus.action.close");
const nav = (label: string, path: string, extra: Partial<TemplateItem> = {}): TemplateItem =>
  ({ label, action: { kind: "navigate", path }, ...extra });
const simple = (label: string, id: SimpleActionId, extra: Partial<TemplateItem> = {}): TemplateItem =>
  ({ label, action: { kind: "simple", id }, ...extra });
const external = (label: string, url: string): TemplateItem => ({ label, action: { kind: "external", url } });

export const HELP_URL = "https://dosya.dev/help";
export const CHANGELOG_URL = "https://dosya.dev/changelog/";

/**
 * The update item depends on the build. A direct build checks (and installs
 * once an update is downloaded); a store build can only send the user to the
 * store; the Snap Store has no page to open, so the snap build gets nothing.
 */
function updateItem(ctx: MenuContext): TemplateItem | null {
  const { t } = ctx;
  if (ctx.distribution === "snap") return null;
  if (ctx.distribution !== "direct") {
    return simple(t("menus.action.openStore", { store: t(STORE_NAMES[ctx.distribution]) }), "open-store");
  }
  if (ctx.updateState === "ready") return simple(t("menus.action.restartToUpdate"), "install-update");
  // The quit is under way; the windows close in a moment, nothing to click.
  if (ctx.updateState === "installing") return simple(t("menus.status.installingUpdate"), "install-update", { enabled: false });
  const busy = ctx.updateState === "checking" || ctx.updateState === "downloading";
  return simple(t("menus.action.checkForUpdates"), "check-for-updates", { enabled: !busy });
}

function appMenu(ctx: MenuContext): TemplateItem {
  const { t } = ctx;
  const update = updateItem(ctx);
  return {
    label: "dosya",
    submenu: [
      simple(t("about.window.aboutDosya"), "about"),
      ...(update ? [update] : []),
      SEP,
      nav(t("menus.action.settings"), "/settings", { accelerator: "CmdOrCtrl+,", enabled: ctx.state.signedIn }),
      SEP,
      simple(t("menus.action.signOut"), "sign-out", { enabled: ctx.state.signedIn }),
      SEP,
      role("services", t("menus.label.services")),
      SEP,
      role("hide", t("menus.action.hideDosya")),
      role("hideOthers", t("menus.action.hideOthers")),
      role("unhide", t("menus.action.showAll")),
      SEP,
      role("quit", quitLabel(ctx)),
    ],
  };
}

function fileMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  const onFiles = ctx.state.route === "/files";
  const hasSelection = onFiles && ctx.state.selectionCount > 0;
  const signedIn = ctx.state.signedIn;
  const { t } = ctx;
  return {
    label: t("menus.label.file.menu"),
    submenu: [
      simple(t("menus.action.newFolder"), "new-folder", { accelerator: "CmdOrCtrl+Shift+N", enabled: onFiles }),
      SEP,
      // No "Upload Folder…": Chromium only opens a file picker from a user
      // gesture inside the page, which a menu click is not. The Upload page
      // has a "Select folder" button and takes dropped folders, both of which
      // keep the subfolders.
      nav(t("menus.action.uploadFiles"), "/upload", { accelerator: "CmdOrCtrl+U", enabled: signedIn }),
      SEP,
      simple(t("menus.action.downloadSelected"), "download-selected", { enabled: hasSelection }),
      simple(t("menus.action.shareSelected"), "share-selected", { enabled: hasSelection }),
      SEP,
      role("close", closeLabel(ctx)),
      ...(mac ? [] : [simple(t("menus.action.signOut"), "sign-out", { enabled: signedIn }), SEP, role("quit", quitLabel(ctx))]),
    ],
  };
}

/**
 * The text editor binds ⌘K (link) and ⌘I (italic). A menu accelerator wins
 * over the page on macOS - the key never reaches the renderer - so on that
 * route the two items stay in the menu without their keys.
 */
const editorKeys = (ctx: MenuContext): boolean => ctx.state.route.startsWith("/text-editor/");

function editMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  const { t } = ctx;
  return {
    label: t("menus.heading.edit.menu"),
    submenu: [
      role("undo", t("menus.action.undo")),
      role("redo", t("menus.action.redo")),
      SEP,
      role("cut", t("menus.action.cut")),
      role("copy", t("menus.action.copy")),
      role("paste", t("menus.action.paste")),
      role("selectAll", t("menus.action.selectAll")),
      SEP,
      simple(t("menus.action.find"), "find", { accelerator: "CmdOrCtrl+F" }),
      nav(t("menus.action.searchDosya"), "/search", { accelerator: editorKeys(ctx) ? undefined : "CmdOrCtrl+K", enabled: ctx.state.signedIn }),
      ...(mac ? [] : [SEP, nav(t("menus.action.settings"), "/settings", { accelerator: "Ctrl+,", enabled: ctx.state.signedIn })]),
    ],
  };
}

function viewMenu(ctx: MenuContext): TemplateItem {
  const { state, t } = ctx;
  const onFiles = state.route === "/files";
  const appearance = (label: string, mode: MenuState["appearance"]): TemplateItem => ({
    label,
    type: "radio",
    checked: state.appearance === mode,
    action: { kind: "appearance", mode },
  });
  return {
    label: t("menus.heading.view.menu"),
    submenu: [
      { label: t("menus.label.asList"), type: "checkbox", checked: state.viewMode === "table", enabled: onFiles, action: { kind: "view", mode: "table" } },
      { label: t("menus.label.asGrid"), type: "checkbox", checked: state.viewMode === "card", enabled: onFiles, action: { kind: "view", mode: "card" } },
      SEP,
      { label: t("menus.action.showSidebar"), type: "checkbox", checked: state.sidebarVisible, accelerator: "CmdOrCtrl+Alt+S", enabled: state.signedIn, action: { kind: "simple", id: "toggle-sidebar" } },
      simple(t("menus.action.showFileDetails"), "toggle-details", { accelerator: editorKeys(ctx) ? undefined : "CmdOrCtrl+I", enabled: onFiles && state.selectionCount === 1 }),
      SEP,
      {
        label: t("common.label.appearance"),
        submenu: [
          appearance(t("common.option.light"), "light"),
          appearance(t("common.option.dark"), "dark"),
          appearance(t("common.option.system"), "system"),
        ],
      },
      SEP,
      role("resetZoom", t("menus.action.actualSize")),
      role("zoomIn", t("menus.action.zoomIn")),
      role("zoomOut", t("menus.action.zoomOut")),
      SEP,
      role("togglefullscreen", t("menus.action.toggleFullScreen")),
      ...(ctx.isDev
        ? [SEP, role("reload", t("menus.action.reload")), role("forceReload", t("menus.action.forceReload")), role("toggleDevTools", t("menus.action.toggleDeveloperTools"))]
        : []),
    ],
  };
}

/** The sections Go numbers ⌘1 to ⌘9, in sidebar order. */
export const GO_SECTIONS: { label: MessageKey | null; path: string }[] = [
  { label: "common.label.dashboard", path: "/dashboard" },
  { label: "common.label.files", path: "/files" },
  { label: "common.action.upload", path: "/upload" },
  { label: "common.label.shared", path: "/shared" },
  // The product name, never translated: the catalog has no entry for it.
  { label: null, path: "/vault" },
  { label: "common.label.sync", path: "/sync" },
  { label: "menus.label.workspaces", path: "/workspaces" },
  { label: "common.label.team", path: "/team" },
  { label: "common.label.settings", path: "/settings" },
];

function goMenu(ctx: MenuContext): TemplateItem {
  const { state, t } = ctx;
  const enabled = state.signedIn;
  return {
    label: t("menus.label.go"),
    submenu: [
      simple(t("common.back"), "go-back", { accelerator: "CmdOrCtrl+[", enabled: state.canGoBack }),
      simple(t("menus.action.forward"), "go-forward", { accelerator: "CmdOrCtrl+]", enabled: state.canGoForward }),
      SEP,
      ...GO_SECTIONS.map((s, i) => nav(s.label ? t(s.label) : "Vault", s.path, { accelerator: `CmdOrCtrl+${i + 1}`, enabled })),
      SEP,
      nav(t("common.label.favourites"), "/files?filter=favourites", { enabled }),
      nav(t("common.label.deleted"), "/files?filter=deleted", { enabled }),
      SEP,
      nav(t("lan-transfer.heading.lanTransfer"), "/lan-transfer", { enabled }),
      nav(t("common.heading.notifications"), "/notifications", { enabled }),
    ],
  };
}

function syncMenu(ctx: MenuContext): TemplateItem {
  const { sync, t } = ctx;
  if (!sync || sync.pairs.length === 0) {
    return {
      label: t("common.label.sync"),
      submenu: [
        { label: t("menus.label.noFoldersSyncing"), enabled: false },
        SEP,
        nav(t("menus.action.addFolderToSync"), "/sync?add=1", { enabled: ctx.state.signedIn }),
      ],
    };
  }
  const n = sync.pairs.length;
  const open: TemplateItem = n === 1
    ? { label: t("common.action.openSyncFolder"), action: { kind: "open-sync-folder", pairId: sync.pairs[0].pairId } }
    : { label: t("common.action.openSyncFolder"), submenu: sync.pairs.map((p) => ({ label: isolatePairName(p.name, ctx.dir ?? "ltr"), action: { kind: "open-sync-folder" as const, pairId: p.pairId } })) };
  const conflicts = sync.unresolvedConflicts;
  return {
    label: t("common.label.sync"),
    submenu: [
      { label: t("menus.label.summaryFolder", { summary: sync.summary, count: n }), enabled: false },
      SEP,
      simple(t("common.action.syncAllNow"), "sync-now-all", { enabled: !sync.globalPaused }),
      ...(sync.globalPaused
        ? [simple(t("common.action.resumeSync"), "sync-resume")]
        : [simple(t("common.action.pauseSync"), "sync-pause"), simple(t("menus.action.pauseFor1Hour"), "sync-pause-hour")]),
      SEP,
      open,
      ...(conflicts > 0 ? [nav(t("menus.action.resolveConflict", { conflicts }), "/sync")] : []),
      SEP,
      nav(t("menus.action.addFolderToSync"), "/sync?add=1"),
      nav(t("menus.action.syncSettings"), "/sync"),
    ],
  };
}

function windowMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  const { t } = ctx;
  return {
    label: t("menus.label.window"),
    submenu: [
      role("minimize", t("menus.action.minimize")),
      role("zoom", t("menus.action.zoom")),
      ...(mac ? [SEP, role("front", t("menus.action.bringAllToFront"))] : [role("close", closeLabel(ctx))]),
    ],
  };
}

function helpMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  const update = mac ? null : updateItem(ctx);
  const { t } = ctx;
  return {
    // `role: "help"` puts it last on every platform (macOS gives it the
    // search field); the label keeps it in the chosen language.
    role: "help",
    label: t("menus.label.help"),
    submenu: [
      external(t("menus.label.dosyaHelp"), HELP_URL),
      simple(t("menus.label.keyboardShortcuts"), "shortcuts", { accelerator: "CmdOrCtrl+/" }),
      external(t("menus.label.whatSNew"), CHANGELOG_URL),
      SEP,
      simple(t("menus.action.openLogFolder"), "open-log-folder"),
      simple(t("menus.action.reportAProblem"), "report-problem", { accelerator: "CmdOrCtrl+Shift+B" }),
      ...(mac ? [] : [SEP, ...(update ? [update] : []), simple(t("about.window.aboutDosya"), "about")]),
    ],
  };
}

export function buildMenuTemplate(ctx: MenuContext): TemplateItem[] {
  return [
    ...(ctx.platform === "darwin" ? [appMenu(ctx)] : []),
    fileMenu(ctx),
    editMenu(ctx),
    viewMenu(ctx),
    goMenu(ctx),
    syncMenu(ctx),
    windowMenu(ctx),
    helpMenu(ctx),
  ];
}
