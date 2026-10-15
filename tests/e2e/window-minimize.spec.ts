import { test } from "@playwright/test";
import { launchApp, expect } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";

/**
 * Minimize, as opposed to hide (`window-reclaim.spec.ts` covers hide).
 *
 * Before DSK-003 there was no `minimize` handler anywhere in index.ts: the
 * poller cadence and the status broadcast were wired to `hide`/`show` only.
 * A minimized window therefore kept a full renderer rendering sync status at
 * 2 Hz, on any platform where `minimize()` does not also emit `hide`.
 *
 * WHAT IS AND IS NOT ASSERTED HERE, because a first pass got this wrong.
 *
 * Minimizing must stop the WORK and must NOT take the window away. A first
 * pass widened the reclaim predicate to `!isVisible() || isMinimized()`,
 * which destroyed a minimized window after the reclaim delay - on Windows
 * and Linux that silently removes the taskbar button, and on a Linux desktop
 * with no system tray it leaves the process running with no window, no
 * taskbar entry and no tray icon. So "is it destroyed?" is the wrong
 * question, and it is also not a question with one cross-platform answer:
 * macOS's `minimize()` emits `hide`, so macOS legitimately reclaims a
 * minimized window and Windows/Linux legitimately do not.
 *
 * What IS platform-independent, and is what a user actually needs, is: after
 * minimizing and waiting past the reclaim delay, the app is still running and
 * a usable window showing current state can be got back. That holds whichever
 * way the platform went, and it is exactly what the Linux-without-a-tray case
 * breaks. Both routes back are tried, since which one applies depends on
 * whether the platform turned the minimize into a hide.
 *
 * The decision logic itself is unit-tested (`window-reclaim.test.ts` pins
 * that a minimized-but-visible window is not reclaimed and a hidden one is;
 * `broadcast-targets.test.ts` pins that a minimized window stops receiving
 * status). This spec is here so CI can confirm the WIRING on Windows and
 * Linux rather than inferring it from macOS.
 *
 * WHEN MINIMIZE IS NOT REAL. A headless Linux runner under xvfb has no window
 * manager and `minimize()` can be a no-op there: nothing changes, no event
 * fires. That is an untestable environment, not a failing app, so each case
 * checks that minimize actually took effect and SKIPS with that message if it
 * did not. A skip on one platform is a gap to report, never a pass.
 */
/** A wait that does not depend on a live page - see its use below. */
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test.describe("window minimize", () => {
  /** True once the platform agrees the window is no longer on screen. */
  const minimizeTookEffect = (app: Awaited<ReturnType<typeof launchApp>>["app"]) =>
    app.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (!win || win.isDestroyed()) return true;
      return win.isMinimized() || !win.isVisible();
    });

  test("minimizing past the reclaim delay still leaves a usable window reachable", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_WINDOW_RECLAIM_MS: "700" });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await sleep(300);
      const effective = await minimizeTookEffect(app).catch(() => true);
      test.skip(
        !effective,
        "minimize() had no effect in this environment (no window manager), so this cannot be exercised here",
      );

      // Well past the reclaim delay, so whichever way the platform went has
      // settled: macOS will have turned this into a hide and reclaimed the
      // window, Windows and Linux will still have it minimized.
      //
      // Slept in the TEST process, not with `page.waitForTimeout`. On macOS
      // this is exactly the window in which the page is destroyed, so a
      // page-bound wait fails with "Target page, context or browser has been
      // closed" - which is the outcome under test, not an error.
      await sleep(2_000);

      const stillThere = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length > 0);

      if (stillThere) {
        // Windows/Linux: the window survived, as it must - the taskbar button
        // is the user's way back and destroying it would remove it.
        await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());
      } else {
        // macOS: minimize became a hide and the renderer was reclaimed. The
        // dock/tray route must recreate it - and this also proves the app did
        // not quit when its last window went away.
        const created = app.waitForEvent("window");
        await app.evaluate(({ app: electronApp }) => {
          electronApp.emit("activate");
        });
        await created;
      }

      // The property that matters either way: a usable window, on the app, not
      // minimized.
      const live = await app.windows();
      const front = live[live.length - 1];
      await front.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      const usable = await app.evaluate(({ BrowserWindow }) => {
        const win = BrowserWindow.getAllWindows()[0];
        return Boolean(win && !win.isDestroyed() && win.isVisible() && !win.isMinimized());
      });
      expect(usable).toBe(true);
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });

  test("restoring before the delay keeps the same window alive", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_WINDOW_RECLAIM_MS: "1500" });
    try {
      const page = await app.firstWindow();
      await page.waitForLoadState("domcontentloaded");
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
      await sleep(300);
      const effective = await minimizeTookEffect(app).catch(() => true);
      test.skip(
        !effective,
        "minimize() had no effect in this environment (no window manager), so this cannot be exercised here",
      );

      await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].restore());

      // Well past the reclaim delay. This end state is the same on every
      // platform: on macOS the `restore`/`show` cancelled the timer the `hide`
      // armed, and on Windows/Linux no timer was ever armed.
      await sleep(2_500);
      const state = await app.evaluate(({ BrowserWindow }) => {
        const wins = BrowserWindow.getAllWindows();
        return { count: wins.length, minimized: wins[0] ? wins[0].isMinimized() : true };
      });
      expect(state).toEqual({ count: 1, minimized: false });
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});
