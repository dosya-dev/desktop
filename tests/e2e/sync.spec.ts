import { test, expect, navigateTo, guestTest } from "../fixtures";
import { tmpdir } from "os";
import { join } from "path";

test.describe("Sync Page", () => {
  test("renders sync page with add button", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await expect(appPage.getByText("Sync").first()).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /add sync folder/i }).first(),
    ).toBeVisible();
  });

  test("shows empty state when no sync pairs", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await expect(appPage.getByText(/no sync folders/i)).toBeVisible();
  });

  test("shows tabs for Overview, Issues, and Settings", async ({
    appPage,
  }) => {
    await navigateTo(appPage, "/sync");

    await expect(appPage.getByText("Overview").first()).toBeVisible();
    await expect(appPage.getByText("Issues").first()).toBeVisible();
    await expect(appPage.getByText("Settings").first()).toBeVisible();
  });

  test("Issues tab is clickable", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await appPage.getByText("Issues").first().click();
    await appPage.waitForTimeout(500);

    await expect(
      appPage.getByText(/conflict|issue|no issue|no conflict/i).first(),
    ).toBeVisible();
  });

  test("Settings tab is clickable", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");

    await appPage.getByText("Settings").first().click();
    await appPage.waitForTimeout(500);

    // Settings tab should display some content
    await expect(
      appPage.getByText(/sync|pause|interval|transfer/i).first(),
    ).toBeVisible();
  });
});

guestTest.describe("Sync login gate", () => {
  guestTest("rejects adding a sync pair while logged out", async ({ appPage }) => {
    // Remove any stale session cookie (the Electron profile is shared with
    // dev runs) so the main process sees a genuinely logged-out state.
    await appPage.evaluate(() => (window as any).electronAPI.clearSession());

    const localPath = join(tmpdir(), "dosya-e2e-login-gate");
    const result = await appPage.evaluate(async (path: string) => {
      const api = (window as any).electronAPI;
      try {
        const pair = await api.addSyncPair({
          workspaceId: "ws_test",
          workspaceName: "Test Workspace",
          localPath: path,
          remoteFolderName: "login-gate",
          region: "eu-central",
        });
        // Gate failed and the pair was persisted — clean it up so repeated
        // runs don't pollute the config.
        if (pair?.id) await api.removeSyncPair(pair.id);
        return { rejected: false, message: "" };
      } catch (e: any) {
        return { rejected: true, message: String(e?.message ?? e) };
      }
    }, localPath);

    expect(result.rejected).toBe(true);
    expect(result.message).toMatch(/logged in/i);
  });
});
