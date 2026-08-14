import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * The duplicate finder existed only on web. These specs pin the two things that
 * are easy to get wrong: which copy "select all but newest" leaves behind, and
 * that deleting every copy of a file is called out before it happens.
 */
function readBatchDeletes(page: Page) {
  return page.evaluate(async () => {
    const apiBase = await (window as any).electronAPI.getApiBase();
    const res = await fetch(`${apiBase}/__test/batch-deletes`);
    const body = await res.json();
    return body.batches as string[][];
  });
}

async function openDuplicates(page: Page): Promise<void> {
  await navigateTo(page, "/duplicates");
  await expect(page.getByTestId("dup-group-hash_a")).toBeVisible();
}

test.describe("duplicates", () => {
  test("lists groups with what each one wastes", async ({ appPage: page }) => {
    await openDuplicates(page);
    await expect(page.getByTestId("dup-group-hash_a")).toContainText("3 copies");
    await expect(page.getByTestId("dup-summary")).toContainText("2 duplicate groups");
  });

  test("marks the newest copy in each group", async ({ appPage: page }) => {
    // The server sorts newest-first, and that ordering is what
    // "select all but newest" depends on - so the badge has to be on file 1.
    await openDuplicates(page);
    await expect(page.getByTestId("dup-newest-dupfile_1")).toBeVisible();
    await expect(page.getByTestId("dup-newest-dupfile_2")).toHaveCount(0);
  });

  test("select all but newest leaves exactly one copy per group", async ({ appPage: page }) => {
    await openDuplicates(page);
    await page.getByTestId("dup-select-all-but-newest").click();
    await expect(page.getByTestId("dup-check-dupfile_1")).not.toBeChecked();
    await expect(page.getByTestId("dup-check-dupfile_2")).toBeChecked();
    await expect(page.getByTestId("dup-check-dupfile_3")).toBeChecked();
    await expect(page.getByTestId("dup-check-dupfile_4")).not.toBeChecked();
    await expect(page.getByTestId("dup-check-dupfile_5")).toBeChecked();
  });

  test("deleting sends the selected ids", async ({ appPage: page }) => {
    await openDuplicates(page);
    await page.getByTestId("dup-check-dupfile_3").check();
    await page.getByTestId("dup-delete").click();
    await page.getByTestId("dup-confirm").click();

    await expect(async () => {
      const batches = await readBatchDeletes(page);
      expect(batches.flat()).toContain("dupfile_3");
    }).toPass({ timeout: 5000 });
  });

  test("warns when a selection would leave no copy at all", async ({ appPage: page }) => {
    // Allowed - web allows it too - but never silently.
    await openDuplicates(page);
    await page.getByTestId("dup-check-dupfile_4").check();
    await page.getByTestId("dup-check-dupfile_5").check();
    await page.getByTestId("dup-delete").click();
    await expect(page.getByTestId("dup-full-group-warning")).toBeVisible();
  });

  test("does not warn when one copy survives", async ({ appPage: page }) => {
    await openDuplicates(page);
    await page.getByTestId("dup-check-dupfile_5").check();
    await page.getByTestId("dup-delete").click();
    await expect(page.getByTestId("dup-full-group-warning")).toHaveCount(0);
  });

  test("cancelling the confirm deletes nothing", async ({ appPage: page }) => {
    await openDuplicates(page);
    await page.getByTestId("dup-check-dupfile_3").check();
    await page.getByTestId("dup-delete").click();
    await page.getByTestId("dup-confirm-cancel").click();
    await expect(page.getByTestId("dup-check-dupfile_3")).toBeChecked();
  });

  test("the delete button is dead until something is selected", async ({ appPage: page }) => {
    await openDuplicates(page);
    await expect(page.getByTestId("dup-delete")).toBeDisabled();
  });
});
