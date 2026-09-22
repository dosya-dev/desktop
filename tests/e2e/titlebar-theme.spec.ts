import { test, expect } from "../fixtures";

/**
 * The titlebar theme control: a Palette button beside the LAN button that
 * opens the same mode + theme options as Profile > Appearance, so changing
 * the look does not require a trip through Profile.
 */

test.describe("Titlebar theme menu", () => {
  test("switches mode and theme from the titlebar", async ({ appPage: page }) => {
    const rootState = () =>
      page.evaluate(() => ({
        dark: document.documentElement.classList.contains("dark"),
        theme: document.documentElement.getAttribute("data-theme"),
      }));

    await page.getByRole("button", { name: "Theme" }).click();

    // Dark mode applies to <html> immediately.
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await expect.poll(async () => (await rootState()).dark).toBe(true);

    // A palette swatch applies its data-theme attribute.
    await page.getByRole("button", { name: "Ocean" }).click();
    await expect.poll(async () => (await rootState()).theme).toBe("ocean");

    // No failed-save rollback toast: the choice stuck.
    await expect(page.locator("[data-sonner-toast]")).toHaveCount(0);

    // Back to light, still from the same popover.
    await page.getByRole("button", { name: "Light", exact: true }).click();
    await expect.poll(async () => (await rootState()).dark).toBe(false);

    // Escape closes the popover.
    await page.keyboard.press("Escape");
    await expect(page.getByRole("button", { name: "Dark", exact: true })).toHaveCount(0);
  });

  test("the choice survives a reload", async ({ appPage: page }) => {
    await page.getByRole("button", { name: "Theme" }).click();
    await page.getByRole("button", { name: "Dark", exact: true }).click();
    await page.getByRole("button", { name: "Ocean" }).click();
    await expect
      .poll(() => page.evaluate(() => document.documentElement.getAttribute("data-theme")))
      .toBe("ocean");

    await page.evaluate(() => window.location.reload());
    await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });

    const state = await page.evaluate(() => ({
      dark: document.documentElement.classList.contains("dark"),
      theme: document.documentElement.getAttribute("data-theme"),
    }));
    expect(state).toEqual({ dark: true, theme: "ocean" });
  });
});
