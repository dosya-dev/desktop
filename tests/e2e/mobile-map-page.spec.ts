import { test, expect } from "../fixtures";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Verifies the MOBILE map artifact, from the desktop app's Electron window.
 *
 * apps/mobile ships src/map/mapHtml.generated.ts - one HTML string with maplibre
 * inlined - into a react-native-webview. Jest mocks that WebView, so nothing on
 * the mobile side ever executes the bundle. This loads the exact shipped string
 * into a real WebGL-capable browser, which is the only place it runs at all.
 *
 * DELIBERATELY SHALLOW. An earlier version drove setPins with pin objects and
 * clicked `.pin` markers, and it broke the moment apps/mobile reworked its
 * renderer - the pin shape and the DOM markers were implementation details this
 * app has no business pinning from another app's build output. What is asserted
 * here is only the contract that makes the artifact usable at all: it parses, it
 * boots maplibre against a real WebGL context, it exposes the two entry points
 * React Native calls, and it reports readiness back over the bridge.
 *
 * NOT covered, and covered nowhere else: that a pin tap reaches the host. That
 * needs assertions against apps/mobile's current renderer, and belongs with it.
 *
 * ONE test, not three. Each one launches its own Electron app and takes its own
 * WebGL context, and three of those in a file was enough resource pressure that
 * the cheapest of them failed in-file while passing alone.
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

test("the mobile map artifact boots and reports ready", async ({ appPage: page }) => {
  await page.setContent(mobileMapHtml());

  // If esbuild had truncated the bundle or missed the injection marker, these
  // would be "undefined" and the app would show a permanently blank map.
  const api = await page.evaluate(() => ({
    init: typeof (window as any).initMap,
    setPins: typeof (window as any).setPins,
  }));
  expect(api).toEqual({ init: "function", setPins: "function" });

  await page.evaluate(() => {
    (window as any).__posted = [];
    (window as any).ReactNativeWebView = { postMessage: (m: string) => (window as any).__posted.push(m) };
    // hasBasemap false: the same fallback the app uses when R2 has no .pmtiles,
    // and it keeps this test off the network.
    (window as any).initMap({ dark: false, hasBasemap: false, apiBase: "http://127.0.0.1:1" });
  });

  // A real WebGL context, from the real inlined maplibre.
  await expect(async () => {
    expect(await page.evaluate(() => document.querySelectorAll("canvas.maplibregl-canvas").length)).toBe(1);
  }).toPass({ timeout: 20_000 });

  // The host gates its pin handover on this message, so a page that never sends
  // it renders an empty map no matter how many pins are fetched.
  await expect(async () => {
    const posted = await page.evaluate(() => (window as any).__posted as string[]);
    expect(posted.some((m) => JSON.parse(m).type === "ready")).toBe(true);
  }).toPass({ timeout: 20_000 });
});
