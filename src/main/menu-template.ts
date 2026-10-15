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
export type MenuDistribution = "direct" | "ms-store" | "snap" | "mas";

// Mirrors distribution.ts's storeDisplayName, for the same reason.
const STORE_NAMES: Record<Exclude<MenuDistribution, "direct">, string> = {
  "ms-store": "Microsoft Store",
  snap: "Snap Store",
  mas: "Mac App Store",
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
const role = (r: string): TemplateItem => ({ role: r });
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
  if (ctx.distribution === "snap") return null;
  if (ctx.distribution !== "direct") {
    return simple(`Open ${STORE_NAMES[ctx.distribution]}…`, "open-store");
  }
  if (ctx.updateState === "ready") return simple("Restart to Update…", "install-update");
  // The quit is under way; the windows close in a moment, nothing to click.
  if (ctx.updateState === "installing") return simple("Installing Update…", "install-update", { enabled: false });
  const busy = ctx.updateState === "checking" || ctx.updateState === "downloading";
  return simple("Check for Updates…", "check-for-updates", { enabled: !busy });
}

function appMenu(ctx: MenuContext): TemplateItem {
  const update = updateItem(ctx);
  return {
    label: "dosya",
    submenu: [
      simple("About dosya", "about"),
      ...(update ? [update] : []),
      SEP,
      nav("Settings…", "/settings", { accelerator: "CmdOrCtrl+,", enabled: ctx.state.signedIn }),
      SEP,
      simple("Sign Out…", "sign-out", { enabled: ctx.state.signedIn }),
      SEP,
      role("services"),
      SEP,
      role("hide"),
      role("hideOthers"),
      role("unhide"),
      SEP,
      role("quit"),
    ],
  };
}

function fileMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  const onFiles = ctx.state.route === "/files";
  const hasSelection = onFiles && ctx.state.selectionCount > 0;
  const signedIn = ctx.state.signedIn;
  return {
    label: "File",
    submenu: [
      simple("New Folder…", "new-folder", { accelerator: "CmdOrCtrl+Shift+N", enabled: onFiles }),
      SEP,
      // No "Upload Folder…": Chromium only opens a file picker from a user
      // gesture inside the page, which a menu click is not. The Upload page
      // has a "Select folder" button and takes dropped folders, both of which
      // keep the subfolders.
      nav("Upload Files…", "/upload", { accelerator: "CmdOrCtrl+U", enabled: signedIn }),
      SEP,
      simple("Download Selected…", "download-selected", { enabled: hasSelection }),
      simple("Share Selected…", "share-selected", { enabled: hasSelection }),
      SEP,
      role("close"),
      ...(mac ? [] : [simple("Sign Out…", "sign-out", { enabled: signedIn }), SEP, role("quit")]),
    ],
  };
}

function editMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  return {
    label: "Edit",
    submenu: [
      role("undo"),
      role("redo"),
      SEP,
      role("cut"),
      role("copy"),
      role("paste"),
      role("selectAll"),
      SEP,
      simple("Find…", "find", { accelerator: "CmdOrCtrl+F" }),
      nav("Search dosya…", "/search", { accelerator: "CmdOrCtrl+K", enabled: ctx.state.signedIn }),
      ...(mac ? [] : [SEP, nav("Settings…", "/settings", { accelerator: "Ctrl+,", enabled: ctx.state.signedIn })]),
    ],
  };
}

function viewMenu(ctx: MenuContext): TemplateItem {
  const { state } = ctx;
  const onFiles = state.route === "/files";
  const appearance = (label: string, mode: MenuState["appearance"]): TemplateItem => ({
    label,
    type: "radio",
    checked: state.appearance === mode,
    action: { kind: "appearance", mode },
  });
  return {
    label: "View",
    submenu: [
      { label: "as List", type: "checkbox", checked: state.viewMode === "table", enabled: onFiles, action: { kind: "view", mode: "table" } },
      { label: "as Grid", type: "checkbox", checked: state.viewMode === "card", enabled: onFiles, action: { kind: "view", mode: "card" } },
      SEP,
      { label: "Show Sidebar", type: "checkbox", checked: state.sidebarVisible, accelerator: "CmdOrCtrl+Alt+S", enabled: state.signedIn, action: { kind: "simple", id: "toggle-sidebar" } },
      simple("Show File Details", "toggle-details", { accelerator: "CmdOrCtrl+I", enabled: onFiles && state.selectionCount === 1 }),
      SEP,
      { label: "Appearance", submenu: [appearance("Light", "light"), appearance("Dark", "dark"), appearance("System", "system")] },
      SEP,
      role("resetZoom"),
      role("zoomIn"),
      role("zoomOut"),
      SEP,
      role("togglefullscreen"),
      ...(ctx.isDev ? [SEP, role("reload"), role("forceReload"), role("toggleDevTools")] : []),
    ],
  };
}

