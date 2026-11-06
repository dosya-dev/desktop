import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Trackpad pinch reaches the page as wheel events with ctrlKey set; Playwright
 * produces the same events with Control held during mouse.wheel.
 */
async function pinchOut(page: Page, x: number, y: number) {
  await page.mouse.move(x, y);
  await page.keyboard.down("Control");
  for (let i = 0; i < 6; i++) await page.mouse.wheel(0, -8);
  await page.keyboard.up("Control");
}

const zoomOf = (page: Page) => page.evaluate(() => window.electronAPI.getZoom());

test.describe("Interface zoom", () => {
  test("a pinch zooms the interface and Appearance shows and resets it", async ({ appPage }) => {
    await navigateTo(appPage, "/profile");
    await appPage.getByRole("button", { name: "Appearance" }).click();
    const percent = appPage.getByTestId("zoom-percent");
    await expect(percent).toHaveText("100%");

    await pinchOut(appPage, 600, 400);
    await expect.poll(() => zoomOf(appPage)).toBeGreaterThan(1.2);
    await expect(percent).not.toHaveText("100%");

    await appPage.getByRole("button", { name: "Actual Size" }).click();
    await expect(percent).toHaveText("100%");
    await appPage.getByRole("button", { name: "Zoom In" }).click();
    await expect(percent).toHaveText("110%");
    await appPage.getByRole("button", { name: "Actual Size" }).click();
    await expect(percent).toHaveText("100%");
  });

  test("a pinch over the map zooms the map, not the interface", async ({ appPage }) => {
    await navigateTo(appPage, "/map");
    const canvas = appPage.locator(".maplibregl-canvas");
    await expect(canvas).toBeVisible({ timeout: 15000 });
    const box = (await canvas.boundingBox())!;
    await pinchOut(appPage, box.x + box.width / 2, box.y + box.height / 2);
    await appPage.waitForTimeout(500);
    expect(await zoomOf(appPage)).toBe(1);
  });
});
