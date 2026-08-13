import { test, expect, navigateTo } from "../fixtures";

/**
 * Desktop has no unit-test runner, so this is the only executable coverage the
 * office-preview flow can have. The three fixtures exercise the three outcomes
 * that read differently to a user: converted, still converting, and too large.
 *
 * Files are addressed by visible name because FileBrowserPage renders no row
 * test ids - audio-viewer.spec.ts and file-browser.spec.ts do the same.
 */
test.describe("office preview", () => {
  test("renders a converted docx in the viewer", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await page.getByText("report.docx").first().dblclick();
    await expect(page.getByTestId("office-frame")).toBeVisible();
  });

  test("shows a preparing state while the server is still converting", async ({ appPage: page }) => {
    // The mock answers 503 + Retry-After forever for this file, so the preparing
    // state is what the user sees - not an error.
    await navigateTo(page, "/files");
    await page.getByText("converting.docx").first().dblclick();
    await expect(page.getByTestId("office-preparing")).toBeVisible();
  });

  test("says a large file is too large rather than failing", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await page.getByText("huge.pptx").first().dblclick();
    await expect(page.getByTestId("office-too-large")).toBeVisible();
  });
});
