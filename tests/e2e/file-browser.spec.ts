import { test, expect, navigateTo } from "../fixtures";

test.describe("File Browser", () => {
  test("renders file list with files and folders", async ({ appPage }) => {
    await navigateTo(appPage, "/files");

    await expect(appPage.getByText("Project Report.pdf")).toBeVisible();
    await expect(appPage.getByText("Photo.png")).toBeVisible();
    // "Documents" matches both filter chip and folder name — use the table row
    await expect(appPage.getByRole("table").getByText("Documents")).toBeVisible();
  });

  test("shows New folder button", async ({ appPage }) => {
    await navigateTo(appPage, "/files");

    await expect(
      appPage.getByRole("button", { name: /new folder/i }),
    ).toBeVisible();
  });

  test("New folder button opens create folder modal", async ({ appPage }) => {
    await navigateTo(appPage, "/files");

    await appPage.getByRole("button", { name: /new folder/i }).click();

    // Modal with "Create folder" title and input
    await expect(appPage.getByText("Create folder")).toBeVisible();
    await expect(appPage.getByPlaceholder(/folder name/i)).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /^create$/i }),
    ).toBeVisible();
  });

  test("shows search input", async ({ appPage }) => {
    await navigateTo(appPage, "/files");

    await expect(appPage.getByPlaceholder(/search files/i)).toBeVisible();
  });

  test("shows sort control", async ({ appPage }) => {
    await navigateTo(appPage, "/files");

    // Sort is a <select> element with "Newest" as the selected option
    await expect(appPage.locator("select").first()).toBeVisible();
    await expect(appPage.locator("select").first()).toHaveValue("newest");
  });

  test("can select files for bulk actions", async ({ appPage }) => {
    await navigateTo(appPage, "/files");

    const checkbox = appPage.locator('input[type="checkbox"]').first();
    if (await checkbox.isVisible()) {
      await checkbox.check();
      await expect(appPage.getByText(/selected/i)).toBeVisible();
    }
  });

  test("right-click shows context menu", async ({ appPage }) => {
    await navigateTo(appPage, "/files");

    await appPage.getByText("Project Report.pdf").click({ button: "right" });

    await expect(
      appPage.getByText(/rename|delete|share/i).first(),
    ).toBeVisible();
  });
});
