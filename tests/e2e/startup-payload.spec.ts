import { test } from "@playwright/test";
import { launchApp, expect } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";

/**
 * Startup-payload regression tests.
 *
 * PerformanceResourceTiming is NOT usable here: Chromium records no resource
 * entries for custom-scheme (app://) subresources at all - only the mock API's
 * http calls show up. What IS reliable is the DOM Vite leaves behind: the
 * entry <script> plus a <link rel=modulepreload> for every chunk it requests,
 * both eagerly (index.html) and on dynamic import (__vitePreload appends the
 * links). Sizes come from re-fetching those same-origin URLs in-page.
 */

/** Serialized into page.evaluate - every JS chunk the renderer has requested. */
const collectJsUrls = (): string[] => {
  const urls = new Set<string>();
  document.querySelectorAll("script[src]").forEach((s) => urls.add((s as HTMLScriptElement).src));
  document.querySelectorAll("link[rel=modulepreload]").forEach((l) => urls.add((l as HTMLLinkElement).href));
  return [...urls].filter((u) => u.endsWith(".js"));
};

test.describe("startup payload", () => {
  test("map code loads on the map page, and ONLY there", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url);
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      const dashJs = await page.evaluate(collectJsUrls);
      expect(dashJs.some((n) => n.includes("vendor-map"))).toBe(false);
      expect(dashJs.some((n) => n.includes("vendor-shiki"))).toBe(false);

      // The chunk must exist and load when the map is actually visited -
      // this is the half that fails while the split does not exist yet.
      await page.evaluate(() => { window.location.hash = "#/map"; });
      await expect
        .poll(
          () => page.evaluate(collectJsUrls).then((urls) => urls.some((n) => n.includes("vendor-map"))),
          { timeout: 15_000 },
        )
        .toBe(true);
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });

  test("dashboard startup JS stays under budget", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url);
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      const totalJs = await page.evaluate(async () => {
        const urls = new Set<string>();
        document.querySelectorAll("script[src]").forEach((s) => urls.add((s as HTMLScriptElement).src));
        document.querySelectorAll("link[rel=modulepreload]").forEach((l) => urls.add((l as HTMLLinkElement).href));
        let sum = 0;
        for (const url of [...urls].filter((u) => u.endsWith(".js"))) {
          const blob = await (await fetch(url)).blob();
          sum += blob.size;
        }
        return sum;
      });
      expect(totalJs).toBeGreaterThan(500_000);   // sanity: chunks are visible and measurable
      expect(totalJs).toBeLessThan(4_000_000);    // budget: map + shiki are NOT on this path
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });

  test("hot page chunks are prefetched during idle, before any navigation", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url);
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      // No navigation happens here - the chunks must arrive on their own.
      for (const chunk of ["FileBrowserPage", "UploadPage", "SettingsPage", "SyncPage"]) {
        await expect
          .poll(
            () => page.evaluate(collectJsUrls).then((urls) => urls.some((n) => n.includes(chunk))),
            { timeout: 10_000, message: `${chunk} chunk was never prefetched` },
          )
          .toBe(true);
      }
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});
