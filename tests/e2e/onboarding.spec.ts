import { guestTest as test, expect, navigateTo } from "../fixtures";

test.describe("Onboarding", () => {
  test("renders welcome screen with step indicators", async ({ appPage }) => {
    await navigateTo(appPage, "/onboarding");

    await expect(appPage.getByText("Welcome to dosya.dev")).toBeVisible();
    await expect(appPage.getByRole("button", { name: "Next" })).toBeVisible();
    await expect(appPage.getByText("Skip onboarding")).toBeVisible();
  });

  test("can navigate through all steps", async ({ appPage }) => {
    await navigateTo(appPage, "/onboarding");

    const nextBtn = appPage.getByRole("button", { name: "Next" });

    // Step 2
    await nextBtn.click();
    await expect(appPage.getByRole("heading", { name: "Sync folders automatically" })).toBeVisible();

    // Step 3
    await nextBtn.click();
    await expect(appPage.getByRole("heading", { name: "Upload anything, instantly" })).toBeVisible();

    // Step 4
    await nextBtn.click();
    await expect(appPage.getByRole("heading", { name: "Secure by default" })).toBeVisible();

    // Step 5 — last step, button changes to "Get Started"
    await nextBtn.click();
    await expect(appPage.getByRole("heading", { name: "Stay in the loop" })).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: "Get Started" }),
    ).toBeVisible();
  });

  test("Get Started navigates to login", async ({ appPage }) => {
    await navigateTo(appPage, "/onboarding");

    // Navigate to last step
    const nextBtn = appPage.getByRole("button", { name: "Next" });
    for (let i = 0; i < 4; i++) await nextBtn.click();

    await appPage.getByRole("button", { name: "Get Started" }).click();

    // Should arrive at login page
    await expect(appPage.getByText("Welcome back")).toBeVisible();
  });

  test("Skip onboarding navigates to login", async ({ appPage }) => {
    await navigateTo(appPage, "/onboarding");

    await appPage.getByText("Skip onboarding").click();

    await expect(appPage.getByText("Welcome back")).toBeVisible();
  });

  test("step indicators are clickable", async ({ appPage }) => {
    await navigateTo(appPage, "/onboarding");

    // Click the "Secure" step in the sidebar
    await appPage.getByRole("button", { name: /Secure/ }).click();
    await expect(appPage.getByRole("heading", { name: "Secure by default" })).toBeVisible();
  });
});
