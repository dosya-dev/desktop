import { test } from "@playwright/test";
import { launchApp, expect } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";

/**
 * Reclaim must be invisible: a destroyed-and-recreated window has to come
 * back with the SAME geometry and on the SAME route the user left it on.
 * Drives the real main process, like window-reclaim.spec.ts.
 */
test.describe("reclaim continuity", () => {
  test("window bounds survive destroy + recreate", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_WINDOW_RECLAIM_MS: "700" });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      const wanted = { x: 60, y: 60, width: 1000, height: 700 };
      await app.evaluate(({ BrowserWindow }, b) => BrowserWindow.getAllWindows()[0].setBounds(b), wanted);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());

      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 10_000 })
        .toBe(0);

      const newWindow = app.waitForEvent("window");
      await app.evaluate(({ app: electronApp }) => { electronApp.emit("activate"); });
      await newWindow;

      const got = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getBounds());
      // Exact on size; small tolerance on position for OS window-manager nudges.
      expect(got.width).toBe(wanted.width);
      expect(got.height).toBe(wanted.height);
      expect(Math.abs(got.x - wanted.x)).toBeLessThanOrEqual(5);
      expect(Math.abs(got.y - wanted.y)).toBeLessThanOrEqual(5);
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });

  test("the last route survives destroy + recreate", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_WINDOW_RECLAIM_MS: "700" });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      // Leave the app on /files, the page a file-manager user actually lives on.
      await page.evaluate(() => { window.location.hash = "#/files"; });
      await page.waitForTimeout(500);

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), { timeout: 10_000 })
        .toBe(0);

      const newWindow = app.waitForEvent("window");
      await app.evaluate(({ app: electronApp }) => { electronApp.emit("activate"); });
      const page2 = await newWindow;

      // The recreated window must land back on /files - NOT /dashboard.
      await page2.waitForFunction(() => window.location.hash.includes("/files"), { timeout: 15_000 });
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});
