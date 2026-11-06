import { test as base, type Page } from "@playwright/test";
import { test, guestTest, expect, navigateTo, launchApp } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * Sign-in, sign-up, password reset, two-factor, email verification,
 * onboarding, create-workspace, the dashboard and the workspace dashboard in
 * Turkish. Each route is spot-checked for a few Turkish strings
 * (src/i18n/messages/tr.json), then swept for English the catalog knows.
 *
 * The signed-out screens and the create-workspace screen have no titlebar, so
 * there is no language menu to click: those switch through the same IPC the
 * menu uses (window.electronAPI.setLocale) and reload, which is also how the
 * app starts in a stored language.
 */

async function setLocaleAndReload(page: Page, lang: "tr"): Promise<void> {
  await page.evaluate((l) => window.electronAPI.setLocale(l), lang);
  await page.reload();
  await page.waitForLoadState("domcontentloaded");
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(lang);
}

guestTest.describe("signed-out screens in Turkish", () => {
  guestTest("onboarding", async ({ appPage: page }) => {
    await setLocaleAndReload(page, "tr");
    await expect(page.getByRole("heading", { name: "dosya.dev'e hoş geldiniz" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Tanıtımı atla" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hoş geldiniz", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "İleri" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);

    // The last step, with its own button label.
    for (let i = 0; i < 4; i++) await page.getByRole("button", { name: "İleri" }).click();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  guestTest("sign in", async ({ appPage: page }) => {
    await navigateTo(page, "/login");
    await setLocaleAndReload(page, "tr");
    await expect(page.getByRole("heading", { name: "Tekrar hoş geldiniz" })).toBeVisible();
    await expect(page.getByText("dosya.dev hesabınızda oturum açın")).toBeVisible();
    await expect(page.getByText("Parolanızı mı unuttunuz?")).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  guestTest("sign up", async ({ appPage: page }) => {
    await navigateTo(page, "/signup");
    await setLocaleAndReload(page, "tr");
    await expect(page.getByRole("heading", { name: "Hesap oluştur" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Hesap oluştur" })).toBeVisible();
    await expect(page.locator("label").filter({ has: page.locator("input[type=checkbox]") })).toContainText(
      "Hizmet Koşulları'nı kabul ediyor",
    );
    expect(await leftoverEnglish(page)).toEqual([]);

    // The consent check's error.
    await page.getByRole("button", { name: "Hesap oluştur" }).click();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  guestTest("forgot password", async ({ appPage: page }) => {
    await navigateTo(page, "/forgot-password");
    await setLocaleAndReload(page, "tr");
    await expect(page.getByRole("heading", { name: "Parolanızı mı unuttunuz?" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sıfırlama kodu gönder" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);

    await page.getByPlaceholder("siz@ornek.com").fill("test@dosya.dev");
    await page.getByRole("button", { name: "Sıfırlama kodu gönder" }).click();
    await expect(page.getByRole("heading", { name: "Sıfırlama kodu" })).toBeVisible();
    await expect(page.getByText("test@dosya.dev adresine 6 haneli bir kod gönderdik.")).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  guestTest("two-factor", async ({ appPage: page }) => {
    await navigateTo(page, "/2fa");
    await setLocaleAndReload(page, "tr");
    await expect(page.getByRole("heading", { name: "İki adımlı doğrulama" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Doğrula" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Kurtarma kodu kullan" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);

    await page.getByRole("button", { name: "Kurtarma kodu kullan" }).click();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  guestTest("verify email", async ({ appPage: page }) => {
    await navigateTo(page, "/verify");
    await setLocaleAndReload(page, "tr");
    await expect(page.getByRole("heading", { name: "E-posta adresinizi doğrulayın" })).toBeVisible();
    await expect(page.getByRole("button", { name: "E-postayı doğrula" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
  });
});

base.describe("create workspace in Turkish", () => {
  base("first workspace screen", async () => {
    const mock = await startMockServer({ authenticated: true, workspaces: [] });
    const { app, cleanup } = await launchApp(mock.url);
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      await setLocaleAndReload(page, "tr");
      await expect(page.getByRole("heading", { name: "Çalışma alanınızı oluşturun" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Çalışma alanının sundukları" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Çalışma alanı oluştur" })).toBeVisible();
      expect(await leftoverEnglish(page)).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});

test.describe("dashboards in Turkish", () => {
  test("dashboard", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    await expect(page.getByRole("heading", { name: "Tekrar hoş geldiniz, Test User" })).toBeVisible();
    await expect(page.locator("main")).toContainText("Toplam dosya");
    await expect(page.locator("main")).toContainText("Son dosyalar");
    // Storage categories are names the server sends (GET /api/dashboard
    // storage_breakdown), shown as they arrive.
    expect(await leftoverEnglish(page, "main", { allow: ["Documents", "Images", "Videos"] })).toEqual([]);
  });

  test("workspace dashboard", async ({ appPage: page }) => {
    await navigateTo(page, "/workspaces");
    await switchLanguage(page, "tr");
    await expect(page.getByRole("heading", { name: "Çalışma alanı genel bakışı" })).toBeVisible();
    await expect(page.locator("main")).toContainText("Depolama alanınız");
    await expect(page.locator("main")).toContainText("Toplam");
    await expect(page.locator("main")).toContainText("Kullanılan:");
    expect(await leftoverEnglish(page, "main")).toEqual([]);
  });
});
