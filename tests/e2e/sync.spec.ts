import { test, expect, navigateTo } from "../fixtures";

test.describe("Sync Page", () => {
  test("renders sync page with add button", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await expect(appPage.getByText("Sync").first()).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /add sync folder/i }).first(),
    ).toBeVisible();
  });

  test("shows empty state when no sync pairs", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await expect(appPage.getByText(/no sync folders/i)).toBeVisible();
  });

  test("shows tabs for Overview, Issues, and Settings", async ({
    appPage,
  }) => {
    await navigateTo(appPage, "/sync");

    await expect(appPage.getByText("Overview").first()).toBeVisible();
    await expect(appPage.getByText("Issues").first()).toBeVisible();
    await expect(appPage.getByText("Settings").first()).toBeVisible();
  });

  test("Issues tab is clickable", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await appPage.getByText("Issues").first().click();
    await appPage.waitForTimeout(500);

    await expect(
      appPage.getByText(/conflict|issue|no issue|no conflict/i).first(),
    ).toBeVisible();
  });

  test("Settings tab is clickable", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await appPage.getByText("Settings").first().click();
    await appPage.waitForTimeout(500);

    // Settings tab should display some content
    await expect(
      appPage.getByText(/sync|pause|interval|transfer/i).first(),
    ).toBeVisible();
  });
});
