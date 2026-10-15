import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildMenuTemplate,
  defaultMenuState,
  type MenuContext,
  type TemplateItem,
} from "./menu-template.ts";

function ctx(over: Partial<MenuContext> = {}): MenuContext {
  return {
    platform: "darwin",
    isDev: false,
    distribution: "direct",
    updateState: "idle",
    sync: null,
    state: defaultMenuState(),
    ...over,
  };
}

const titles = (items: TemplateItem[]) => items.map((m) => m.label ?? m.role);
const find = (items: TemplateItem[], title: string): TemplateItem => {
  const m = items.find((i) => (i.label ?? i.role) === title);
  assert.ok(m, `menu "${title}" is missing from ${JSON.stringify(titles(items))}`);
  return m;
};
const labels = (m: TemplateItem) => (m.submenu ?? []).map((i) => i.label ?? i.role ?? (i.type === "separator" ? "-" : "?"));
const item = (m: TemplateItem, label: string): TemplateItem => {
  const i = (m.submenu ?? []).find((x) => x.label === label);
  assert.ok(i, `item "${label}" is missing from ${JSON.stringify(labels(m))}`);
  return i;
};
const hasItem = (m: TemplateItem, label: string) => (m.submenu ?? []).some((x) => x.label === label);

test("macOS gets the app menu first and the Option C set after it", () => {
  const t = buildMenuTemplate(ctx());
  assert.deepEqual(titles(t), ["dosya", "File", "Edit", "View", "Go", "Sync", "Window", "help"]);
});

test("Windows and Linux have no app menu; Settings, About and updates move to Edit and Help, Exit ends File", () => {
  for (const platform of ["win32", "linux"] as const) {
    const t = buildMenuTemplate(ctx({ platform }));
    assert.deepEqual(titles(t), ["File", "Edit", "View", "Go", "Sync", "Window", "help"]);
    assert.ok(hasItem(find(t, "Edit"), "Settings…"));
    assert.equal(item(find(t, "Edit"), "Settings…").accelerator, "Ctrl+,");
    assert.ok(hasItem(find(t, "help"), "About dosya"));
    assert.ok(hasItem(find(t, "help"), "Check for Updates…"));
    const file = labels(find(t, "File"));
    assert.equal(file[file.length - 1], "quit");
    assert.ok(hasItem(find(t, "File"), "Sign Out…"));
  }
});

test("the macOS app menu carries About, updates, Settings and Sign Out", () => {
  const app = find(buildMenuTemplate(ctx()), "dosya");
  assert.deepEqual(labels(app), [
    "About dosya", "Check for Updates…", "-", "Settings…", "-", "Sign Out…", "-",
    "services", "-", "hide", "hideOthers", "unhide", "-", "quit",
  ]);
  assert.equal(item(app, "Settings…").accelerator, "CmdOrCtrl+,");
  assert.deepEqual(item(app, "Settings…").action, { kind: "navigate", path: "/settings" });
  assert.deepEqual(item(app, "Sign Out…").action, { kind: "simple", id: "sign-out" });
  // Help on macOS does not repeat About or updates.
  const help = find(buildMenuTemplate(ctx()), "help");
  assert.ok(!hasItem(help, "About dosya"));
  assert.ok(!hasItem(help, "Check for Updates…"));
});

test("Check for Updates follows the build: direct checks, stores open the store, snap hides it", () => {
  const direct = item(find(buildMenuTemplate(ctx()), "dosya"), "Check for Updates…");
  assert.deepEqual(direct.action, { kind: "simple", id: "check-for-updates" });
  assert.equal(direct.enabled, true);

  const checking = item(find(buildMenuTemplate(ctx({ updateState: "checking" })), "dosya"), "Check for Updates…");
  assert.equal(checking.enabled, false);

  const ready = find(buildMenuTemplate(ctx({ updateState: "ready" })), "dosya");
  assert.ok(hasItem(ready, "Restart to Update…"));
  assert.ok(!hasItem(ready, "Check for Updates…"));
  assert.deepEqual(item(ready, "Restart to Update…").action, { kind: "simple", id: "install-update" });

  const mas = find(buildMenuTemplate(ctx({ distribution: "mas" })), "dosya");
  assert.ok(hasItem(mas, "Open Mac App Store…"));
  assert.deepEqual(item(mas, "Open Mac App Store…").action, { kind: "simple", id: "open-store" });

  const ms = find(buildMenuTemplate(ctx({ platform: "win32", distribution: "ms-store" })), "help");
  assert.ok(hasItem(ms, "Open Microsoft Store…"));

  const snap = find(buildMenuTemplate(ctx({ platform: "linux", distribution: "snap" })), "help");
  assert.ok(!hasItem(snap, "Check for Updates…"));
  assert.ok(!hasItem(snap, "Open Snap Store…"));
});

