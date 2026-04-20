import { test, expect, navigateTo } from "../fixtures";

test.describe("Team Page", () => {
  test("renders team page with member list", async ({ appPage }) => {
    await navigateTo(appPage, "/team");

    await expect(appPage.getByText("Test User").first()).toBeVisible();
    await expect(appPage.getByText("test@dosya.dev").first()).toBeVisible();
  });

  test("shows member role badge", async ({ appPage }) => {
    await navigateTo(appPage, "/team");

    await expect(appPage.getByText("Owner").first()).toBeVisible();
  });

  test("has invite button", async ({ appPage }) => {
    await navigateTo(appPage, "/team");

    await expect(
      appPage.getByRole("button", { name: /invite/i }),
    ).toBeVisible();
  });

  test("invite button opens modal with email input", async ({ appPage }) => {
    await navigateTo(appPage, "/team");

    await appPage.getByRole("button", { name: /invite/i }).click();
    await appPage.waitForTimeout(500);

    // Modal should show "Invite to workspace" and an email input
    await expect(appPage.getByText(/invite to workspace/i)).toBeVisible();
    await expect(
      appPage.getByPlaceholder(/colleague@example|email/i),
    ).toBeVisible();
  });
});
