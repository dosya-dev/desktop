import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  buildMenuTemplate,
  defaultMenuState,
  type MenuContext,
  type TemplateItem,
} from "./menu-template.ts";
import { makeT, type Messages } from "../i18n/translator.ts";

const messages = (locale: string): Messages =>
  JSON.parse(readFileSync(new URL(`../i18n/messages/${locale}.json`, import.meta.url), "utf8")) as Messages;
const en = messages("en");
const enT = makeT("en", en, en);
const trT = makeT("tr", messages("tr"), en);

function ctx(over: Partial<MenuContext> = {}): MenuContext {
  return {
    platform: "darwin",
    isDev: false,
    distribution: "direct",
    updateState: "idle",
    sync: null,
    state: defaultMenuState(),
    t: enT,
    ...over,
  };
}

// A role item is named by its role (it also carries a label, checked in the
// role-label tests below), every other item by its label.
const titles = (items: TemplateItem[]) => items.map((m) => m.role ?? m.label);
const find = (items: TemplateItem[], title: string): TemplateItem => {
  const m = items.find((i) => (i.role ?? i.label) === title);
  assert.ok(m, `menu "${title}" is missing from ${JSON.stringify(titles(items))}`);
  return m;
};
const labels = (m: TemplateItem) => (m.submenu ?? []).map((i) => i.role ?? i.label ?? (i.type === "separator" ? "-" : "?"));
/** The labels a role item shows, keyed by role: what the menu bar displays. */
const roleLabels = (m: TemplateItem) => (m.submenu ?? []).filter((i) => i.role).map((i) => [i.role, i.label]);
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

