import { test, expect, navigateTo } from "../fixtures";

test.describe("Settings Page", () => {
  test("renders settings page with sidebar tabs", async ({ appPage }) => {
    await navigateTo(appPage, "/settings");

    await expect(appPage.getByText("General").first()).toBeVisible();
    await expect(appPage.getByText(/hard limits/i).first()).toBeVisible();
    await expect(appPage.getByText("Security").first()).toBeVisible();
    await expect(appPage.getByText(/danger/i).first()).toBeVisible();
  });

  test("General tab shows workspace name input", async ({ appPage }) => {
    await navigateTo(appPage, "/settings");

    // General tab should be active by default
    await expect(
      appPage.getByText(/workspace name|name/i).first(),
    ).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /save/i }).first(),
    ).toBeVisible();
  });

  test("Hard limits tab shows storage settings", async ({ appPage }) => {
    await navigateTo(appPage, "/settings");

    await appPage.getByText(/hard limits/i).first().click();

    await expect(
      appPage.getByText(/max file size|storage/i).first(),
    ).toBeVisible();
  });

  test("Security tab shows security toggles", async ({ appPage }) => {
    await navigateTo(appPage, "/settings");

    await appPage.getByText("Security").first().click();

    await expect(
      appPage.getByText(/2fa|share|password/i).first(),
    ).toBeVisible();
  });

  test("Danger zone tab shows delete workspace", async ({ appPage }) => {
    await navigateTo(appPage, "/settings");

    await appPage.getByText(/danger/i).first().click();

    await expect(
      appPage.getByRole("button", { name: /delete/i }).first(),
    ).toBeVisible();
  });
});
