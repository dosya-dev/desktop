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

  test("selecting an old version converts THAT version, not the latest", async ({ appPage: page }) => {
    // file_v2 is a docx with three versions. Office previews render through
    // /preview-pdf conversion instead of /raw - the path that used to ignore
    // the version picked in the panel, so clicking v1 changed nothing.
    await navigateTo(page, "/files");
    await page.getByText("Versioned Notes.docx").first().dblclick();
    await expect(page.getByTestId("office-frame")).toBeVisible();

    await page.getByTestId("viewer-versions-toggle").click();
    const panel = page.getByTestId("viewer-versions-panel");
    await expect(panel).toBeVisible();
    await panel.getByText("v1", { exact: true }).click();

    // The preview is a blob URL, so the mock's request log is the only place
    // the chosen version is observable.
    await expect(async () => {
      const requests = await page.evaluate(async () => {
        const apiBase = await (window as any).electronAPI.getApiBase();
        const res = await fetch(`${apiBase}/__test/preview-pdf-requests`);
        return (await res.json()).requests as string[];
      });
      expect(requests).toContain("file_v2?version=1");
    }).toPass({ timeout: 5000 });

    // And the frame is still up, now showing the old version's rendition.
    await expect(page.getByTestId("office-frame")).toBeVisible();
  });
});
