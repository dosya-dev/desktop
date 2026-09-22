import { test, expect, navigateTo, electronAppFor } from "../fixtures";

test.describe("Settings Page", () => {
  test("Troubleshooting offers a cache clear that reports success", async ({ appPage }) => {
    await navigateTo(appPage, "/settings");

    await expect(appPage.getByText("Troubleshooting")).toBeVisible();
    await appPage.getByRole("button", { name: "Clear cache" }).click();
    await expect(appPage.getByText("Cache cleared")).toBeVisible({ timeout: 10_000 });
  });

  test("Reset app data confirms, then quits the app", async ({ appPage }) => {
    await navigateTo(appPage, "/settings");

    await appPage.getByRole("button", { name: "Reset app data" }).click();
    // The confirmation names what is deleted and what is not.
    await expect(appPage.getByText("Reset app data?")).toBeVisible();
    await expect(appPage.getByText(/Sync folder settings/)).toBeVisible();
    await expect(appPage.getByText(/cloud are not deleted/)).toBeVisible();

    // Cancel leaves everything standing.
    await appPage.getByRole("button", { name: "Cancel" }).click();
    await expect(appPage.getByText("Reset app data?")).toHaveCount(0);

    // Confirming quits the app (the relaunch is skipped under NODE_ENV=test -
    // a relaunched instance would outlive the harness as an orphan).
    const app = electronAppFor(appPage);
    const closed = app.waitForEvent("close", { timeout: 20_000 });
    await appPage.getByRole("button", { name: "Reset app data" }).click();
    await appPage.getByRole("button", { name: "Reset and restart" }).click();
    await closed;
  });

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
