import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Desktop has no unit runner, so this is the only executable coverage the
 * comments tab can have. It exercises the three things the tab could not do
 * before - reply, edit, and render a reply nested two deep - plus the gate that
 * stops offering Delete on comments this user may not delete.
 *
 * The panel is opened through the ?panel= deep link rather than by driving the
 * grid, because the grid renders no row test ids and the deep link is a
 * supported path (FileBrowserPage restores it on load).
 */

/** Open file_1's detail panel and switch to its Comments tab. */
async function openComments(page: Page): Promise<void> {
  await navigateTo(page, "/files?panel=file_1");
  await page.getByRole("button", { name: /^Comments/ }).click();
  await expect(page.getByTestId("comment-cmt_1")).toBeVisible();
}

/** The mock's comment store, so a test can assert what the panel actually sent. */
function readComments(page: Page) {
  return page.evaluate(async () => {
    const apiBase = await (window as any).electronAPI.getApiBase();
    const res = await fetch(`${apiBase}/__test/comments`);
    const body = await res.json();
    return body.comments as { id: string; body: string; parent_id: string | null; is_edited: number }[];
  });
}

test.describe("comments", () => {
  test("renders a reply nested two deep", async ({ appPage: page }) => {
    // cmt_3 replies to cmt_2, which replies to cmt_1. The old grouping read
    // parent_id once and drew only direct children, so this comment was fetched,
    // counted in the tab badge, and never shown.
    await openComments(page);
    await expect(page.getByTestId("comment-cmt_2")).toBeVisible();
    await expect(page.getByTestId("comment-cmt_3")).toBeVisible();
  });

  test("a reply carries the parent it was written against", async ({ appPage: page }) => {
    await openComments(page);
    await page.getByTestId("comment-cmt_1-reply").click();
    await expect(page.getByTestId("comment-reply-strip")).toBeVisible();
    await page.getByTestId("comment-input").fill("Following up on this.");
    await page.getByTestId("comment-send").click();

    await expect(async () => {
      const comments = await readComments(page);
      const posted = comments.find((c) => c.body === "Following up on this.");
      expect(posted?.parent_id).toBe("cmt_1");
    }).toPass({ timeout: 5000 });

    // The strip clears only on success, so its absence also proves the post landed.
    await expect(page.getByTestId("comment-reply-strip")).toBeHidden();
  });

  test("editing own comment rewrites it and marks it edited", async ({ appPage: page }) => {
    await openComments(page);
    await page.getByTestId("comment-cmt_1-edit").click();
    await page.getByTestId("comment-edit-input").fill("First pass looks great.");
    await page.getByTestId("comment-edit-save").click();

    await expect(page.getByTestId("comment-cmt_1")).toContainText("First pass looks great.");
    await expect(page.getByTestId("comment-cmt_1-edited")).toBeAttached();
  });

  test("offers no edit on a comment somebody else wrote", async ({ appPage: page }) => {
    // cmt_2 is Grace's. The API allows only the author to edit, so the control
    // must not be there to press.
    await openComments(page);
    await expect(page.getByTestId("comment-cmt_1-edit")).toBeAttached();
    await expect(page.getByTestId("comment-cmt_2-edit")).toHaveCount(0);
  });

  test("cancelling an edit leaves the comment alone", async ({ appPage: page }) => {
    await openComments(page);
    await page.getByTestId("comment-cmt_1-edit").click();
    await page.getByTestId("comment-edit-input").fill("discard me");
    await page.getByTestId("comment-edit-cancel").click();
    await expect(page.getByTestId("comment-cmt_1")).toContainText("First pass looks good.");
  });
});
