import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * The sidebar went from one flat list of eleven items to three groups with an
 * expandable Files section, and the files browser's filter chips were deleted in
 * the same move. These specs pin the parts that would fail silently: a child row
 * that writes the wrong query string still navigates, and a shut tree with no
 * label leaves you unable to tell Images from the trash.
 *
 * Each test gets a fresh Electron userData dir (see fixtures.launchApp), so the
 * remembered open/shut state always starts at its default here.
 */

/** The tree ships shut. Open it the way a person would. */
async function openFilesTree(page: Page): Promise<void> {
  await page.getByTestId("nav-files-toggle").click();
  await expect(page.getByTestId("nav-files-all")).toBeVisible();
}

test.describe("sidebar", () => {
  test("ships with every destination on screen and the tree shut", async ({ appPage: page }) => {
    await navigateTo(page, "/dashboard");

    // The whole point of the section: nothing below the fold on first run.
    for (const id of ["dashboard", "upload", "shared", "sync", "integrations", "team", "settings"]) {
      await expect(page.getByTestId(`nav-${id}`)).toBeVisible();
    }
    await expect(page.getByTestId("nav-files")).toBeVisible();
    await expect(page.getByTestId("nav-files-all")).toBeHidden();
  });

  test("an open tree is remembered across navigation", async ({ appPage: page }) => {
    await navigateTo(page, "/dashboard");
    await openFilesTree(page);

    await navigateTo(page, "/settings");
    await expect(page.getByTestId("nav-files-all")).toBeVisible();
  });

  test("a shut tree still names the view you are in", async ({ appPage: page }) => {
    // "Files" alone cannot tell Images from the trash, so the row says which.
    await navigateTo(page, "/files?filter=images");
    await expect(page.getByTestId("nav-files")).toContainText("Images");

    await navigateTo(page, "/files?deleted=1");
    await expect(page.getByTestId("nav-files")).toContainText("Deleted");

    // Plain /files is "All", which needs no qualifier.
    await navigateTo(page, "/files");
    await expect(page.getByTestId("nav-files")).toHaveText("Files");
  });

  test("Files children write the query string the browser reads", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await openFilesTree(page);

    await page.getByTestId("nav-files-documents").click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("filter=documents");

    await page.getByTestId("nav-files-images").click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("filter=images");

    // Deleted and hidden are flags, not filter values - the browser reads
    // `deleted=1` / `hidden=1` and resets `filter` to all.
    await page.getByTestId("nav-files-deleted").click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("deleted=1");

    await page.getByTestId("nav-files-hidden").click();
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toContain("hidden=1");
    expect(hash).not.toContain("deleted=1");
  });

  test("picking a filter keeps the folder you are standing in", async ({ appPage: page }) => {
    await navigateTo(page, "/files?folder=folder_1");
    await openFilesTree(page);

    await page.getByTestId("nav-files-documents").click();
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toContain("folder=folder_1");
    expect(hash).toContain("filter=documents");
  });

  test("the trash opens at its own root, never inside a folder", async ({ appPage: page }) => {
    // A folder id inside the trash addresses a TRASHED folder, so carrying one
    // across would ask the deleted view for a live folder that isn't there.
    await navigateTo(page, "/files?folder=folder_1");
    await openFilesTree(page);

    await page.getByTestId("nav-files-deleted").click();
    const hash = await page.evaluate(() => window.location.hash);
    expect(hash).toContain("deleted=1");
    expect(hash).not.toContain("folder=folder_1");
  });

  test("Groups and File requests live under Files, not at the top level", async ({ appPage: page }) => {
    await navigateTo(page, "/dashboard");
    await openFilesTree(page);

    await page.getByTestId("nav-files-groups").click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("/groups");

    await page.getByTestId("nav-files-file-requests").click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("/file-requests");
  });

  test("the files browser no longer carries its own filter chips", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await openFilesTree(page);

    // The sidebar owns filter selection now. Scope to the main content so the
    // sidebar's own "Documents" row doesn't answer for the deleted chip.
    const main = page.locator("main");
    await expect(main.getByRole("button", { name: "Documents", exact: true })).toHaveCount(0);
    await expect(main.getByRole("button", { name: "Favourites", exact: true })).toHaveCount(0);

    // Prove the absence above is the chips being gone, not the locator being
    // broken: the same query finds them in the sidebar, where they now live.
    const aside = page.locator("aside");
    await expect(aside.getByRole("button", { name: "Documents", exact: true })).toHaveCount(1);
    await expect(aside.getByRole("button", { name: "Favourites", exact: true })).toHaveCount(1);
  });

  test("collapsed, the Files icon opens a flyout that still navigates", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    // A tree cannot render at 60px, so the section becomes a flyout instead.
    await page.getByTitle("Collapse sidebar").click();
    await expect(page.getByTestId("nav-files-flyout")).toBeHidden();

    await page.getByTestId("nav-files").click();
    await expect(page.getByTestId("nav-files-flyout")).toBeVisible();

    await page.getByTestId("nav-files-flyout").getByTestId("nav-files-videos").click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("filter=videos");
    // Navigating dismisses it.
    await expect(page.getByTestId("nav-files-flyout")).toBeHidden();
  });
});

test.describe("integrations", () => {
  test("lists the duplicate finder as a built-in tool and opens it", async ({ appPage: page }) => {
    await navigateTo(page, "/integrations");

    await expect(page.getByText("Duplicate finder")).toBeVisible();
    await page.getByTestId("tool-card-duplicates").click();
    await expect
      .poll(() => page.evaluate(() => window.location.hash))
      .toContain("/duplicates");
  });

  test("connection cards hand off to the web app rather than navigating in-app", async ({ appPage: page }) => {
    await navigateTo(page, "/integrations");

    // window.open is the desktop link-out idiom (main/index.ts routes it to
    // shell.openExternal). Record the call instead of opening a real browser.
    await page.evaluate(() => {
      (window as unknown as { __opened: string[] }).__opened = [];
      window.open = ((url: string) => {
        (window as unknown as { __opened: string[] }).__opened.push(url);
        return null;
      }) as typeof window.open;
    });

    await page.getByTestId("integration-card-webdav").click();

    const opened = await page.evaluate(
      () => (window as unknown as { __opened: string[] }).__opened,
    );
    expect(opened).toEqual(["https://app.dosya.dev/integrations/webdav"]);
    // And it did NOT navigate the app away from the page.
    expect(await page.evaluate(() => window.location.hash)).toContain("/integrations");
  });

  test("does not offer a download of the app you are already in", async ({ appPage: page }) => {
    await navigateTo(page, "/integrations");
    // Paired with a card that IS expected, so a page that failed to render
    // cannot pass this by showing nothing at all.
    await expect(page.getByText("WebDAV")).toBeVisible();
    await expect(page.getByText("Desktop apps")).toHaveCount(0);
  });

  test("the photo map is reached from Files, not listed here twice", async ({ appPage: page }) => {
    await navigateTo(page, "/integrations");
    await expect(page.getByText("Duplicate finder")).toBeVisible();
    await expect(page.getByText("Photo map")).toHaveCount(0);
  });
});
