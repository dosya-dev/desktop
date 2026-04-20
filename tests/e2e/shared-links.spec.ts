import { test, expect, navigateTo } from "../fixtures";

test.describe("Shared Links Page", () => {
  test("renders shared links page with tabs", async ({ appPage }) => {
    await navigateTo(appPage, "/shared");

    await expect(appPage.getByText("Shared").first()).toBeVisible();
    // Should show "By me" and "With me" tabs
    await expect(appPage.getByText("By me").first()).toBeVisible();
  });

  test("shows filter chips", async ({ appPage }) => {
    await navigateTo(appPage, "/shared");

    await expect(appPage.getByText("All").first()).toBeVisible();
    await expect(appPage.getByText("Active").first()).toBeVisible();
  });

  test("shows overview stats panel", async ({ appPage }) => {
    await navigateTo(appPage, "/shared");

    await expect(appPage.getByText("Overview").first()).toBeVisible();
    await expect(appPage.getByText(/active links/i).first()).toBeVisible();
  });

  test("shows shared file data", async ({ appPage }) => {
    await navigateTo(appPage, "/shared");

    // The mock share has "Project Report.pdf"
    await expect(
      appPage.getByText("Project Report.pdf").first(),
    ).toBeVisible();
  });
});