test("in the text editor, ⌘K and ⌘I belong to the editor (link, italic), not the menu", () => {
  const state = { ...defaultMenuState(), route: "/text-editor/f1", signedIn: true };
  const t = buildMenuTemplate(ctx({ state }));
  // Still in the menu, still clickable, just without the key the editor uses.
  const search = item(find(t, "Edit"), "Search dosya…");
  assert.equal(search.accelerator, undefined);
  assert.deepEqual(search.action, { kind: "navigate", path: "/search" });
  assert.equal(item(find(t, "View"), "Show File Details").accelerator, undefined);
  // Everywhere else they keep their keys.
  const files = buildMenuTemplate(ctx({ state: { ...state, route: "/files" } }));
  assert.equal(item(find(files, "Edit"), "Search dosya…").accelerator, "CmdOrCtrl+K");
  assert.equal(item(find(files, "View"), "Show File Details").accelerator, "CmdOrCtrl+I");
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

test("role items show Electron's own English labels, per platform", () => {
  const mac = buildMenuTemplate(ctx({ isDev: true }));
  assert.deepEqual(roleLabels(find(mac, "dosya")), [
    ["services", "Services"], ["hide", "Hide dosya"], ["hideOthers", "Hide Others"], ["unhide", "Show All"], ["quit", "Quit dosya"],
  ]);
  assert.deepEqual(roleLabels(find(mac, "File")), [["close", "Close Window"]]);
  assert.deepEqual(roleLabels(find(mac, "Edit")), [
    ["undo", "Undo"], ["redo", "Redo"], ["cut", "Cut"], ["copy", "Copy"], ["paste", "Paste"], ["selectAll", "Select All"],
  ]);
  assert.deepEqual(roleLabels(find(mac, "View")), [
    ["resetZoom", "Actual Size"], ["zoomIn", "Zoom In"], ["zoomOut", "Zoom Out"], ["togglefullscreen", "Toggle Full Screen"],
    ["reload", "Reload"], ["forceReload", "Force Reload"], ["toggleDevTools", "Toggle Developer Tools"],
  ]);
  assert.deepEqual(roleLabels(find(mac, "Window")), [["minimize", "Minimize"], ["zoom", "Zoom"], ["front", "Bring All to Front"]]);
  assert.equal(find(mac, "help").label, "Help");

  const win = buildMenuTemplate(ctx({ platform: "win32" }));
  assert.deepEqual(roleLabels(find(win, "File")), [["close", "Close"], ["quit", "Exit"]]);
  assert.deepEqual(roleLabels(find(win, "Window")), [["minimize", "Minimize"], ["zoom", "Zoom"], ["close", "Close"]]);
  const linux = buildMenuTemplate(ctx({ platform: "linux" }));
  assert.deepEqual(roleLabels(find(linux, "File")), [["close", "Close"], ["quit", "Quit"]]);
});

test("a Turkish t translates the menu titles, items and role items", () => {
  const t = buildMenuTemplate(ctx({ t: trT }));
  assert.deepEqual(t.map((m) => m.label), ["dosya", "Dosya", "Düzen", "Görüntü", "Git", "Senkronizasyon", "Pencere", "Yardım"]);
  assert.equal(find(t, "help").role, "help");
  const file = find(t, "Dosya");
  assert.ok(hasItem(file, "Yeni klasör"));
  assert.deepEqual(roleLabels(file), [["close", "Pencereyi kapat"]]);
  assert.deepEqual(roleLabels(find(t, "dosya")), [
    ["services", "Servisler"], ["hide", "dosya.dev'i gizle"], ["hideOthers", "Diğerlerini gizle"], ["unhide", "Tümünü göster"], ["quit", "dosya.dev'den çık"],
  ]);
  assert.deepEqual(roleLabels(find(t, "Düzen")), [
    ["undo", "Geri al"], ["redo", "Yinele"], ["cut", "Kes"], ["copy", "Kopyala"], ["paste", "Yapıştır"], ["selectAll", "Tümünü seç"],
  ]);
  assert.deepEqual(roleLabels(find(t, "Pencere")), [["minimize", "Küçült"], ["zoom", "Büyüt"], ["front", "Tümünü öne getir"]]);
  assert.ok(roleLabels(find(t, "Görüntü")).some(([r, l]) => r === "togglefullscreen" && l === "Tam ekranı aç/kapat"));
  const winFile = find(buildMenuTemplate(ctx({ t: trT, platform: "win32" })), "Dosya");
  assert.deepEqual(roleLabels(winFile), [["close", "Kapat"], ["quit", "Çıkış"]]);
  const sync = find(buildMenuTemplate(ctx({
    t: trT,
    sync: { summary: "Tümü senkronize edildi", globalPaused: false, unresolvedConflicts: 3, pairs: [{ pairId: "p1", name: "Belgeler", localPath: "/x" }, { pairId: "p2", name: "Fotoğraflar", localPath: "/y" }] },
  })), "Senkronizasyon");
  assert.equal(labels(sync)[0], "Tümü senkronize edildi · 2 klasör");
  assert.ok(hasItem(sync, "3 çakışmayı çöz"));
  const store = find(buildMenuTemplate(ctx({ t: trT, distribution: "mas" })), "dosya");
  assert.ok(hasItem(store, "Mağazayı aç: Mac App Store"));
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

// ---- right-to-left ----
import { makeDirectionalT } from "../i18n/bidi.ts";
import { fixtureCases, FIXTURE_PAIRS } from "./menu-fixture-cases.ts";

const FSI = "⁨";
const PDI = "⁩";

test("English builds exactly the template captured at b32e39925", () => {
  const fixture = JSON.parse(
    readFileSync(new URL("./fixtures/menu-template-en-b32e39925.json", import.meta.url), "utf8"),
  ) as { name: string; template: unknown }[];
  const cases = fixtureCases(enT);
  assert.equal(fixture.length, cases.length);
  for (const [i, c] of cases.entries()) {
    assert.equal(fixture[i].name, c.name);
    assert.deepEqual(JSON.parse(JSON.stringify(buildMenuTemplate({ ...c.ctx, dir: "ltr" }))), fixture[i].template, c.name);
    assert.deepEqual(JSON.parse(JSON.stringify(buildMenuTemplate(c.ctx))), fixture[i].template, c.name);
  }
});

test("a left-to-right language does not isolate sync pair names", () => {
  const sync = { summary: "x", globalPaused: false, unresolvedConflicts: 0, pairs: FIXTURE_PAIRS };
  const t = buildMenuTemplate(ctx({ sync, dir: "ltr", t: enT }));
  const open = find(t, "Sync").submenu!.find((i) => i.submenu)!;
  assert.deepEqual(open.submenu!.map((i) => i.label), ["Photos", "Reports 2026"]);
});

test("Arabic menus carry Arabic labels and isolated pair names", () => {
  const ar = messages("ar");
  const arT = makeDirectionalT("ar", ar, en);
  const sync = { summary: "x", globalPaused: false, unresolvedConflicts: 0, pairs: FIXTURE_PAIRS };
  const t = buildMenuTemplate(ctx({ sync, dir: "rtl", t: arT }));
  const file = t.find((m) => m.label === ar["menus.label.file.menu"]);
  assert.ok(file, "the File menu is in Arabic");
  assert.notEqual(ar["menus.label.file.menu"], en["menus.label.file.menu"]);
  const syncMenu = t.find((m) => m.label === ar["common.label.sync"])!;
  const open = syncMenu.submenu!.find((i) => i.submenu)!;
  assert.deepEqual(open.submenu!.map((i) => i.label), [`${FSI}Photos${PDI}`, `${FSI}Reports 2026${PDI}`]);
  // The action still carries the pair id, never the decorated name.
  assert.deepEqual(open.submenu!.map((i) => i.action), [
    { kind: "open-sync-folder", pairId: "p1" },
    { kind: "open-sync-folder", pairId: "p2" },
  ]);
});
