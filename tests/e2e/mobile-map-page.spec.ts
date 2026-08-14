import { test, expect } from "../fixtures";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Verifies the MOBILE map artifact, from the desktop app's Electron window.
 *
 * apps/mobile ships src/map/mapHtml.generated.ts - one HTML string with maplibre
 * inlined - into a react-native-webview. Jest mocks that WebView, so nothing on
 * the mobile side ever executes the bundle. This loads the exact shipped string
 * into a real WebGL-capable browser and drives its public API.
 *
 * It lives here because this is the only Playwright project in the repo with a
 * browser that needs no dev server. It tests apps/mobile's artifact, not desktop.
 */
function mobileMapHtml(): string {
  const generated = readFileSync(
    join(__dirname, "../../../mobile/src/map/mapHtml.generated.ts"),
    "utf8",
  );
  const start = generated.indexOf("export const MAP_HTML = ");
  const json = generated.slice(start + "export const MAP_HTML = ".length).trim().replace(/;\s*$/, "");
  return JSON.parse(json);
}

test.describe("mobile map page", () => {
  test("boots maplibre and plots the pins React Native hands it", async ({ appPage: page }) => {
    await page.setContent(mobileMapHtml());

    // The page exposes exactly two entry points to React Native.
    const api = await page.evaluate(() => ({
      init: typeof (window as any).initMap,
      setPins: typeof (window as any).setPins,
    }));
    expect(api).toEqual({ init: "function", setPins: "function" });

    // No basemap: the same fallback the app uses when R2 has no .pmtiles.
    await page.evaluate(() => (window as any).initMap({ dark: false, hasBasemap: false, apiBase: "http://127.0.0.1:1" }));
    await expect(async () => {
      expect(await page.evaluate(() => document.querySelectorAll("canvas.maplibregl-canvas").length)).toBe(1);
    }).toPass({ timeout: 15_000 });

    await page.evaluate(() =>
      (window as any).setPins(
        [
          { id: "f1", latitude: -33.8688, longitude: 151.2093 },
          { id: "f2", latitude: 51.5074, longitude: -0.1278 },
        ],
        true,
      ),
    );

    // Markers must be absolutely positioned and ON SCREEN - the desktop port
    // shipped with maplibre's stylesheet missing, which left every marker
    // flowing in document order below the fold on a map that looked empty.
    const markers = await page.evaluate(() =>
      [...document.querySelectorAll(".maplibregl-marker")].map((el) => {
        const r = el.getBoundingClientRect();
        return { pos: getComputedStyle(el).position, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width) };
      }),
    );
    expect(markers).toHaveLength(2);
    for (const m of markers) {
      expect(m.pos).toBe("absolute");
      expect(m.w).toBeGreaterThan(0);
      expect(m.y).toBeGreaterThanOrEqual(0);
      expect(m.y).toBeLessThan(await page.evaluate(() => window.innerHeight));
    }
  });

  test("reports a pin tap back to React Native", async ({ appPage: page }) => {
    await page.setContent(mobileMapHtml());
    await page.evaluate(() => {
      (window as any).__posted = [];
      (window as any).ReactNativeWebView = { postMessage: (m: string) => (window as any).__posted.push(m) };
      (window as any).initMap({ dark: false, hasBasemap: false, apiBase: "http://127.0.0.1:1" });
    });
    await expect(async () => {
      expect(await page.evaluate(() => document.querySelectorAll("canvas.maplibregl-canvas").length)).toBe(1);
    }).toPass({ timeout: 15_000 });

    await page.evaluate(() => (window as any).setPins([{ id: "f1", latitude: 0, longitude: 0 }], true));
    await page.locator(".pin").first().click();

    // The bridge is the whole contract: without this message the app cannot open
    // the file a tap landed on.
    const posted = await page.evaluate(() => (window as any).__posted as string[]);
    expect(posted.some((m) => JSON.parse(m).type === "open" && JSON.parse(m).id === "f1")).toBe(true);
  });

  test("announces readiness, which is what gates the pin handover", async ({ appPage: page }) => {
    await page.setContent(mobileMapHtml());
    await page.evaluate(() => {
      (window as any).__posted = [];
      (window as any).ReactNativeWebView = { postMessage: (m: string) => (window as any).__posted.push(m) };
      (window as any).initMap({ dark: false, hasBasemap: false, apiBase: "http://127.0.0.1:1" });
    });
    await expect(async () => {
      const posted = await page.evaluate(() => (window as any).__posted as string[]);
      expect(posted.some((m) => JSON.parse(m).type === "ready")).toBe(true);
    }).toPass({ timeout: 15_000 });
  });
});
