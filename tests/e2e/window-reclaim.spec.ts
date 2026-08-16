import { test } from "@playwright/test";
import { launchApp, expect } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";

/**
 * Destroy-on-hide: the app lives in the tray, so a "closed" (hidden) window
 * used to keep a full renderer + GPU process alive indefinitely. After
 * DOSYA_WINDOW_RECLAIM_MS hidden, the window is destroyed to give that memory
 * back; any open path (dock activate, tray, deep link) recreates it.
 *
 * These specs drive the REAL main process: the unit tests prove the timer
 * logic, this proves the wiring - listeners attached to every window
 * generation, stale references guarded, and the app NOT quitting when the
 * last window goes away on any platform.
 */
test.describe("window reclaim (destroy on hide)", () => {
  test("a hidden window is destroyed after the delay, and activate recreates it", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_WINDOW_RECLAIM_MS: "700" });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      // The close button hides the window (tray app) - reproduce that.
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());

      // The renderer's memory only comes back when the window object is gone.
      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), {
          timeout: 10_000,
        })
        .toBe(0);

      // Dock click / tray "Open dosya" funnel into the same recreate path.
      // Recreating also proves the app did NOT quit when its last window went
      // away - the window-all-closed handler must treat reclaim as "still
      // running in the tray" on every platform, Linux included.
      const newWindow = app.waitForEvent("window");
      await app.evaluate(({ app: electronApp }) => {
        electronApp.emit("activate");
      });
      const page2 = await newWindow;
      await page2.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      const visible = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return Boolean(win && !win.isDestroyed() && win.isVisible());
      });
      expect(visible).toBe(true);
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });

  test("showing again before the delay keeps the window alive", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_WINDOW_RECLAIM_MS: "1500" });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].hide());
      await page.waitForTimeout(300);
      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());

      // Well past the reclaim delay: the shown window must have survived it.
      await page.waitForTimeout(2_500);
      const state = await app.evaluate(({ BrowserWindow }) => {
        const wins = BrowserWindow.getAllWindows();
        return { count: wins.length, visible: wins[0] ? wins[0].isVisible() : false };
      });
      expect(state).toEqual({ count: 1, visible: true });
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});
