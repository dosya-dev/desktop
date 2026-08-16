import { test, expect, navigateTo, resizeWindow } from "../fixtures";

/**
 * The window minimum dropped from 900x600 to 700x560 so the app can sit beside
 * something else. These specs hold the renderer to that promise: at 700px the
 * sidebar gives way, the files toolbar wraps instead of overflowing, and no
 * page pushes the document sideways.
 *
 * Horizontal scrolling *inside* the file table is deliberate and separate - the
 * assertion here is about the page, not that container.
 */

const NARROW = { w: 700, h: 560 };

/** Does the page itself overflow sideways (as opposed to a scroll container)? */
function pageOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const el = document.documentElement;
    return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
  });
}

test.describe("narrow window", () => {
  test("the sidebar gives way before the content does", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    // Wide: full sidebar, with its collapse control offered.
    await expect(page.getByTestId("sidebar-collapse-toggle")).toBeVisible();
    const wide = await page.locator("aside").first().boundingBox();
    expect(wide!.width).toBeGreaterThan(200);

    await resizeWindow(page, NARROW.w, NARROW.h);

    const narrow = await page.locator("aside").first().boundingBox();
    expect(narrow!.width).toBeLessThan(100);
    // The toggle is withdrawn - the width is deciding, not the user, and a
    // button that undid itself immediately would be a lie.
    await expect(page.getByTestId("sidebar-collapse-toggle")).toHaveCount(0);
  });

  test("no page pushes the document sideways at 700px", async ({ appPage: page }) => {
    await resizeWindow(page, NARROW.w, NARROW.h);

    for (const route of ["/dashboard", "/files", "/upload", "/shared", "/integrations", "/team", "/settings", "/file-requests"]) {
      await navigateTo(page, route);
      const { scrollWidth, clientWidth } = await pageOverflow(page);
      // 1px of slack for sub-pixel rounding.
      expect(scrollWidth, `${route} overflows horizontally`).toBeLessThanOrEqual(clientWidth + 1);
    }
  });

  test("the files toolbar stays reachable instead of running off the edge", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await resizeWindow(page, NARROW.w, NARROW.h);

    const upload = page.locator("main").getByRole("button", { name: "Upload", exact: true });
    await expect(upload).toBeVisible();
    const box = await upload.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(NARROW.w);
  });
});
