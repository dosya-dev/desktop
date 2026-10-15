import { test, expect, navigateTo } from "../fixtures";

/**
 * OBS-3: FileBrowserPage's deep-link restore effect gated on a one-shot ref
 * ("have we ever restored") with no `searchParams` in its dependency array,
 * so changing only the query string on an already-mounted /files page did
 * nothing - the viewer only opened for a `?view=` present at first mount.
 * This is the opposite of viewer-chrome.spec.ts's `openViewer`, which always
 * navigates to `/files?view=...` fresh and so never exercised the bug.
 */

test.describe("view= deep link on an already-mounted page", () => {
  test("changing the query string to ?view=<id> opens the viewer without a remount", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    // Settle on the plain listing first - the viewer must not be open yet,
    // and this is the state the bug needed: the page already mounted.
    await expect(page.getByRole("table").getByText("Photo.png")).toBeVisible();

    const overlay = page.locator("div.fixed.inset-0.z-\\[300\\]");
    await expect(overlay).toHaveCount(0);

    // Change only the query string - same route, same mounted component.
    await navigateTo(page, "/files?view=file_2");

    await expect(overlay).toBeVisible();
    await expect(overlay.getByText("Photo.png")).toBeVisible();
  });

  test("a second ?view= change on the same mounted page opens the new file", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await expect(page.getByRole("table").getByText("Photo.png")).toBeVisible();

    await navigateTo(page, "/files?view=file_2");
    const overlay = page.locator("div.fixed.inset-0.z-\\[300\\]");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByText("Photo.png")).toBeVisible();

    // A different id while the viewer is already open for file_2 - this is
    // the case the loop guard has to get right too: not "have we ever
    // restored" but "is this a new id". (file_1 is "Project Report.pdf".)
    await navigateTo(page, "/files?view=file_1");
    await expect(overlay).toBeVisible();
    await expect(overlay.getByText("Project Report.pdf")).toBeVisible();
    await expect(overlay.getByText("Photo.png")).not.toBeVisible();
  });
});

/**
 * Fix round 1 regression: making the restore effect re-run on every
 * `searchParams` change (the fix above) means the mirror effect's OWN write
 * (`?panel=<id>` or `?view=<id>`, echoing state that already exists) also
 * re-triggers it. Without recording that id somewhere the restore effect can
 * see, a PLAIN click - nothing to do with deep links - double-opens:
 * setPanel -> mirror writes the url -> searchParams changes -> restore
 * effect sees a "new" id (its own memory is still stale) -> calls
 * openFileWithLockCheck a second time.
 *
 * The fix records the id in the mirror effect itself (the one place every
 * way of opening the viewer/panel funnels through), not only in the restore
 * effect.
 *
 * Why this test opens the panel via the row's right-click "Comments" item
 * rather than by clicking the row and then switching tabs inside the open
 * panel: FileDetailPanel's tab buttons call its OWN local `setTab`, which
 * never reaches back up to FileBrowserPage's `panel.tab` - so a user
 * switching tabs by hand inside an already-open panel can never be affected
 * by this bug (the duplicate `setPanel` the bug produces for a plain row
 * click always carries the SAME tab, "info", so FileDetailPanel's
 * `key={`${file.id}:${panel.tab}`}` does not change and it never remounts).
 * The "Comments" context-menu item, in contrast, opens straight onto the
 * comments tab (`setPanel({ file, tab: "comments" })`, bypassing the lock
 * gate the same way it always has). The duplicate open the bug produces is
 * always `action: "detail"` -> `tab: "info"` (openFileWithLockCheck hardcodes
 * it), which IS a different tab - so on the buggy path the key changes,
 * FileDetailPanel remounts, and the comments tab visibly snaps back to info.
 * That makes this a deterministic, non-timing-dependent reproduction of the
 * exact "opens twice" defect, rather than a race that may or may not land
 * inside a test's wait window.
 */
test.describe("a plain open does not re-trigger the restore effect", () => {
  test("opening the detail panel on the Comments tab does not get stomped back to Info", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await expect(page.getByText("Photo.png")).toBeVisible();

    await page.getByText("Photo.png").click({ button: "right" });
    await page.getByRole("button", { name: "Comments" }).click();

    // Opened straight onto the comments tab.
    await expect(page.getByTestId("comment-input")).toBeVisible();

    // Give the url-mirror effect and a (buggy) re-triggered restore effect
    // every chance to run - this is strictly more generous than the
    // production timing, which is a couple of React commits.
    await page.waitForTimeout(1000);

    // Still on Comments: a duplicate `openFileWithLockCheck` call would have
    // forced `tab: "info"` and remounted the panel onto the Info view.
    await expect(page.getByTestId("comment-input")).toBeVisible();
  });
});
