import { BrowserWindow, shell, type BrowserWindowConstructorOptions } from "electron";
import { aboutUrl } from "./about-url";

/**
 * "About dosya": a small window of our own, in place of Electron's bare
 * panel. It loads the same renderer bundle at `#/about` (pages/AboutPage.tsx),
 * so it follows the app's theme and can read the signed-in account.
 *
 * One per app: a second request focuses the existing window. The window is
 * fixed-size and closes with Esc or ⌘W from the page itself.
 */
export interface AboutWindowDeps {
  /** The renderer's base URL, exactly as the main window loads it. */
  rendererUrl: string;
  preloadPath: string;
  /** The main window, so the About panel opens over it (null when reclaimed). */
  parent: BrowserWindow | null;
}

export const ABOUT_WINDOW_SIZE = { width: 400, height: 540 };

let aboutWindow: BrowserWindow | null = null;

export function openAboutWindow(deps: AboutWindowDeps): BrowserWindow {
  if (aboutWindow && !aboutWindow.isDestroyed()) {
    aboutWindow.show();
    aboutWindow.focus();
    return aboutWindow;
  }

  const mac = process.platform === "darwin";
  const options: BrowserWindowConstructorOptions = {
    ...ABOUT_WINDOW_SIZE,
    title: "About dosya",
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    show: false,
    // Only the traffic lights on macOS; Windows and Linux keep a plain frame
    // (no menu bar - it is hidden app-wide anyway).
    ...(mac ? { titleBarStyle: "hiddenInset" as const, trafficLightPosition: { x: 12, y: 12 } } : { autoHideMenuBar: true }),
    ...(deps.parent && !deps.parent.isDestroyed() ? { parent: deps.parent } : {}),
    webPreferences: {
      preload: deps.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  };
  const win = new BrowserWindow(options);
  aboutWindow = win;
  win.setMenuBarVisibility(false);
  // The page's links (dosya.dev, release notes) open in the system browser,
  // the same rule the main window applies.
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url);
      if (parsed.protocol === "https:" || parsed.protocol === "http:") void shell.openExternal(url);
    } catch {}
    return { action: "deny" };
  });
  // Nothing in this window may navigate away from the About page.
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  // The renderer's <title> is the app name; this window keeps its own.
  win.on("page-title-updated", (e) => e.preventDefault());
  win.once("ready-to-show", () => win.show());
  win.on("closed", () => {
    if (aboutWindow === win) aboutWindow = null;
  });
  void win.loadURL(aboutUrl(deps.rendererUrl));
  return win;
}

export function closeAboutWindow(): void {
  if (aboutWindow && !aboutWindow.isDestroyed()) aboutWindow.close();
}
