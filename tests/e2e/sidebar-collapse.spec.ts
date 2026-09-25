import { test, expect, navigateTo } from "../fixtures";

/**
 * Collapsing the sidebar must not leave the nav scrollable sideways.
 *
 * The active-row pill is an absolutely positioned div whose width is measured
 * from the active row. The sidebar animates its width over 200ms, and the
 * measurement runs in a layout effect the moment `collapsed` flips - which is
 * before that animation has moved a pixel. So the pill keeps the width it had
 * at 260px and sits, ~200px wide, inside a nav that is now about 36px wide.
 *
 * The nav is `overflow-y-auto`, and a box with one axis scrollable and the
 * other visible resolves both to scrollable, so the leftover pill makes the
 * navigation scroll horizontally. Nothing re-measures when the animation
 * finishes; the next measurement is triggered by a route change, which is why
 * the symptom clears as soon as you open another page.
 */
const SETTLE_MS = 400; // the sidebar's own transition is 200ms

function navOverflow(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const nav = document.querySelector("aside nav");
    if (!nav) return null;
    return { scrollWidth: nav.scrollWidth, clientWidth: nav.clientWidth };
  });
}

test.describe("sidebar collapse", () => {
  test("leaves no horizontal scroll in the navigation", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await expect(page.getByTestId("sidebar-collapse-toggle")).toBeVisible();

    const expanded = await navOverflow(page);
    expect(expanded).not.toBeNull();
    expect(expanded!.scrollWidth).toBeLessThanOrEqual(expanded!.clientWidth);

    await page.getByTestId("sidebar-collapse-toggle").click();
    await page.waitForTimeout(SETTLE_MS);

    const collapsed = await navOverflow(page);
    expect(
      collapsed!.scrollWidth,
      `nav scrolls sideways by ${collapsed!.scrollWidth - collapsed!.clientWidth}px after collapsing`,
    ).toBeLessThanOrEqual(collapsed!.clientWidth);
  });

  test("and none after expanding again", async ({ appPage: page }) => {
    // The same staleness in the other direction: measured at 60px, rendered at
    // 260px, leaving the pill too short rather than too wide. It does not
    // overflow, but it must still end up matching the row it highlights.
    await navigateTo(page, "/files");
    const toggle = page.getByTestId("sidebar-collapse-toggle");
    await toggle.click();
    await page.waitForTimeout(SETTLE_MS);
    await toggle.click();
    await page.waitForTimeout(SETTLE_MS);

    const after = await navOverflow(page);
    expect(after!.scrollWidth).toBeLessThanOrEqual(after!.clientWidth);

    const pill = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>("aside nav > div[aria-hidden]");
      const row = document.querySelector<HTMLElement>("aside nav [data-active]");
      if (!el || !row) return null;
      return { pill: el.getBoundingClientRect().width, row: row.getBoundingClientRect().width };
    });
    expect(pill).not.toBeNull();
    // Within a pixel of the row it is meant to be sitting behind.
    expect(Math.abs(pill!.pill - pill!.row)).toBeLessThan(2);
  });
});
