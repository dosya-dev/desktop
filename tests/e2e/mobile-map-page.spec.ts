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
 *
 * WHY AN IFRAME, AND NOT `page.setContent()`:
 *
 * The artifact is one document with ONE inline <script> carrying the whole
 * maplibre bundle. `page.setContent()` writes that into the app's OWN document,
 * which is app://bundle/index.html - and that document carries this app's
 * Content-Security-Policy, whose script-src is `'self' 'wasm-unsafe-eval'`.
 * Chromium therefore refuses the inline script outright ("Executing inline
 * script violates the following Content Security Policy directive..."), both
 * entry points come back `undefined`, and the spec fails for a reason that has
 * nothing to do with apps/mobile's build output.
 *
 * That used to pass only because the CSP was absent in exactly the
 * configuration the E2E suite runs in - built but unpackaged - which was the
 * NEW-1 gap in the audit. Now that every app: document gets the policy, this
 * spec needs a document of its own.
 *
 * So the artifact is served from the API origin (`frame-src` allows it) by
 * intercepting the request in-process, and lives in an iframe. The CSP of a
 * document does not reach into a cross-origin child, so the inline script runs
 * exactly as it does inside react-native-webview - which is also a more
 * faithful reproduction of the real host than injecting it into this app's
 * document ever was. Everything is then asserted against that frame.
 */
const ARTIFACT_PATH = "/__mobile-map-artifact.html";

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
  const apiBase = await page.evaluate(
    () => (window as any).electronAPI.getApiBase() as Promise<string>,
  );

  await page.route(`**${ARTIFACT_PATH}`, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: mobileMapHtml(),
    }),
  );

  await page.setContent(
    `<iframe id="artifact" src="${apiBase}${ARTIFACT_PATH}" style="width:900px;height:700px;border:0"></iframe>`,
  );
  const element = await page.waitForSelector("#artifact");
  const frame = await element.contentFrame();
  if (!frame) throw new Error("the artifact iframe has no content frame");
  await frame.waitForLoadState("domcontentloaded");

  // If esbuild had truncated the bundle or missed the injection marker, these
  // would be "undefined" and the app would show a permanently blank map.
  const api = await frame.evaluate(() => ({
    init: typeof (window as any).initMap,
    setPins: typeof (window as any).setPins,
  }));
  expect(api).toEqual({ init: "function", setPins: "function" });

  await frame.evaluate(() => {
    (window as any).__posted = [];
    (window as any).ReactNativeWebView = { postMessage: (m: string) => (window as any).__posted.push(m) };
    // hasBasemap false: the same fallback the app uses when R2 has no .pmtiles,
    // and it keeps this test off the network.
    (window as any).initMap({ dark: false, hasBasemap: false, apiBase: "http://127.0.0.1:1" });
  });

  // A real WebGL context, from the real inlined maplibre.
  await expect(async () => {
    expect(await frame.evaluate(() => document.querySelectorAll("canvas.maplibregl-canvas").length)).toBe(1);
  }).toPass({ timeout: 20_000 });

  // The host gates its pin handover on this message, so a page that never sends
  // it renders an empty map no matter how many pins are fetched.
  await expect(async () => {
    const posted = await frame.evaluate(() => (window as any).__posted as string[]);
    expect(posted.some((m) => JSON.parse(m).type === "ready")).toBe(true);
  }).toPass({ timeout: 20_000 });
});
