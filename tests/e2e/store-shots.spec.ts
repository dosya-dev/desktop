import { test } from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { startMockServer } from "../helpers/mock-api";
import * as data from "../helpers/mock-data";
import { launchApp } from "../fixtures";

/**
 * Mac App Store screenshot capture - NOT a test.
 *
 * Drives the real built app (out/main/index.js) against the e2e mock API,
 * signed in as the fixture user with the fixture files, and captures the
 * window contents at 1440x900 CSS px (2880x1800 on a Retina display) in both
 * colour schemes. scripts/compose-store-shots.mjs then sets each capture in a
 * monochrome marketing frame at Apple's 2880x1800 size.
 *
 * Unlike marketing-shots.spec.ts this does NOT force the Linux title bar: the
 * compose step draws macOS window chrome around the capture, so the capture
 * must be the bare content area the app shows under hiddenInset chrome.
 *
 * Run:
 *   STORE_SHOTS=1 npx playwright test tests/e2e/store-shots.spec.ts
 * Output: STORE_SHOT_DIR (default apps/desktop/store-shots/raw), one PNG per
 * view and theme.
 */
test.skip(!process.env.STORE_SHOTS, "store capture only - set STORE_SHOTS=1");

const OUT = process.env.STORE_SHOT_DIR || path.join(__dirname, "../../store-shots/raw");

// Each view: the route, optional in-page clicks (in order), and a selector
// that proves the view rendered.
const VIEWS: Array<{ name: string; route: string; clicks?: string[]; ready: string }> = [
  { name: "dashboard", route: "/dashboard", ready: "text=Storage breakdown" },
  { name: "files", route: "/files", ready: "[data-testid=nav-files]" },
  { name: "sync", route: "/sync", ready: "[data-testid=nav-sync]" },
  { name: "lan", route: "/lan-transfer", ready: "text=/room code/i" },
  { name: "appearance", route: "/profile", clicks: ["button:has-text(\"Appearance\")"], ready: "text=/theme/i" },
  // The add-folder modal: step 1 with the Documents preset chosen, then step 2 (sync modes).
  { name: "add-folder", route: "/sync", clicks: ["button:has-text(\"Add sync folder\")", "button:has-text(\"Documents\")"], ready: "text=Add sync folder" },
  { name: "sync-modes", route: "/sync", clicks: ["button:has-text(\"Add sync folder\")", "button:has-text(\"Documents\")", "button:has-text(\"Continue\")"], ready: "text=/full sync/i" },
];

/** A believable identity for the listing instead of the fixture's "Test User". */
const SHOWN_USER = { name: "Mia Okafor", email: "mia@acmestudio.co" };
const SHOWN_WORKSPACE = { ...data.mockWorkspace, name: "Acme Studio", slug: "acme-studio", icon_initials: "AS" };

test.setTimeout(300_000);

test("capture Mac App Store screenshots", async () => {
  fs.mkdirSync(OUT, { recursive: true });

  // A real local folder with real files so the Sync page shows a live pair
  // rather than its empty state. /Users/Shared keeps the on-screen path
  // believable; fall back to a temp dir if it is already taken.
  let designDir = "/Users/Shared/Design Assets";
  let syncDir = designDir;
  try {
    fs.mkdirSync(designDir);
  } catch {
    syncDir = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-store-shots-"));
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

  const mock = await startMockServer({ authenticated: true, user: SHOWN_USER, workspaces: [SHOWN_WORKSPACE] });
  const { app, cleanup } = await launchApp(mock.url);
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

    await page.evaluate(async (localPath) => {
      await (window as any).electronAPI.addSyncPair({
        workspaceId: "ws_test_1",
        workspaceName: "Acme Studio",
        localPath,
        remoteFolderName: "Design Assets",
        region: "SYD",
      });
    }, designDir);
    await page.waitForTimeout(4_000);

    for (const mode of ["light", "dark"] as const) {
      await page.emulateMedia({ colorScheme: mode });
      await page.evaluate(() => { window.location.hash = "#/dashboard"; });
      await page.reload();
      await page.waitForSelector("[data-testid=nav-dashboard]", { timeout: 15_000 });
      await page.waitForTimeout(1_200);

      for (const { name, route, clicks = [], ready } of VIEWS) {
        // Reload between views so a modal left open by the previous view is gone.
        await page.evaluate((r) => { window.location.hash = "#" + r; }, route);
        await page.reload();
        await page.waitForSelector("[data-testid=nav-dashboard]", { timeout: 15_000 });
        await page.waitForTimeout(900);
        for (const click of clicks) {
          try { await page.locator(click).first().click({ timeout: 5_000 }); } catch { /* captured as-is */ }
          await page.waitForTimeout(600);
        }
        try {
          await page.waitForSelector(ready, { timeout: 5_000 });
        } catch {
          // capture anyway; the PNG shows what rendered
        }
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(OUT, `${name}-${mode}.png`) });
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