/** The sections Go numbers ⌘1 to ⌘9, in sidebar order. */
export const GO_SECTIONS: { label: string; path: string }[] = [
  { label: "Dashboard", path: "/dashboard" },
  { label: "Files", path: "/files" },
  { label: "Upload", path: "/upload" },
  { label: "Shared", path: "/shared" },
  { label: "Vault", path: "/vault" },
  { label: "Sync", path: "/sync" },
  { label: "Workspaces", path: "/workspaces" },
  { label: "Team", path: "/team" },
  { label: "Settings", path: "/settings" },
];

function goMenu(ctx: MenuContext): TemplateItem {
  const { state } = ctx;
  const enabled = state.signedIn;
  return {
    label: "Go",
    submenu: [
      simple("Back", "go-back", { accelerator: "CmdOrCtrl+[", enabled: state.canGoBack }),
      simple("Forward", "go-forward", { accelerator: "CmdOrCtrl+]", enabled: state.canGoForward }),
      SEP,
      ...GO_SECTIONS.map((s, i) => nav(s.label, s.path, { accelerator: `CmdOrCtrl+${i + 1}`, enabled })),
      SEP,
      nav("Favourites", "/files?filter=favourites", { enabled }),
      nav("Deleted", "/files?filter=deleted", { enabled }),
      SEP,
      nav("LAN Transfer", "/lan-transfer", { enabled }),
      nav("Notifications", "/notifications", { enabled }),
    ],
  };
}

function syncMenu(ctx: MenuContext): TemplateItem {
  const sync = ctx.sync;
  if (!sync || sync.pairs.length === 0) {
    return {
      label: "Sync",
      submenu: [
        { label: "No folders syncing", enabled: false },
        SEP,
        nav("Add Folder to Sync…", "/sync?add=1", { enabled: ctx.state.signedIn }),
      ],
    };
  }
  const n = sync.pairs.length;
  const open: TemplateItem = n === 1
    ? { label: "Open Sync Folder", action: { kind: "open-sync-folder", pairId: sync.pairs[0].pairId } }
    : { label: "Open Sync Folder", submenu: sync.pairs.map((p) => ({ label: p.name, action: { kind: "open-sync-folder" as const, pairId: p.pairId } })) };
  const conflicts = sync.unresolvedConflicts;
  return {
    label: "Sync",
    submenu: [
      { label: `${sync.summary} · ${n} folder${n === 1 ? "" : "s"}`, enabled: false },
      SEP,
      simple("Sync All Now", "sync-now-all", { enabled: !sync.globalPaused }),
      ...(sync.globalPaused
        ? [simple("Resume Sync", "sync-resume")]
        : [simple("Pause Sync", "sync-pause"), simple("Pause for 1 Hour", "sync-pause-hour")]),
      SEP,
      open,
      ...(conflicts > 0 ? [nav(`Resolve ${conflicts} Conflict${conflicts === 1 ? "" : "s"}…`, "/sync")] : []),
      SEP,
      nav("Add Folder to Sync…", "/sync?add=1"),
      nav("Sync Settings…", "/sync"),
    ],
  };
}

function windowMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  return {
    label: "Window",
    submenu: [role("minimize"), role("zoom"), ...(mac ? [SEP, role("front")] : [role("close")])],
  };
}

function helpMenu(ctx: MenuContext): TemplateItem {
  const mac = ctx.platform === "darwin";
  const update = mac ? null : updateItem(ctx);
  return {
    // `role: "help"` puts it last on every platform (macOS gives it the
    // search field).
    role: "help",
    submenu: [
      external("dosya Help", HELP_URL),
      simple("Keyboard Shortcuts", "shortcuts", { accelerator: "CmdOrCtrl+/" }),
      external("What's New", CHANGELOG_URL),
      SEP,
      simple("Open Log Folder", "open-log-folder"),
      simple("Report a Problem…", "report-problem", { accelerator: "CmdOrCtrl+Shift+B" }),
      ...(mac ? [] : [SEP, ...(update ? [update] : []), simple("About dosya", "about")]),
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
