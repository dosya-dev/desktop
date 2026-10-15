import { test, expect, navigateTo, guestTest, electronAppFor } from "../fixtures";
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

  // A long path used to blow the row wide: the path box is `flex-1` and the
  // span inside it is a flex item too, so both defaulted to `min-width: auto`
  // and refused to shrink below the unbreakable string. The row grew instead
  // of ellipsizing and pushed Browse out through the side of the modal, which
  // has no overflow clipping of its own. Measured here rather than asserted as
  // a class because only real layout can tell the two apart.
  test("a long local path keeps the Browse button inside the modal", async ({
    appPage,
  }) => {
    await navigateTo(appPage, "/sync");

    const longPath =
      "/Users/firatkaya/Desktop/Projects/dosya.dev/apps/desktop/store-shots/mac-app-store";
    // The picker is a native dialog, so the stub goes in the main process:
    // electronAPI is a frozen contextBridge object and cannot be patched from
    // the page.
    await electronAppFor(appPage).evaluate(async ({ ipcMain }, path) => {
      ipcMain.removeHandler("sync:pick-local-folder");
      ipcMain.handle("sync:pick-local-folder", async () => ({ path }));
    }, longPath);

    await appPage
      .getByRole("button", { name: /add sync folder/i })
      .first()
      .click();

    const heading = appPage.getByRole("heading", { name: "Add sync folder" });
    await expect(heading).toBeVisible();
    // h3 -> header row -> the modal card itself.
    const card = heading.locator("xpath=../..");

    const browse = appPage.getByRole("button", { name: "Browse" });
    await browse.click();
    await expect(appPage.getByText(longPath)).toBeVisible();

    const cardBox = await card.boundingBox();
    const browseBox = await browse.boundingBox();
    if (!cardBox || !browseBox) throw new Error("modal or Browse button not laid out");

    expect(browseBox.x + browseBox.width).toBeLessThanOrEqual(cardBox.x + cardBox.width);
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
        // Gate failed and the pair was persisted - clean it up so repeated
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
