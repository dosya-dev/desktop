import { test, expect, navigateTo, resizeWindow } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Two things about the viewer's own chrome.
 *
 * The viewer is a full-window overlay, so it covers the title bar rather than
 * sitting below it. On macOS the OS draws the traffic lights at (16,16) over
 * whatever the renderer paints, and the header started its filename at 16px -
 * so the name rendered underneath the window buttons.
 *
 * The version panel was a permanent 208px column, shown even for files with a
 * single version. It then collapsed behind a header toggle, but carried a
 * `hidden md:flex` gate - on a window narrower than 768px (the app allows 700)
 * the toggle rendered and the panel never did, so clicking it did nothing.
 */

async function openViewer(page: Page): Promise<void> {
  await navigateTo(page, "/files?view=file_1");
  await expect(page.getByTestId("viewer-versions-toggle").or(page.locator("main"))).toBeVisible();
}

test.describe("viewer chrome", () => {
  test("the filename starts clear of the macOS traffic lights", async ({ appPage: page }) => {
    // The test app runs with platform darwin, so the inset should apply.
    const platform = await page.evaluate(() => document.documentElement.dataset.platform);
    test.skip(platform !== "darwin", "traffic lights are macOS-only");

    await openViewer(page);
    const name = page.locator('[class*="titlebar-inset"] span').first();
    const box = await name.boundingBox();
    expect(box).not.toBeNull();
    // 80px of inset, minus a little slack for the icon that precedes the name.
    expect(box!.x).toBeGreaterThanOrEqual(60);
  });

  test("a file with one version offers no version control at all", async ({ appPage: page }) => {
    // file_1 has a single version, so neither the toggle nor the panel belongs.
    await openViewer(page);
    await expect(page.getByTestId("viewer-versions-toggle")).toHaveCount(0);
    await expect(page.getByTestId("viewer-versions-panel")).toHaveCount(0);
  });

  test("the version panel is collapsed until asked for, and remembers", async ({ appPage: page }) => {
    // file_v1 is the mock's versioned file - three versions.
    await navigateTo(page, "/files?view=file_v1");

    const toggle = page.getByTestId("viewer-versions-toggle");
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveText("3");

    // Mounted but hidden, not absent: the panel stays in the tree so the
    // open/collapse is a width transition rather than a teleport.
    await expect(page.getByTestId("viewer-versions-panel")).toBeAttached();
    await expect(page.getByTestId("viewer-versions-panel")).toBeHidden();
    await toggle.click();
    await expect(page.getByTestId("viewer-versions-panel")).toBeVisible();

    // Collapsing from inside the panel works too, and the choice sticks.
    await page.getByRole("button", { name: "Collapse versions" }).click();
    await expect(page.getByTestId("viewer-versions-panel")).toBeHidden();
    expect(
      await page.evaluate(() => localStorage.getItem("dosya_viewer_versions_open")),
    ).toBe("0");
  });

  test("the version panel opens on a narrow window too", async ({ appPage: page }) => {
    // Regression: the panel was gated behind `hidden md:flex`, so below 768px
    // the header toggle appeared to do nothing.
    await resizeWindow(page, 700, 600);
    await navigateTo(page, "/files?view=file_v1");

    await page.getByTestId("viewer-versions-toggle").click();
    const panel = page.getByTestId("viewer-versions-panel");
    await expect(panel).toBeVisible();
    const box = await panel.boundingBox();
    expect(box!.width).toBeGreaterThan(180);
  });
});
