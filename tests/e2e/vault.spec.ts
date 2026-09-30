import { test, expect, navigateTo, launchApp } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";

/**
 * The Vault's locked surface against the mock API. What is asserted is which
 * card the gate picks for each server answer, because picking wrong has
 * consequences: Setup on a transient error would let setup() overwrite a
 * returning user's real keys. The crypto itself (unlock, upload, members) is
 * exercised by packages/e2ee-*'s harness on a real workerd, not here.
 */
test.describe("vault (default mock: no identity)", () => {
  test("is reachable from the sidebar and offers Setup", async ({ appPage: page }) => {
    await page.getByTestId("nav-vault").click();
    await expect.poll(() => page.url()).toContain("/vault");
    await expect(page.getByTestId("vault-setup")).toBeVisible();
    await expect(page.getByTestId("vault-unlock")).toHaveCount(0);
  });

  test("Setup refuses until the passphrases match", async ({ appPage: page }) => {
    await navigateTo(page, "/vault");
    await page.locator("#vault-setup-pass").fill("correct horse battery");
    await page.locator("#vault-setup-confirm").fill("correct horse batery");
    await page.locator("#vault-setup-confirm").blur();
    await expect(page.getByText("Passphrases do not match.")).toBeVisible();
    await expect(page.getByTestId("vault-setup-submit")).toBeDisabled();
    await page.locator("#vault-setup-confirm").fill("correct horse battery");
    await expect(page.getByTestId("vault-setup-submit")).toBeEnabled();
  });
});

test.describe("vault (identity present)", () => {
  test("offers Unlock, the recovery-key path and the destroy escape hatch", async () => {
    const mock = await startMockServer({ authenticated: true, e2eeIdentity: "present" });
    const { app, cleanup } = await launchApp(mock.url);
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      await navigateTo(page, "/vault");
      await expect(page.getByTestId("vault-unlock")).toBeVisible();
      await expect(page.getByTestId("vault-setup")).toHaveCount(0);

      await page.getByTestId("vault-recovery-toggle").click();
      await expect(page.locator("#vault-recovery-key")).toBeVisible();
      await page.getByTestId("vault-recovery-toggle").click();
      await expect(page.locator("#vault-unlock-pass")).toBeVisible();

      await page.getByTestId("vault-destroy").click();
      await expect(page.getByTestId("vault-destroy-modal")).toBeVisible();
      await expect(page.getByTestId("vault-destroy-confirm")).toBeDisabled();
    } finally {
      await app.close().catch(() => {});
      await mock.close();
      cleanup();
    }
  });
});

test.describe("vault (identity check fails)", () => {
  test("shows Retry and never Setup", async () => {
    const mock = await startMockServer({ authenticated: true, e2eeIdentity: "error" });
    const { app, cleanup } = await launchApp(mock.url);
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      await navigateTo(page, "/vault");
      await expect(page.getByTestId("vault-retry")).toBeVisible();
      await expect(page.getByTestId("vault-setup")).toHaveCount(0);
      await expect(page.getByTestId("vault-unlock")).toHaveCount(0);
    } finally {
      await app.close().catch(() => {});
      await mock.close();
      cleanup();
    }
  });
});
