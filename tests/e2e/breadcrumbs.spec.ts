import { test, expect, navigateTo } from "../fixtures";

/**
 * A deep folder used to run the breadcrumb trail straight through the toolbar:
 * the trail sat in a flex item with the default min-width:auto, so it never
 * gave way and Search/Sort/Columns/Upload were pushed off the right edge.
 *
 * These specs pin the two halves of the fix - the trail collapses, and the
 * toolbar keeps its position no matter how deep the path gets.
 */

test.describe("breadcrumbs", () => {
  test("a deep path never pushes the toolbar off screen", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    const upload = page.locator("main").getByRole("button", { name: "Upload", exact: true });
    const shallow = await upload.boundingBox();

    // Six levels, each with a long name - the case that broke.
    await navigateTo(page, "/files?folder=deep_6");
    await expect(page.getByRole("button", { name: /Show \d+ hidden folders?/ })).toBeVisible();

    const deep = await upload.boundingBox();
    expect(shallow).not.toBeNull();
    expect(deep).not.toBeNull();
    // The button has not moved, and is still inside the window.
    expect(Math.abs(deep!.x - shallow!.x)).toBeLessThan(2);
    expect(deep!.x + deep!.width).toBeLessThanOrEqual(page.viewportSize()?.width ?? 1280);
  });

  test("the collapsed middle is reachable, not just hidden", async ({ appPage: page }) => {
    await navigateTo(page, "/files?folder=deep_6");

    // Six crumbs, three shown, so three hide behind the menu.
    const more = page.getByRole("button", { name: /Show 3 hidden folders/ });
    await expect(more).toBeVisible();

    await more.click();
    // The hidden ancestors are listed and navigable - collapsing must not
    // strand the top of the tree.
    await expect(page.getByRole("button", { name: /Supporting Material 1$/ })).toBeVisible();
    await page.getByRole("button", { name: /Supporting Material 1$/ }).click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("folder=deep_1");
  });

  test("a shallow path shows no collapse control at all", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    // Scoped to the content area: the sidebar carries its own "Files" row, and
    // this is asserting about the breadcrumb trail's root.
    const main = page.locator("main");
    await expect(main.getByRole("button", { name: "Files", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: /hidden folders?/ })).toHaveCount(0);
  });
});
