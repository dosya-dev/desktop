import { test } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { startMockServer } from "../helpers/mock-api";
import { launchApp } from "../fixtures";

/**
 * Marketing screenshot capture - NOT a test.
 *
 * Drives the real built app (out/main/index.js) against the e2e mock API and
 * captures complete app windows with page.screenshot().
 *
 * The app runs with DOSYA_E2E_PLATFORM=linux so the TitleBar component draws
 * its own window buttons in the DOM (the app's real Linux appearance). On
 * macOS the traffic lights are native chrome (titleBarStyle "hiddenInset"),
 * invisible to page.screenshot, and capturing them with `screencapture -l`
 * requires the terminal to hold the Screen Recording permission - if you have
 * granted that and want native macOS chrome instead, see git history for the
 * screencapture variant of this file.
 *
 * Run:
 *   MARKETING_SHOTS=1 npx playwright test tests/e2e/marketing-shots.spec.ts
 * Output lands in SHOT_DIR (default: apps/desktop/marketing-shots/), one PNG
 * per view and theme, at the display's device scale (2x on Retina).
 *
 * Skipped everywhere by default so CI and normal `npm test` never run it.
 */
test.skip(!process.env.MARKETING_SHOTS, "marketing capture only - set MARKETING_SHOTS=1");

const OUT = process.env.SHOT_DIR || path.join(__dirname, "../../marketing-shots");

// view name -> [route, a selector that proves the view actually rendered]
const VIEWS: Array<[string, string, string]> = [
  ["dashboard", "/dashboard", "text=Storage breakdown"],
  ["files", "/files", "[data-testid=nav-files]"],
  ["sync", "/sync", "[data-testid=nav-sync]"],
  ["lan", "/lan-transfer", "text=/room code/i"],
];

test.setTimeout(300_000);

test("capture desktop app marketing screenshots", async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // A real local folder with real files, so the sync engine has something
  // truthful to show instead of the "No sync folders configured" empty state.
  // /Users/Shared keeps the on-screen path believable (a /var/folders temp
  // hash reads as staged); fall back to a temp dir if it's somehow taken.
  let designDir = "/Users/Shared/Design Assets";
  let syncDir = designDir;
  try {
    fs.mkdirSync(designDir); // throws if it already exists - never clobber
  } catch {
    syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-shots-"));
    designDir = path.join(syncDir, "Design Assets");
    fs.mkdirSync(designDir);
  }
  for (const [file, kb] of [
    ["logo-v3.svg", 24],
    ["pitch-deck.pdf", 8_240],
    ["roadmap.xlsx", 1_800],
    ["launch-video.mp4", 471_040],
    ["site-photos.zip", 88_064],
  ] as const) {
    fs.writeFileSync(path.join(designDir, file), Buffer.alloc(kb * 1024));
  }

  const mock = await startMockServer({ authenticated: true });
  const { app, cleanup } = await launchApp(mock.url, { DOSYA_E2E_PLATFORM: "linux" });
  try {
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
    await page.waitForTimeout(700);

    await app.evaluate(async ({ BrowserWindow }) => {
      const main = BrowserWindow.getAllWindows()[0];
      main.setSize(1440, 900);
      main.center();
      main.focus();
    });
    await page.waitForTimeout(500);

    // Register the sync pair through the same IPC the UI uses.
    await page.evaluate(async (localPath) => {
      await (window as any).electronAPI.addSyncPair({
        workspaceId: "ws_test_1",
        workspaceName: "Acme Studio",
        localPath,
        remoteFolderName: "Design Assets",
        region: "SYD",
      });
    }, designDir);
    // Let the engine scan and settle before anything is captured.
    await page.waitForTimeout(4_000);

    for (const mode of ["light", "dark"] as const) {
      // Playwright emulates prefers-color-scheme (default light) on the page,
      // overriding nativeTheme - so the flip must go through emulateMedia.
      // The app's ui mode is "system", so the UI follows the media query.
      await page.emulateMedia({ colorScheme: mode });
      // Reload preserves the current hash, so park on the dashboard first and
      // wait for the shell to come back rather than for a redirect that will
      // not happen.
      await page.evaluate(() => { window.location.hash = "#/dashboard"; });
      await page.reload();
      await page.waitForSelector("[data-testid=nav-dashboard]", { timeout: 15_000 });
      await page.waitForTimeout(1_200);

      for (const [name, route, readySelector] of VIEWS) {
        await page.evaluate((r) => { window.location.hash = "#" + r; }, route);
        await page.waitForTimeout(900);
        try {
          await page.waitForSelector(readySelector, { timeout: 5_000 });
        } catch {
          // capture anyway - the PNG itself is the evidence of what rendered
        }
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(OUT, `desktop-${name}-${mode}.png`) });
      }
    }
  } finally {
    try { await app.close(); } finally {
      try { await mock.close(); } finally {
        cleanup();
        fs.rmSync(syncDir, { recursive: true, force: true });
      }
    }
  }
});
