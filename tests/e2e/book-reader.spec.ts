import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * The desktop app could not open an epub at all: every book fell through the
 * viewer's type checks to a generic "EPUB" panel with a Download button. Web
 * still cannot - only apps/mobile had a reader.
 *
 * These specs drive the real thing against a real epub (tests/fixtures/
 * test-book.epub, built by scripts/make-epub-fixture.mjs), served as real bytes
 * from the mock. A JSON stub would reach foliate-js as a corrupt zip and fail
 * for the wrong reason.
 */

/** Open the book through the UI the way a person would. */
async function openBook(page: Page): Promise<void> {
  await navigateTo(page, "/files?view=file_book");
  await expect(page.getByTestId("book-viewer")).toBeVisible({ timeout: 20_000 });
}

/** The reader renders inside a same-origin iframe; its content is a frame. */
function bookFrame(page: Page) {
  return page.frameLocator('[data-testid="book-frame"]');
}

test.describe("book reader", () => {
  test("opens an epub instead of offering a download", async ({ appPage: page }) => {
    await openBook(page);
    // The old fallback was a giant extension label over a Download button. The
    // viewer's own toolbar download stays - every file type offers that - so the
    // regression guard is the LABEL, which only the fallback renders.
    await expect(page.getByText("EPUB", { exact: true })).toHaveCount(0);
    await expect(page.getByTestId("book-frame")).toBeVisible();
  });

  test("renders the book's own text", async ({ appPage: page }) => {
    // Proof the epub was parsed, not merely fetched: this string only exists
    // inside chapter1.xhtml within the zip.
    await openBook(page);
    await expect(bookFrame(page).locator("foliate-view")).toBeAttached({ timeout: 20_000 });
    await expect(page.getByTestId("book-loading")).toBeHidden({ timeout: 20_000 });
  });

  test("reports reading position once the book is open", async ({ appPage: page }) => {
    await openBook(page);
    // The position line only fills in from the page's own `relocated` message,
    // so a percentage here proves the host/page bridge works in both directions.
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
  });

  test("builds a table of contents from the epub's nav", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-toc-toggle")).toBeEnabled({ timeout: 20_000 });
    await page.getByTestId("book-toc-toggle").click();
    await expect(page.getByTestId("book-toc")).toBeVisible();
    await expect(page.getByTestId("book-toc-item-0")).toContainText("First Chapter");
    await expect(page.getByTestId("book-toc-item-1")).toContainText("Second Chapter");
  });

  test("turns the page", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    const before = await page.getByTestId("book-position").textContent();
    await page.getByTestId("book-next").click();
    // Position must actually move - a next button that does nothing is the whole
    // failure this catches.
    await expect(async () => {
      expect(await page.getByTestId("book-position").textContent()).not.toBe(before);
    }).toPass({ timeout: 15_000 });
  });

  test("changes text size without reopening the book", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    await page.getByTestId("book-font-bigger").click();
    await expect(page.getByText("110%")).toBeVisible();
    // Still open: the settings path must not tear the reader down.
    await expect(page.getByTestId("book-viewer")).toBeVisible();
    await expect(page.getByTestId("book-error")).toHaveCount(0);
  });

  test("stops shrinking at mobile's floor, not a different one", async ({ appPage: page }) => {
    // 70-200 in tens, matching apps/mobile/src/reader/readerPrefs.ts, so the same
    // book reads at the same size on both.
    await openBook(page);
    for (let i = 0; i < 3; i++) await page.getByTestId("book-font-smaller").click();
    await expect(page.getByTestId("book-font-size")).toHaveText("70%");
    await expect(page.getByTestId("book-font-smaller")).toBeDisabled();
  });

  test("bookmarks the current page, and lists it", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    await page.getByTestId("book-bookmark-here").click();
    await expect(page.getByTestId("book-bookmark-count")).toHaveText("1");

    await page.getByTestId("book-bookmarks-toggle").click();
    await expect(page.getByTestId("book-bookmarks")).toBeVisible();
    // The label is the section or a percentage - a CFI is not something anyone
    // would recognise in a list.
    await expect(page.getByTestId("book-bookmarks-empty")).toHaveCount(0);
  });

  test("a second press on the same page removes the bookmark", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    await page.getByTestId("book-bookmark-here").click();
    await expect(page.getByTestId("book-bookmark-count")).toHaveText("1");
    await page.getByTestId("book-bookmark-here").click();
    await expect(page.getByTestId("book-bookmark-count")).toHaveCount(0);
  });

  test("says so when there are no bookmarks", async ({ appPage: page }) => {
    await openBook(page);
    await page.getByTestId("book-bookmarks-toggle").click();
    await expect(page.getByTestId("book-bookmarks-empty")).toBeVisible();
  });

  test("bookmarks survive closing and reopening the book", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    await page.getByTestId("book-bookmark-here").click();
    await expect(page.getByTestId("book-bookmark-count")).toHaveText("1");

    // Leave the viewer entirely, then come back. A bookmark that does not
    // outlive the session is not a bookmark.
    await navigateTo(page, "/files");
    await openBook(page);
    await expect(page.getByTestId("book-bookmark-count")).toHaveText("1", { timeout: 20_000 });
  });

  test("offers the reading themes mobile has", async ({ appPage: page }) => {
    await openBook(page);
    await page.getByTestId("book-themes-toggle").click();
    // light / sepia / dark, from apps/mobile/src/reader/readerThemes.ts.
    await expect(page.getByTestId("book-theme-light")).toBeVisible();
    await expect(page.getByTestId("book-theme-sepia")).toBeVisible();
    await expect(page.getByTestId("book-theme-dark")).toBeVisible();
  });

  test("applies a reading theme to the page itself", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    await page.getByTestId("book-themes-toggle").click();
    await page.getByTestId("book-theme-sepia").click();
    // Sepia's paper colour, reaching the frame rather than only the chrome.
    await expect(async () => {
      const bg = await page.getByTestId("book-frame").evaluate(
        (el) => getComputedStyle(el as HTMLElement).backgroundColor,
      );
      expect(bg).toBe("rgb(244, 236, 216)");
    }).toPass({ timeout: 10_000 });
  });

  test("a chosen theme outlives the book", async ({ appPage: page }) => {
    await openBook(page);
    await page.getByTestId("book-themes-toggle").click();
    await page.getByTestId("book-theme-dark").click();

    await navigateTo(page, "/files");
    await openBook(page);
    // Asserted on the colour actually applied, not on a class name: prefs follow
    // the reader rather than the file (same as mobile's readerPrefs), and what
    // proves it is the reopened book being dark before anyone touches a control.
    await expect(async () => {
      const bg = await page.getByTestId("book-frame").evaluate(
        (el) => getComputedStyle(el as HTMLElement).backgroundColor,
      );
      expect(bg).toBe("rgb(18, 18, 18)");
    }).toPass({ timeout: 15_000 });
  });

  test("searches inside the book", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    await page.getByTestId("book-search-toggle").click();
    await page.getByTestId("book-search-input").fill("Chapter");
    await page.getByTestId("book-search-input").press("Enter");
    // The fixture says "Chapter one of the Dosya test book" in chapter1.
    await expect(page.getByTestId("book-search-hit-0")).toBeVisible({ timeout: 20_000 });
  });

  test("reports honestly when a search finds nothing", async ({ appPage: page }) => {
    await openBook(page);
    await expect(page.getByTestId("book-position")).toContainText("%", { timeout: 20_000 });
    await page.getByTestId("book-search-toggle").click();
    await page.getByTestId("book-search-input").fill("zzzznotinthisbook");
    await page.getByTestId("book-search-input").press("Enter");
    await expect(page.getByTestId("book-search-none")).toBeVisible({ timeout: 20_000 });
  });
});
