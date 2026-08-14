import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Groups were reachable on web and mobile but not here, so the desktop app was
 * the one client that could not manage a per-user shortcut list.
 *
 * Asserted against the mock's store where the claim is about what was SENT
 * (a create's colour, a rename), and against the DOM where it is about what the
 * user sees.
 */
function readGroups(page: Page) {
  return page.evaluate(async () => {
    const apiBase = await (window as any).electronAPI.getApiBase();
    const res = await fetch(`${apiBase}/__test/groups`);
    const body = await res.json();
    return body.groups as {
      id: string; name: string; color: string;
      files: { file_id: string }[]; folders: { folder_id: string }[];
    }[];
  });
}

async function openGroups(page: Page): Promise<void> {
  await navigateTo(page, "/groups");
  await expect(page.getByTestId("group-grp_1")).toBeVisible();
}

test.describe("groups", () => {
  test("lists groups with their items", async ({ appPage: page }) => {
    await openGroups(page);
    await expect(page.getByTestId("group-grp_1")).toContainText("Client work");
    await expect(page.getByTestId("group-file-file_1")).toBeVisible();
    await expect(page.getByTestId("group-folder-folder_1")).toBeVisible();
  });

  test("says an empty group is empty rather than showing nothing", async ({ appPage: page }) => {
    await openGroups(page);
    await expect(page.getByTestId("group-grp_2-empty")).toBeVisible();
  });

  test("creates a group with the chosen colour", async ({ appPage: page }) => {
    await openGroups(page);
    await page.getByTestId("group-new").click();
    await page.getByTestId("group-create-name").fill("Invoices");
    await page.getByTestId("group-create-color-1D4ED8").click();
    await page.getByTestId("group-create-submit").click();

    await expect(async () => {
      const groups = await readGroups(page);
      const made = groups.find((g) => g.name === "Invoices");
      expect(made).toBeTruthy();
      expect(made?.color).toBe("#1D4ED8");
    }).toPass({ timeout: 5000 });
  });

  test("refuses a name past the server's 100-character cap", async ({ appPage: page }) => {
    // Checked here because the server's 400 would arrive with the dialog closed.
    await openGroups(page);
    await page.getByTestId("group-new").click();
    await page.getByTestId("group-create-name").fill("x".repeat(101));
    await expect(page.getByTestId("group-create-error")).toBeVisible();
    await expect(page.getByTestId("group-create-submit")).toBeDisabled();
  });

  test("renames a group", async ({ appPage: page }) => {
    await openGroups(page);
    await page.getByTestId("group-grp_1-rename").click();
    await page.getByTestId("group-rename-input").fill("Renamed group");
    await page.getByTestId("group-rename-save").click();

    await expect(async () => {
      const groups = await readGroups(page);
      expect(groups.find((g) => g.id === "grp_1")?.name).toBe("Renamed group");
    }).toPass({ timeout: 5000 });
  });

  test("removes one file without touching the rest of the group", async ({ appPage: page }) => {
    await openGroups(page);
    await page.getByTestId("group-file-file_1-remove").click();

    await expect(async () => {
      const groups = await readGroups(page);
      const g = groups.find((x) => x.id === "grp_1");
      expect(g?.files).toHaveLength(0);
      // The folder is still there - removing an item is not emptying the group.
      expect(g?.folders).toHaveLength(1);
    }).toPass({ timeout: 5000 });
  });

  test("deleting a group asks first and says the files are kept", async ({ appPage: page }) => {
    await openGroups(page);
    await page.getByTestId("group-grp_2-delete").click();
    await expect(page.getByText(/files and folders in it stay/i)).toBeVisible();
    await page.getByTestId("group-delete-confirm").click();

    await expect(async () => {
      const groups = await readGroups(page);
      expect(groups.find((g) => g.id === "grp_2")).toBeUndefined();
    }).toPass({ timeout: 5000 });
  });

  test("cancelling a delete keeps the group", async ({ appPage: page }) => {
    await openGroups(page);
    await page.getByTestId("group-grp_1-delete").click();
    await page.getByTestId("group-delete-cancel").click();
    await expect(page.getByTestId("group-grp_1")).toBeVisible();
  });
});