test("File: new folder and selection items are gated on the Files route and a selection", () => {
  const elsewhere = find(buildMenuTemplate(ctx({ state: { ...defaultMenuState(), route: "/dashboard" } })), "File");
  assert.equal(item(elsewhere, "New Folder…").enabled, false);
  assert.equal(item(elsewhere, "Download Selected…").enabled, false);
  assert.equal(item(elsewhere, "Share Selected…").enabled, false);

  const files = find(buildMenuTemplate(ctx({ state: { ...defaultMenuState(), route: "/files", selectionCount: 0 } })), "File");
  assert.equal(item(files, "New Folder…").enabled, true);
  assert.equal(item(files, "New Folder…").accelerator, "CmdOrCtrl+Shift+N");
  assert.equal(item(files, "Download Selected…").enabled, false);

  const selected = find(buildMenuTemplate(ctx({ state: { ...defaultMenuState(), route: "/files", selectionCount: 3 } })), "File");
  assert.equal(item(selected, "Download Selected…").enabled, true);
  assert.equal(item(selected, "Share Selected…").enabled, true);
  assert.deepEqual(item(selected, "Upload Files…").action, { kind: "navigate", path: "/upload" });
  assert.equal(item(selected, "Upload Files…").accelerator, "CmdOrCtrl+U");
  assert.ok(!hasItem(selected, "Upload Folder…"), "a file picker needs a user gesture a menu click cannot give");
});

test("File ends with Close Window on macOS and keeps no sync items (they live in Sync)", () => {
  const file = find(buildMenuTemplate(ctx()), "File");
  assert.equal(labels(file)[labels(file).length - 1], "close");
  assert.ok(!hasItem(file, "Sync All Now"));
});

test("Edit keeps the editing roles and adds Find and Search", () => {
  const edit = find(buildMenuTemplate(ctx()), "Edit");
  assert.deepEqual(labels(edit), ["undo", "redo", "-", "cut", "copy", "paste", "selectAll", "-", "Find…", "Search dosya…"]);
  assert.equal(item(edit, "Find…").accelerator, "CmdOrCtrl+F");
  assert.deepEqual(item(edit, "Find…").action, { kind: "simple", id: "find" });
  assert.equal(item(edit, "Search dosya…").accelerator, "CmdOrCtrl+K");
  assert.deepEqual(item(edit, "Search dosya…").action, { kind: "navigate", path: "/search" });
});

test("View is presentation only, with checkmarks that follow the renderer's state", () => {
  const state = { ...defaultMenuState(), route: "/files", viewMode: "card" as const, sidebarVisible: false, appearance: "dark" as const };
  const view = find(buildMenuTemplate(ctx({ state })), "View");
  assert.ok(!hasItem(view, "Dashboard"), "navigation belongs to Go");
  assert.equal(item(view, "as List").checked, false);
  assert.equal(item(view, "as Grid").checked, true);
  assert.equal(item(view, "as Grid").type, "checkbox");
  assert.deepEqual(item(view, "as Grid").action, { kind: "view", mode: "card" });
  assert.equal(item(view, "Show Sidebar").checked, false);
  assert.equal(item(view, "Show Sidebar").accelerator, "CmdOrCtrl+Alt+S");
  const appearance = item(view, "Appearance");
  assert.deepEqual((appearance.submenu ?? []).map((i) => [i.label, i.checked, i.type]), [
    ["Light", false, "radio"], ["Dark", true, "radio"], ["System", false, "radio"],
  ]);
  assert.deepEqual(item(appearance, "Light").action, { kind: "appearance", mode: "light" });
  // List/grid only make sense on the Files page.
  const away = find(buildMenuTemplate(ctx({ state: { ...state, route: "/dashboard" } })), "View");
  assert.equal(item(away, "as List").enabled, false);
  assert.equal(item(away, "as Grid").enabled, false);
});

