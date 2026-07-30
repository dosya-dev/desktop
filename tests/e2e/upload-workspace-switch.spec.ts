import { multiWsTest as test, expect, navigateTo } from "../fixtures";

test.describe("Upload queue vs workspace switch", () => {
  test("switching workspace cancels and clears the upload queue", async ({ appPage }) => {
    await navigateTo(appPage, "/upload");

    // Enqueue one file through the dropzone's hidden input; the mock PUT
    // stalls 8s so it is guaranteed to still be uploading when we switch.
    await appPage.locator('input[type="file"]').setInputFiles({
      name: "big.bin",
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(1024 * 1024),
    });
    await expect(appPage.getByText("Uploading")).toBeVisible({ timeout: 10_000 });

    // Open the workspace switcher (button shows the active workspace name)
    await appPage.getByRole("button", { name: /Test Workspace/ }).click();
    await appPage.getByText("Second Workspace").click();

    // Queue must be gone once the switch lands (splash lasts ~2s).
    await expect(appPage.getByText("Uploading")).toBeHidden({ timeout: 10_000 });
    await expect(appPage.getByText(/Uploads canceled/i)).toBeVisible({ timeout: 10_000 });
  });

  test("switching workspace with more items than MAX_CONCURRENT starts no further uploads for the old workspace", async ({ appPage }) => {
    await navigateTo(appPage, "/upload");

    // MAX_CONCURRENT is 3 - enqueue 5 so 3 start "uploading" (stalled 8s by
    // the mock PUT) and 2 sit "pending" behind them. This is the queue depth
    // where a scheduler re-entry (each aborted upload's `.finally()` calling
    // `processQueue()` again) can resurrect a sibling pending item into the
    // old workspace if the switch-cancel effect doesn't clear `queueRef`
    // synchronously.
    const files = Array.from({ length: 5 }, (_, i) => ({
      name: `race-${i}.bin`,
      mimeType: "application/octet-stream",
      buffer: Buffer.alloc(1024),
    }));
    await appPage.locator('input[type="file"]').setInputFiles(files);
    await expect(appPage.getByText("Uploading")).toBeVisible({ timeout: 10_000 });

    const readInitCount = () =>
      appPage.evaluate(async () => {
        const base = await (window as any).electronAPI.getApiBase();
        const res = await fetch(`${base}/__test/upload-init-count`);
        const body = await res.json();
        return body.count as number;
      });

    // Exactly the 3 concurrent slots should have called /api/upload/init.
    await expect.poll(readInitCount, { timeout: 5_000 }).toBe(3);

    await appPage.getByRole("button", { name: /Test Workspace/ }).click();
    await appPage.getByText("Second Workspace").click();

    await expect(appPage.getByText(/Uploads canceled/i)).toBeVisible({ timeout: 10_000 });
    await expect(appPage.getByText("race-0.bin")).toBeHidden({ timeout: 10_000 });

    // No further /api/upload/init calls should ever happen for the old
    // workspace's 2 leftover "pending" items - the count must stay at
    // exactly the 3 that were already in flight *before* the switch. (A
    // baseline taken only *after* the switch/toast is too late: the
    // resurrection races the toast itself, so it can already have happened
    // by the time we'd read a "right after" baseline - asserting against
    // the known pre-switch value of 3 is what actually catches the bug.)
    await appPage.waitForTimeout(3_000);
    expect(await readInitCount()).toBe(3);
    await expect(appPage.getByText("Upload queue")).toBeHidden();
  });
});
