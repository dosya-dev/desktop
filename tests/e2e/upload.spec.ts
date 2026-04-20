import { test, expect, navigateTo } from "../fixtures";

test.describe("Upload Page", () => {
  test("renders upload dropzone", async ({ appPage }) => {
    await navigateTo(appPage, "/upload");

    await expect(
      appPage.getByText(/drop files here/i),
    ).toBeVisible();
  });

  test("shows browse text", async ({ appPage }) => {
    await navigateTo(appPage, "/upload");

    await expect(
      appPage.getByText(/browse your computer/i),
    ).toBeVisible();
  });

  test("shows folder selector with root default", async ({ appPage }) => {
    await navigateTo(appPage, "/upload");

    await expect(
      appPage.getByText(/root|top level/i).first(),
    ).toBeVisible();
  });
});
