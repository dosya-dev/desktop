import { test, expect, navigateTo } from "../fixtures";

test.describe("Profile Page", () => {
  test("renders profile page with sidebar tabs", async ({ appPage }) => {
    await navigateTo(appPage, "/profile");

    await expect(appPage.getByText(/identity/i).first()).toBeVisible();
    await expect(appPage.getByText(/password/i).first()).toBeVisible();
    await expect(appPage.getByText(/sessions/i).first()).toBeVisible();
  });

  test("Identity section shows user info", async ({ appPage }) => {
    await navigateTo(appPage, "/profile");

    await expect(appPage.getByText("Test User").first()).toBeVisible();
    await expect(appPage.getByText("test@dosya.dev").first()).toBeVisible();
  });

  test("shows member since date", async ({ appPage }) => {
    await navigateTo(appPage, "/profile");

    await expect(appPage.getByText(/member since/i)).toBeVisible();
  });

  test("Password tab shows password section", async ({ appPage }) => {
    await navigateTo(appPage, "/profile");

    await appPage.getByText(/password/i).first().click();
    await appPage.waitForTimeout(500);

    // Password & 2FA tab shows a "Change password" button
    await expect(
      appPage.getByRole("button", { name: /change password/i }),
    ).toBeVisible();
  });

  test("Sessions tab shows active sessions", async ({ appPage }) => {
    await navigateTo(appPage, "/profile");

    await appPage.getByText(/sessions/i).first().click();
    await appPage.waitForTimeout(500);

    await expect(
      appPage.getByText(/chrome|macOS|current/i).first(),
    ).toBeVisible();
  });

  test("API keys tab shows management page", async ({ appPage }) => {
    await navigateTo(appPage, "/profile");

    await appPage.getByText(/api key/i).first().click();
    await appPage.waitForTimeout(500);

    // Desktop app shows "Manage API keys" heading and "Open on web" link
    await expect(appPage.getByRole("heading", { name: /manage api keys/i })).toBeVisible();
    await expect(appPage.getByText(/open on web/i)).toBeVisible();
  });
});
