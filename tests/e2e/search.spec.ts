import { test, expect, navigateTo } from "../fixtures";

test.describe("Search Page", () => {
  test("renders search page with input", async ({ appPage }) => {
    await navigateTo(appPage, "/search");

    await expect(
      appPage.getByPlaceholder(/search files/i),
    ).toBeVisible();
  });

  test("can type search query", async ({ appPage }) => {
    await navigateTo(appPage, "/search");

    const searchInput = appPage.getByPlaceholder(/search files/i);
    await searchInput.fill("Report");

    await expect(searchInput).toHaveValue("Report");
  });

  test("shows search results after Enter", async ({ appPage }) => {
    await navigateTo(appPage, "/search");

    const searchInput = appPage.getByPlaceholder(/search files/i);
    await searchInput.fill("Report");
    await searchInput.press("Enter");

    await expect(appPage.getByText("Project Report.pdf").first()).toBeVisible();
  });
});
