import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import type { Page } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";

/**
 * The application menu, driven through Electron's Menu API against the real
 * built app. The template's shape is unit-tested in menu-template.test.ts;
 * this covers what only a running app can show: the menu follows the
 * renderer's state, its items reach the renderer, and About opens its own
 * window with live facts in it.
 */

type MenuSnapshot = { label: string; items: { label: string; enabled: boolean; checked: boolean; type: string }[] }[];

async function readMenu(page: Page): Promise<MenuSnapshot> {
  return electronAppFor(page).evaluate(({ Menu }) => {
    const menu = Menu.getApplicationMenu();
    return (menu?.items ?? []).map((top) => ({
      label: top.label,
      items: (top.submenu?.items ?? []).map((i) => ({ label: i.label, enabled: i.enabled, checked: i.checked, type: i.type })),
    }));
  });
}

/** Click a menu item by its menu and label, as the user would. */
async function clickMenuItem(page: Page, menuLabel: string, itemLabel: string): Promise<void> {
  const found = await electronAppFor(page).evaluate(({ Menu }, [m, l]) => {
    const top = Menu.getApplicationMenu()?.items.find((i) => i.label === m);
    const item = top?.submenu?.items.find((i) => i.label === l);
    if (!item) return false;
    item.click();
    return true;
  }, [menuLabel, itemLabel] as [string, string]);
  expect(found, `${menuLabel} › ${itemLabel} exists`).toBe(true);
}

test.describe("Application menu", () => {
  test("has the Option C menus and the Go sections", async ({ appPage }) => {
    const menu = await readMenu(appPage);
    const labels = menu.map((m) => m.label);
    // The first entry is the app menu on macOS (its label is the app name).
    const rest = process.platform === "darwin" ? labels.slice(1) : labels;
    expect(rest).toEqual(["File", "Edit", "View", "Go", "Sync", "Window", "Help"]);
    const go = menu.find((m) => m.label === "Go")!;
    expect(go.items.map((i) => i.label)).toEqual(expect.arrayContaining(["Back", "Forward", "Dashboard", "Files", "Vault", "Sync", "Settings", "Favourites", "Deleted"]));
  });

  test("File items follow the Files page's state", async ({ appPage }) => {
    let file = (await readMenu(appPage)).find((m) => m.label === "File")!;
    expect(file.items.find((i) => i.label === "New Folder…")?.enabled).toBe(false);

    await navigateTo(appPage, "/files");
    await expect(appPage.getByText("New folder")).toBeVisible();
    // The renderer reports its route; the menu rebuilds.
    await expect.poll(async () => (await readMenu(appPage)).find((m) => m.label === "File")!.items.find((i) => i.label === "New Folder…")?.enabled).toBe(true);

    await clickMenuItem(appPage, "File", "New Folder…");
    await expect(appPage.getByPlaceholder("Folder name")).toBeVisible();
    await appPage.keyboard.press("Escape");

    file = (await readMenu(appPage)).find((m) => m.label === "File")!;
    expect(file.items.find((i) => i.label === "Download Selected…")?.enabled).toBe(false);
  });

  test("Go navigates and View toggles the sidebar with a live checkmark", async ({ appPage }) => {
    await clickMenuItem(appPage, "Go", "Sync");
    await expect.poll(() => appPage.evaluate(() => window.location.hash)).toContain("/sync");

    const before = (await readMenu(appPage)).find((m) => m.label === "View")!;
    expect(before.items.find((i) => i.label === "Show Sidebar")?.checked).toBe(true);
    await clickMenuItem(appPage, "View", "Show Sidebar");
    await expect.poll(async () => (await readMenu(appPage)).find((m) => m.label === "View")!.items.find((i) => i.label === "Show Sidebar")?.checked).toBe(false);
    await expect(appPage.locator("aside")).toHaveCSS("width", "60px");
  });

  test("Help › Keyboard Shortcuts opens the reference sheet", async ({ appPage }) => {
    await clickMenuItem(appPage, "Help", "Keyboard Shortcuts");
    const heading = appPage.getByRole("heading", { name: "Keyboard shortcuts" });
    await expect(heading).toBeVisible();
    await expect(appPage.getByText("Search dosya")).toBeVisible();
    await appPage.keyboard.press("Escape");
    await expect(heading).toHaveCount(0);
  });

  test("Sync lists the engine's folders and Settings lands on the Updates tab", async ({ appPage }) => {
    const sync = (await readMenu(appPage)).find((m) => m.label === "Sync")!;
    expect(sync.items.map((i) => i.label)).toContain("Add Folder to Sync…");

    await navigateTo(appPage, "/settings?tab=updates");
    await expect(appPage.getByText("dosya Desktop")).toBeVisible();
  });

  test("About opens its own window with the version and the account", async ({ appPage }) => {
    const app = electronAppFor(appPage);
    const aboutMenu = process.platform === "darwin" ? (await readMenu(appPage))[0].label : "Help";
    const windowPromise = app.waitForEvent("window");
    await clickMenuItem(appPage, aboutMenu, "About dosya");
    const about = await windowPromise;
    await about.waitForLoadState("domcontentloaded");
    // The app's own version, never Electron's (what app.getVersion() answers
    // for an unpackaged build).
    const { version } = JSON.parse(readFileSync(path.join(__dirname, "../../package.json"), "utf8")) as { version: string };
    await expect(about.getByTestId("about-version")).toHaveText(`Version ${version}`);
    await expect(about.getByText("Signed in as")).toBeVisible();
    await expect(about.getByText("Copy Details")).toBeVisible();
    await about.screenshot({ path: process.env.ABOUT_SHOT ?? "playwright-report/about-window.png" });

    // Acknowledgements lists what the build shipped.
    await about.getByRole("button", { name: "Acknowledgements" }).click();
    await expect(about.getByText("react-dom")).toBeVisible();

    // A second About click focuses the same window rather than opening another.
    const countBefore = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    await clickMenuItem(appPage, aboutMenu, "About dosya");
    await appPage.waitForTimeout(300);
    const countAfter = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length);
    expect(countAfter).toBe(countBefore);
    expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().map((w) => w.getTitle()))).toContain("About dosya");

    // Esc closes the window on keydown, so the press itself can outlive its
    // target; only the outcome matters.
    await about.keyboard.press("Escape").catch(() => {});
    await expect.poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length)).toBe(countBefore - 1);
  });
});
