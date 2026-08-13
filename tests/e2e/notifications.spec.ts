import { test, expect } from "../fixtures";

/**
 * Desktop has no unit-test runner, so this is the only executable coverage the
 * notification UI gets. The pure logic behind it (reducers, grouping, route
 * mapping) is unit-tested in packages/shared.
 */
test.describe("notification inbox", () => {
  test("the title bar shows a bell with the unread count", async ({ appPage: page }) => {
    const bell = page.getByTestId("open-notifications");
    await expect(bell).toBeVisible();
    // One unread row in the fixture.
    await expect(page.getByTestId("notification-badge")).toHaveText("1");
  });

  test("the bell opens a dropdown listing notifications", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await expect(page.getByTestId("notification-dropdown")).toBeVisible();
    await expect(page.getByTestId("notification-ntf_unread")).toBeVisible();
    await expect(page.getByTestId("notification-ntf_read")).toBeVisible();
  });

  test("only the unread row carries the unread dot", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await expect(page.getByTestId("unread-dot-ntf_unread")).toBeVisible();
    await expect(page.getByTestId("unread-dot-ntf_read")).toHaveCount(0);
  });

  test("Escape closes the dropdown", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await expect(page.getByTestId("notification-dropdown")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("notification-dropdown")).toHaveCount(0);
  });

  test("View all opens the full inbox page", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await page.getByTestId("view-all-notifications").click();
    await expect(page.getByRole("heading", { name: "Notifications" })).toBeVisible();
    await expect(page.getByTestId("notification-ntf_unread")).toBeVisible();
  });

  test("mark all read clears the control", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await page.getByTestId("view-all-notifications").click();
    await page.getByTestId("mark-all-read").click();
    await expect(page.getByTestId("mark-all-read")).toHaveCount(0);
  });

  test("dismissing a row removes it and it does not come back", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await page.getByTestId("view-all-notifications").click();
    await page.getByTestId("dismiss-ntf_read").click();
    await expect(page.getByTestId("notification-ntf_read")).toHaveCount(0);
    // The local edit is projected over the server pages rather than being a
    // snapshot, so it survives a re-render.
    await expect(page.getByTestId("notification-ntf_unread")).toBeVisible();
    await expect(page.getByTestId("notification-ntf_read")).toHaveCount(0);
  });

  test("a file notification opens the file via the deep-link param the browser already reads", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await page.getByTestId("view-all-notifications").click();
    await page.getByTestId("notification-ntf_unread").getByText("report.pdf was uploaded").click();
    // link_path is the WEB route /files/file_1; desktop maps it to ?view=<id>.
    await expect.poll(() => page.url()).toContain("view=file_1");
  });

  test("a web-only link_path does not navigate", async ({ appPage: page }) => {
    await page.getByTestId("open-notifications").click();
    await page.getByTestId("view-all-notifications").click();
    const before = page.url();
    await page.getByTestId("notification-ntf_read").getByText("A share link expires tomorrow").click();
    // /vault has no desktop equivalent, so the row is readable but goes nowhere.
    await expect.poll(() => page.url()).toBe(before);
  });
});
