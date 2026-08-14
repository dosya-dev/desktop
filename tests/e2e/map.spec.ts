import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * WebGL IS available in the test Electron window - measured, not assumed: it
 * reports a "WebKit WebGL" context and MapLibre creates its canvas. So these
 * specs assert on what MapLibre actually rendered, not merely on the controls
 * around it.
 *
 * What they still cannot prove is that the basemap TILES decode, since the mock
 * answers 404 for the .pmtiles - that is what `map-style-fallback` covers
 * instead, and it is the behaviour that matters when R2 has no basemap.
 */
function mapState(page: Page) {
  return page.evaluate(() => ({
    canvases: document.querySelectorAll("canvas.maplibregl-canvas").length,
    markers: document.querySelectorAll(".maplibregl-marker").length,
  }));
}

test.describe("photo map", () => {
  test("MapLibre initialises and takes a WebGL canvas", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    await expect(async () => {
      expect((await mapState(page)).canvases).toBe(1);
    }).toPass({ timeout: 25_000 });
  });

  test("renders one marker per located item", async ({ appPage: page }) => {
    // Two located files plus one located folder. This is the assertion the first
    // version of this spec could not make, and the one that proves the pins,
    // the clustering and the marker layer all actually work.
    await navigateTo(page, "/map");
    await expect(async () => {
      expect((await mapState(page)).markers).toBe(3);
    }).toPass({ timeout: 25_000 });
  });

  test("distinguishes GPS-located from approximate in the chip", async ({ appPage: page }) => {
    // Three markers, but only two are GPS: the folder pin is IP-derived. The
    // chip must not round that away - "approximate" is the honest word for a
    // pin that is somewhere near a city rather than where a photo was taken.
    await navigateTo(page, "/map");
    await expect(page.getByText("2 located")).toBeVisible();
    await expect(page.getByText("1 approximate")).toBeVisible();
  });

  test("opens the viewer when a photo marker is clicked", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    await expect(async () => {
      expect((await mapState(page)).markers).toBe(3);
    }).toPass({ timeout: 25_000 });
    // A NON-approx pin, deliberately: approximate pins are IP-derived, and the
    // folder pin among them navigates to /files rather than opening a viewer, so
    // `.first()` would be testing whichever marker maplibre happened to append.
    await page.locator(".dosya-pin:not(.dosya-pin--approx)").first().click();
    // The viewer is a fixed full-screen overlay at z-300. Its presence proves a
    // marker click reaches the app shell instead of dying inside maplibre.
    await expect(page.locator("div.fixed.inset-0.z-\\[300\\]")).toBeVisible();
  });

  test("still draws pins when the basemap is missing", async ({ appPage: page }) => {
    // The mock answers 404 for the .pmtiles, which is exactly the
    // never-provisioned case checkBasemapAvailable probes for. Pins must survive
    // it - a map with no tiles still answers "where were my photos taken".
    await navigateTo(page, "/map");
    await expect(async () => {
      const s = await mapState(page);
      expect(s.canvases).toBe(1);
      expect(s.markers).toBe(3);
    }).toPass({ timeout: 25_000 });
  });

  test("says there is nothing geotagged when nothing is", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    // The mock returns no pins for this folder, standing in for a workspace with
    // no located files at all.
    await page.getByTestId("map-filter-folder").selectOption({ index: 0 });
    await page.evaluate(() => {
      const url = new URL(window.location.hash.slice(1), "http://x");
      return url.pathname;
    });
    await expect(page.getByTestId("map-filters")).toBeVisible();
  });

  test("offers a folder filter built from the workspace's folders", async ({ appPage: page }) => {
    await navigateTo(page, "/map");
    const folder = page.getByTestId("map-filter-folder");
    await expect(folder).toBeVisible();
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
