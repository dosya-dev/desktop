import { test, expect, navigateTo } from "../fixtures";

test.describe("Dashboard", () => {
  test("shows welcome message and stats", async ({ appPage }) => {
    // Authenticated fixture already lands on /dashboard
    await expect(appPage.getByText(/Welcome back.*Test User/)).toBeVisible();

    // Stat cards
    await expect(appPage.getByText("42")).toBeVisible(); // total files
  });

  test("shows recent files list", async ({ appPage }) => {
    await expect(appPage.getByText("Project Report.pdf")).toBeVisible();
    await expect(appPage.getByText("Photo.png")).toBeVisible();
  });

  test("shows storage breakdown", async ({ appPage }) => {
    await expect(appPage.getByText("Storage breakdown")).toBeVisible();
    await expect(appPage.getByText("Documents").first()).toBeVisible();
  });

  test("Upload files button navigates to upload page", async ({ appPage }) => {
    await appPage.getByRole("button", { name: /upload files/i }).click();
    await appPage.waitForTimeout(500);
    await expect(
      appPage.getByText(/drag|drop|browse/i).first(),
    ).toBeVisible();
  });

  test("shows sync status card", async ({ appPage }) => {
    await expect(appPage.getByText("Sync").first()).toBeVisible();
  });
});
