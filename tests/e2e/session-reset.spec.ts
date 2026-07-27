import { test, expect } from "../fixtures";

test.describe("Session reset on logout", () => {
  test("logout reloads the renderer so no in-memory state survives", async ({ appPage }) => {
    // Plant a marker that survives SPA navigation but not a process reload.
    await appPage.evaluate(() => {
      (window as unknown as Record<string, unknown>).__sessionMarker = "before-logout";
    });

    // Sidebar logout button (expanded sidebar renders it with title="Log out")
    await appPage.locator('button[title="Log out"]').click();

    // The renderer must reload: wait until the marker is gone.
    await appPage.waitForFunction(
      () => (window as unknown as Record<string, unknown>).__sessionMarker === undefined,
      { timeout: 15_000 },
    );

    // No toasts may survive into the post-logout screen.
    const toastCount = await appPage.locator("[data-sonner-toast]").count();
    expect(toastCount).toBe(0);
  });

  test("sidebar avatar URL is keyed per account", async ({ appPage }) => {
    const img = appPage.locator('img[src*="/api/me/avatar"]').first();
    await expect(img).toBeVisible({ timeout: 10_000 });
    const src = await img.getAttribute("src");
    // Must carry the user id so two accounts can never share a cached image.
    expect(src).toContain(`u=${encodeURIComponent("user_test_1")}`);
  });
});
