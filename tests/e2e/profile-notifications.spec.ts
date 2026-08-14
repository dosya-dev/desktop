import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * The settings screen, driven in the real app.
 *
 * Two defects this catches that no unit test can. First, a screen that renders
 * the right rows and writes the wrong key - which is what shipped for months,
 * 18 switches all keyed to preference names the server had stopped storing.
 * Second, the whole-map PUT: this page used to send its ENTIRE preference map
 * on every toggle, so the echoed keys overwrote the one the user had moved and
 * every switch silently did nothing. Both are only visible in the request.
 */
function readPrefWrites(page: Page) {
  return page.evaluate(async () => {
    const apiBase = await (window as any).electronAPI.getApiBase();
    const res = await fetch(`${apiBase}/__test/notification-pref-writes`);
    const body = await res.json();
    return body.writes as Record<string, boolean>[];
  });
}

async function openNotifications(page: Page): Promise<void> {
  await navigateTo(page, "/profile");
  await page.getByText(/notifications/i).first().click();
  await expect(page.getByTestId("notif-group-security")).toBeVisible();
}

test.describe("notification preferences", () => {
  test("renders the 14 groups the server describes, with its labels", async ({ appPage: page }) => {
    await openNotifications(page);
    await expect(page.locator('[data-testid^="notif-group-"]')).toHaveCount(14);
    await expect(page.getByTestId("notif-group-security")).toContainText("Security and sign-in");
    await expect(page.getByTestId("notif-group-transfers")).toContainText("Imports and transfers");
    // The legacy per-type toggles are gone.
    await expect(page.getByText("New login from unknown device")).toHaveCount(0);
  });

  test("a toggle writes its group key, and only that key", async ({ appPage: page }) => {
    await openNotifications(page);
    await page.getByTestId("notif-group-product").getByRole("switch").click();
    await expect.poll(() => readPrefWrites(page)).toEqual([{ product: false }]);
  });

  test("a second toggle does not resend the first", async ({ appPage: page }) => {
    await openNotifications(page);
    await page.getByTestId("notif-group-product").getByRole("switch").click();
    await page.getByTestId("notif-group-comments").getByRole("switch").click();
    await expect.poll(() => readPrefWrites(page)).toEqual([{ product: false }, { comments: false }]);
  });

  test("the opt-in sub-switch writes its own key, not its group's", async ({ appPage: page }) => {
    await openNotifications(page);
    const files = page.getByTestId("notif-group-files");
    await expect(files).toContainText("Uploads to your workspace");
    await files.getByRole("switch").nth(1).click();
    await expect.poll(() => readPrefWrites(page)).toEqual([{ "type:files_uploaded": true }]);
  });

  test("says which groups send regardless of the switch", async ({ appPage: page }) => {
    await openNotifications(page);
    await expect(page.getByTestId("notif-group-security")).toContainText("always sent");
    await expect(page.getByTestId("notif-group-comments")).not.toContainText("always sent");
  });
});
