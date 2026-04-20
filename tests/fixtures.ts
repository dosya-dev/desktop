import {
  test as base,
  _electron as electron,
  type Page,
} from "@playwright/test";
import path from "path";
import { startMockServer, type MockServer } from "./helpers/mock-api";

export { expect } from "@playwright/test";

function launchApp(apiBase: string) {
  return electron.launch({
    args: [path.join(__dirname, "../out/main/index.js")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      API_BASE: apiBase,
      NODE_ENV: "test",
    },
  });
}

/** Authenticated test — waits until the app auto-redirects to /dashboard */
export const test = base.extend<{ appPage: Page }>({
  appPage: async ({}, use) => {
    const mock = await startMockServer({ authenticated: true });
    const app = await launchApp(mock.url);
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
    await app.close();
    await mock.close();
  },
});

/** Guest test — /api/me returns 401, app stays on onboarding/login */
export const guestTest = base.extend<{ appPage: Page }>({
  appPage: async ({}, use) => {
    const mock = await startMockServer({ authenticated: false });
    const app = await launchApp(mock.url);
    const page = await app.firstWindow();
    await page.waitForLoadState("domcontentloaded");

    // Wait for auth check to complete (app lands on onboarding)
    await page.waitForFunction(
      () => window.location.hash.includes("/onboarding"),
      { timeout: 15_000 },
    );
    await page.waitForTimeout(300);

    await use(page);
    await app.close();
    await mock.close();
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
