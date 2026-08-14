import {
  test as base,
  _electron as electron,
  type Page,
} from "@playwright/test";
import path from "path";
import fs from "fs";
import os from "os";
import { startMockServer, type MockServer } from "./helpers/mock-api";
import * as data from "./helpers/mock-data";

export { expect } from "@playwright/test";

/**
 * Launch a fresh app instance with its own Electron `userData` dir.
 *
 * Without an isolated profile, Electron reuses its default userData directory
 * across separate `electron.launch()` calls, so `localStorage` (e.g. the
 * `dosya_active_workspace` key) from one Playwright run silently leaks into
 * the next. That only ever mattered once a fixture introduced more than one
 * workspace - a stale id could then resolve to a *different* real workspace
 * instead of falling back to `workspaces[0]`.
 */
async function launchApp(apiBase: string) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-e2e-"));
  const app = await electron.launch({
    args: [
      path.join(__dirname, "../out/main/index.js"),
      `--user-data-dir=${userDataDir}`,
    ],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      API_BASE: apiBase,
      // The mock also stands in for the ONLYOFFICE document server, so the
      // renderer's CSP names the same origin the editor actually loads from.
      // Without this the CSP would allow docs.dosya.dev while the test served
      // api.js from 127.0.0.1, and the spec would pass for the wrong reason.
      ONLYOFFICE_SERVER_URL: apiBase,
      NODE_ENV: "test",
    },
  });
  return {
    app,
    cleanup: () => fs.rmSync(userDataDir, { recursive: true, force: true }),
  };
}

/** Authenticated test - waits until the app auto-redirects to /dashboard */
export const test = base.extend<{ appPage: Page }>({
  appPage: async ({}, use) => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Wait for auth to resolve and app to land on the dashboard
    await page.waitForFunction(
      () => window.location.hash.includes("/dashboard"),
      { timeout: 15_000 },
    );
    // Give React a moment to finish rendering
    await page.waitForTimeout(500);

    await use(page);
    // try/finally: a failed app.close() must not skip mock.close() or the
    // temp userData dir cleanup - otherwise the mock server and/or the temp
    // profile directory leak on every test that hits this path.
    try {
      await app.close();
    } finally {
      try {
        await mock.close();
      } finally {
        cleanup();
      }
    }
  },
});

/** Authenticated test with two workspaces and slow uploads - for switch-cancel specs. */
export const multiWsTest = base.extend<{ appPage: Page }>({
  appPage: async ({}, use) => {
    const mock = await startMockServer({
      authenticated: true,
      workspaces: [data.mockWorkspace, data.mockWorkspaceB],
      uploadDelayMs: 8_000,
    });
    const { app, cleanup } = await launchApp(mock.url);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");
    await page.waitForFunction(
      () => window.location.hash.includes("/dashboard"),
      { timeout: 15_000 },
    );
    await page.waitForTimeout(500);
    await use(page);
    try {
      await app.close();
    } finally {
      try {
        await mock.close();
      } finally {
        cleanup();
      }
    }
  },
});

/** Guest test - /api/me returns 401, app stays on onboarding/login */
export const guestTest = base.extend<{ appPage: Page }>({
  appPage: async ({}, use) => {
    const mock = await startMockServer({ authenticated: false });
    const { app, cleanup } = await launchApp(mock.url);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Wait for auth check to complete (app lands on onboarding)
    await page.waitForFunction(
      () => window.location.hash.includes("/onboarding"),
      { timeout: 15_000 },
    );
    await page.waitForTimeout(300);

    await use(page);
    try {
      await app.close();
    } finally {
      try {
        await mock.close();
      } finally {
        cleanup();
      }
    }
  },
});

/** Navigate within the hash router and wait for React to render */
export async function navigateTo(page: Page, route: string): Promise<void> {
  await page.evaluate((r) => {
    window.location.hash = "#" + r;
  }, route);
  // Wait for React to render the new route
  await page.waitForTimeout(500);
}
