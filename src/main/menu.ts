import { app, BrowserWindow, Menu, type MenuItemConstructorOptions } from "electron";
import {
  buildMenuTemplate,
  defaultMenuState,
  type MenuAction,
  type MenuContext,
  type MenuState,
  type MenuSyncInfo,
  type MenuUpdateState,
  type TemplateItem,
} from "./menu-template";
import type { Distribution } from "./distribution";

/**
 * The live application menu. The shape comes from menu-template.ts (pure,
 * tested); this file owns the Electron side: turning `action`s into click
 * handlers, rebuilding when the renderer's state or the sync engine changes,
 * and popping the same menu from the ☰ button on Windows and Linux, where
 * the window's hidden title bar hides the native menu bar.
 */
export interface MenuEnv {
  distribution: Distribution;
  getUpdateState: () => MenuUpdateState;
  getSync: () => MenuSyncInfo | null;
}

export interface AppMenu {
  /** Re-read every input and install a fresh menu. */
  rebuild(): void;
  /** The renderer reported new state (route, selection, checkmarks). */
  setState(state: MenuState): void;
  /** Pop the menu as a context menu, for the ☰ title-bar button. */
  popup(win: BrowserWindow, x: number, y: number): void;
}

function toElectron(item: TemplateItem, dispatch: (a: MenuAction) => void): MenuItemConstructorOptions {
  const out: MenuItemConstructorOptions = {};
  if (item.role) out.role = item.role as MenuItemConstructorOptions["role"];
  if (item.label !== undefined) out.label = item.label;
  if (item.type) out.type = item.type;
  if (item.accelerator) out.accelerator = item.accelerator;
  if (item.enabled !== undefined) out.enabled = item.enabled;
  if (item.checked !== undefined) out.checked = item.checked;
  if (item.submenu) out.submenu = item.submenu.map((i) => toElectron(i, dispatch));
  const action = item.action;
  if (action) out.click = () => dispatch(action);
  return out;
}

export function createMenu(env: MenuEnv, dispatch: (action: MenuAction) => void): AppMenu {
  let state: MenuState = defaultMenuState();

  const context = (): MenuContext => ({
    platform: process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : "linux",
    isDev: !app.isPackaged,
    distribution: env.distribution,
    updateState: env.getUpdateState(),
    sync: env.getSync(),
    state,
  });

  const build = () => Menu.buildFromTemplate(buildMenuTemplate(context()).map((i) => toElectron(i, dispatch)));

  // Replacing the application menu while one of its menus is open closes it
  // under the pointer, and the sync engine ticks often. Only install a new
  // menu when its inputs actually changed.
  let installed = "";
  const rebuild = () => {
    const key = JSON.stringify(context());
    if (key === installed) return;
    installed = key;
    Menu.setApplicationMenu(build());
  };

  rebuild();

  return {
    rebuild,
    setState(next) {
      state = next;
      rebuild();
    },
    popup(win, x, y) {
      // A fresh instance rather than the installed one: the ☰ menu lists the
      // same items but must not steal the application menu's accelerators.
      build().popup({ window: win, x: Math.round(x), y: Math.round(y) });
    },
  };
}

/**
 * Validate what the renderer sent before trusting it: a compromised renderer
 * must only be able to toggle checkmarks, never to inject anything else.
 */
export function parseMenuState(raw: unknown): MenuState | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" && v.length <= max ? v : null);
  const route = str(r.route, 200);
  if (route === null || !route.startsWith("/")) return null;
  const viewMode = r.viewMode === "table" || r.viewMode === "card" ? r.viewMode : null;
  const appearance = r.appearance === "light" || r.appearance === "dark" || r.appearance === "system" ? r.appearance : "system";
  const count = typeof r.selectionCount === "number" && Number.isFinite(r.selectionCount) ? Math.max(0, Math.floor(r.selectionCount)) : 0;
  return {
    route,
    viewMode,
    sidebarVisible: r.sidebarVisible !== false,
    appearance,
    selectionCount: count,
    canGoBack: r.canGoBack === true,
    canGoForward: r.canGoForward === true,
    signedIn: r.signedIn !== false,
  };
}
