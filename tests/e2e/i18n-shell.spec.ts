import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The app shell in Turkish: sidebar, titlebar and its menus, the keyboard
 * shortcuts sheet and the notification inbox. Each surface is switched
 * through the titlebar language menu, spot-checked for a few Turkish strings
 * (src/i18n/messages/tr.json), then swept for English the catalog knows.
 * Sweeps are scoped to the shell: the page content belongs to other screens.
 */

test.describe("app shell in Turkish", () => {
  test("sidebar and titlebar", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");

    await expect(page.getByTestId("nav-dashboard")).toHaveText("Genel bakış");
    await expect(page.getByTestId("sidebar-search")).toContainText("Ara…");
    await expect(page.locator("aside")).toContainText("Depolama alanı");
    await expect(page.locator("aside")).toContainText("Çalışma alanı");

    // The Files tree open, with the view named beside the parent once shut.
    await page.getByTestId("nav-files-toggle").click();
    await expect(page.getByTestId("nav-files-images")).toHaveText("Görseller");
    expect(await leftoverEnglish(page, "aside")).toEqual([]);
    await page.getByTestId("nav-files-images").click();
    await page.getByTestId("nav-files-toggle").click();
    await expect(page.getByTestId("nav-files")).toHaveText("Dosyalar · Görseller");

    // The workspace menu.
    await page.getByTestId("workspace-switcher").click();
    await expect(page.getByTestId("workspace-menu")).toContainText("Çalışma alanı oluştur");
    expect(await leftoverEnglish(page, "aside")).toEqual([]);
    await page.keyboard.press("Escape");

    expect(await leftoverEnglish(page, "[data-testid=titlebar]")).toEqual([]);
  });

  test("collapsed sidebar tooltips", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    await page.getByTestId("sidebar-collapse-toggle").click();
    await expect(page.locator("aside")).toHaveCSS("width", "60px");
    await expect(page.getByTestId("sidebar-collapse-toggle")).toHaveAttribute("aria-label", "Kenar çubuğunu genişlet");
    expect(await leftoverEnglish(page, "aside")).toEqual([]);
  });

  test("create workspace dialog", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    await page.getByTestId("workspace-switcher").click();
    await page.getByTestId("workspace-menu").getByText("Çalışma alanı oluştur").click();
    await expect(page.getByPlaceholder("Çalışma alanı adı")).toBeVisible();
    await expect(page.getByRole("button", { name: "İptal" })).toBeVisible();
    expect(await leftoverEnglish(page, "aside")).toEqual([]);
  });

  test("theme menu", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    await page.getByRole("button", { name: "Tema" }).click();
    await expect(page.getByRole("button", { name: "Koyu", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Varsayılan", exact: true })).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=titlebar]")).toEqual([]);
  });

  test("language menu", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    const button = page.getByTestId("language-menu-button");
    await expect(button).toHaveAttribute("aria-label", "Dil: Türkçe");
    await button.click();
    await expect(page.getByRole("menu")).toContainText("Dil");
    expect(await leftoverEnglish(page, "[data-testid=titlebar]")).toEqual([]);
  });

  test("keyboard shortcuts sheet", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    await electronAppFor(page).evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].webContents.send("menu:action", { kind: "simple", id: "shortcuts" });
    });
    const sheet = page.getByTestId("shortcuts-dialog");
    await expect(sheet.getByRole("heading", { name: "Klavye kısayolları" })).toBeVisible();
    await expect(sheet).toContainText("Git");
    await expect(sheet).toContainText("Yeni klasör");
    await expect(sheet).toContainText(/⌘1–⌘6|Ctrl\+1–Ctrl\+6/);
    expect(await leftoverEnglish(page, "[data-testid=shortcuts-dialog]")).toEqual([]);
  });

  test("notification dropdown and inbox page", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    await page.getByTestId("open-notifications").click();
    const dropdown = page.getByTestId("notification-dropdown");
    await expect(dropdown).toContainText("Bildirimler");
    await expect(dropdown).toContainText("Bugün");
    await expect(dropdown).toContainText("Tümünü görüntüle");
    expect(await leftoverEnglish(page, "[data-testid=notification-dropdown]")).toEqual([]);
    expect(await leftoverEnglish(page, "[data-testid=titlebar]")).toEqual([]);

    await page.getByTestId("view-all-notifications").click();
    await expect(page.getByRole("heading", { name: "Bildirimler" })).toBeVisible();
    await expect(page.getByTestId("mark-all-read")).toHaveText("Tümünü okundu olarak işaretle");
    expect(await leftoverEnglish(page, "main")).toEqual([]);
  });

  test("a language switch reaches an open page", async ({ appPage: page }) => {
    await navigateTo(page, "/notifications");
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await switchLanguage(page, "tr");
    await expect(page.getByRole("heading", { name: "Bildirimler" })).toBeVisible();
    await switchLanguage(page, "en");
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
  });
});