test("View carries zoom and full screen roles, and the dev tools only in development", () => {
  const prod = find(buildMenuTemplate(ctx()), "View");
  assert.ok(labels(prod).includes("resetZoom"));
  assert.ok(labels(prod).includes("togglefullscreen"));
  assert.ok(!labels(prod).includes("toggleDevTools"));
  const dev = find(buildMenuTemplate(ctx({ isDev: true })), "View");
  assert.ok(labels(dev).includes("toggleDevTools"));
  assert.ok(labels(dev).includes("reload"));
});

test("Go lists Back/Forward, the sections with ⌘1-9, then the Files places", () => {
  const go = find(buildMenuTemplate(ctx({ state: { ...defaultMenuState(), canGoBack: true, canGoForward: false } })), "Go");
  assert.equal(item(go, "Back").enabled, true);
  assert.equal(item(go, "Back").accelerator, "CmdOrCtrl+[");
  assert.equal(item(go, "Forward").enabled, false);
  assert.equal(item(go, "Forward").accelerator, "CmdOrCtrl+]");
  const numbered = ["Dashboard", "Files", "Upload", "Shared", "Vault", "Sync", "Workspaces", "Team", "Settings"];
  numbered.forEach((label, i) => {
    assert.equal(item(go, label).accelerator, `CmdOrCtrl+${i + 1}`);
    assert.equal(item(go, label).action?.kind, "navigate");
  });
  assert.deepEqual(item(go, "Files").action, { kind: "navigate", path: "/files" });
  assert.deepEqual(item(go, "Favourites").action, { kind: "navigate", path: "/files?filter=favourites" });
  assert.deepEqual(item(go, "Deleted").action, { kind: "navigate", path: "/files?filter=deleted" });
  assert.ok(hasItem(go, "LAN Transfer"));
  assert.ok(hasItem(go, "Notifications"));
});

test("Sync with no folders explains itself and offers only Add Folder", () => {
  const sync = find(buildMenuTemplate(ctx({ sync: null })), "Sync");
  assert.deepEqual(labels(sync), ["No folders syncing", "-", "Add Folder to Sync…"]);
  assert.equal(item(sync, "No folders syncing").enabled, false);
  assert.deepEqual(item(sync, "Add Folder to Sync…").action, { kind: "navigate", path: "/sync?add=1" });
});

test("Sync mirrors the tray: status line, now/pause, open folder per pair, conflicts, settings", () => {
  const sync = find(buildMenuTemplate(ctx({
    sync: {
      summary: "All synced",
      globalPaused: false,
      unresolvedConflicts: 2,
      pairs: [
        { pairId: "p1", name: "Documents", localPath: "/Users/f/Documents" },
        { pairId: "p2", name: "Photos", localPath: "/Users/f/Photos" },
      ],
    },
  })), "Sync");
  assert.deepEqual(labels(sync), [
    "All synced · 2 folders", "-",
    "Sync All Now", "Pause Sync", "Pause for 1 Hour", "-",
    "Open Sync Folder", "Resolve 2 Conflicts…", "-",
    "Add Folder to Sync…", "Sync Settings…",
  ]);
  assert.equal(item(sync, "All synced · 2 folders").enabled, false);
  assert.deepEqual(item(sync, "Sync All Now").action, { kind: "simple", id: "sync-now-all" });
  assert.deepEqual(item(sync, "Pause Sync").action, { kind: "simple", id: "sync-pause" });
  assert.deepEqual(item(sync, "Pause for 1 Hour").action, { kind: "simple", id: "sync-pause-hour" });
  const open = item(sync, "Open Sync Folder");
  assert.deepEqual((open.submenu ?? []).map((i) => [i.label, i.action]), [
    ["Documents", { kind: "open-sync-folder", pairId: "p1" }],
    ["Photos", { kind: "open-sync-folder", pairId: "p2" }],
  ]);
  assert.deepEqual(item(sync, "Resolve 2 Conflicts…").action, { kind: "navigate", path: "/sync" });
});

