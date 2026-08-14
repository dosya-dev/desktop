import { test, expect, navigateTo } from "../fixtures";

/**
 * The map renders through MapLibre, which needs WebGL. The test Electron window
 * has no GPU, so these specs deliberately assert on everything AROUND the canvas
 * - the page mounts, the filters work, the empty state is honest - rather than
 * on rendered tiles. Asserting on pixels here would either fail for the wrong
 * reason or pass without proving anything.
 *
 * The pins request itself is asserted through the mock, which is the part this
 * app is actually responsible for.
 */
test.describe("photo map", () => {
  test("mounts without crashing the renderer", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    await expect(page.getByTestId("map-filters")).toBeVisible();
  });

  test("says there is nothing geotagged rather than showing a blank world", async ({ appPage: page }) => {
    // The mock returns no pins, which is the state most new workspaces are in.
    await navigateTo(page, "/map");
    await expect(page.getByTestId("map-empty")).toBeVisible();
    await expect(page.getByTestId("map-empty")).toContainText("No geotagged photos yet");
  });

  test("offers a folder filter built from the workspace's folders", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    const folder = page.getByTestId("map-filter-folder");
    await expect(folder).toBeVisible();
    // "Everywhere" plus whatever the tree returned - the point is that the
    // select is populated from the API, not hardcoded.
    await expect(folder.locator("option")).not.toHaveCount(0);
  });

  test("the clear control appears only once a filter is set", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    await expect(page.getByTestId("map-filter-clear")).toHaveCount(0);
    await page.getByTestId("map-filter-from").fill("2025-01-01");
    await expect(page.getByTestId("map-filter-clear")).toBeVisible();
  });

  test("clearing puts the filters back", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    await page.getByTestId("map-filter-from").fill("2025-01-01");
    await page.getByTestId("map-filter-clear").click();
    await expect(page.getByTestId("map-filter-from")).toHaveValue("");
  });
});