test("Sync while paused offers Resume instead of Pause, and a single folder opens directly", () => {
  const sync = find(buildMenuTemplate(ctx({
    sync: { summary: "Paused", globalPaused: true, unresolvedConflicts: 0, pairs: [{ pairId: "p1", name: "Documents", localPath: "/x" }] },
  })), "Sync");
  assert.ok(hasItem(sync, "Resume Sync"));
  assert.ok(!hasItem(sync, "Pause Sync"));
  assert.ok(!hasItem(sync, "Pause for 1 Hour"));
  assert.equal(labels(sync)[0], "Paused · 1 folder");
  assert.deepEqual(item(sync, "Open Sync Folder").action, { kind: "open-sync-folder", pairId: "p1" });
  assert.equal(item(sync, "Open Sync Folder").submenu, undefined);
  assert.ok(!labels(sync).some((l) => l.startsWith("Resolve")));
});

test("Window differs per platform the way it always did", () => {
  assert.deepEqual(labels(find(buildMenuTemplate(ctx()), "Window")), ["minimize", "zoom", "-", "front"]);
  assert.deepEqual(labels(find(buildMenuTemplate(ctx({ platform: "win32" })), "Window")), ["minimize", "zoom", "close"]);
});

test("Help opens the help centre, shortcuts, release notes, the log folder and the bug report", () => {
  const help = find(buildMenuTemplate(ctx()), "help");
  assert.equal(help.role, "help");
  assert.deepEqual(item(help, "dosya Help").action, { kind: "external", url: "https://dosya.dev/help" });
  assert.deepEqual(item(help, "Keyboard Shortcuts").action, { kind: "simple", id: "shortcuts" });
  assert.equal(item(help, "Keyboard Shortcuts").accelerator, "CmdOrCtrl+/");
  assert.deepEqual(item(help, "What's New").action, { kind: "external", url: "https://dosya.dev/changelog/" });
  assert.deepEqual(item(help, "Open Log Folder").action, { kind: "simple", id: "open-log-folder" });
  assert.deepEqual(item(help, "Report a Problem…").action, { kind: "simple", id: "report-problem" });
  assert.equal(item(help, "Report a Problem…").accelerator, "CmdOrCtrl+Shift+B");
});

test("About on Windows and Linux opens our window, not Electron's dialog", () => {
  const help = find(buildMenuTemplate(ctx({ platform: "linux" })), "help");
  assert.deepEqual(item(help, "About dosya").action, { kind: "simple", id: "about" });
  // A `role: "about"` item ignores its click handler, so the macOS app menu
  // uses a plain item too.
  const app = find(buildMenuTemplate(ctx()), "dosya");
  const about = (app.submenu ?? [])[0];
  assert.equal(about.role, undefined);
  assert.deepEqual(about.action, { kind: "simple", id: "about" });
});

test("Sign Out and Settings are disabled when nobody is signed in", () => {
  const app = find(buildMenuTemplate(ctx({ state: { ...defaultMenuState(), signedIn: false } })), "dosya");
  assert.equal(item(app, "Sign Out…").enabled, false);
  assert.equal(item(app, "Settings…").enabled, false);
  const go = find(buildMenuTemplate(ctx({ state: { ...defaultMenuState(), signedIn: false } })), "Go");
  assert.equal(item(go, "Files").enabled, false);
});

test("while the update installs the menu says so and offers nothing to click", () => {
  const installing = find(buildMenuTemplate(ctx({ updateState: "installing" })), "dosya");
  assert.ok(hasItem(installing, "Installing Update…"));
  assert.ok(!hasItem(installing, "Check for Updates…"));
  assert.ok(!hasItem(installing, "Restart to Update…"));
  assert.equal(item(installing, "Installing Update…").enabled, false);
});
