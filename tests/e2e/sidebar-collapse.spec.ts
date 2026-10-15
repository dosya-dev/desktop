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

  /**
   * The rail animates its width over 200ms, but `collapsed` flips the rows'
   * layout the instant it changes. If the collapsed layout centres the icons
   * with `justify-content`, which cannot animate, every icon leaps to the
   * middle of the still-260px-wide rail at frame zero and then slides back
   * left as the rail shrinks around it: "the icons centre first, then the
   * menu closes". The icon must stay where it is while the rail closes, and
   * still sit in the middle of the rail once the animation has settled.
   */
  test("the icons stay put while the rail closes", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await expect(page.getByTestId("sidebar-collapse-toggle")).toBeVisible();

    // Every row that keeps a glyph in the collapsed rail: nav icons, the
    // workspace initials, the search glass and the profile avatar. The glyph
    // is the row's first element child (the nav rows wrap theirs in a span).
    const ICONS = ["nav-files", "nav-sync", "nav-settings", "workspace-switcher", "sidebar-search", "sidebar-profile"];
    const probe = await page.evaluate(async (ids) => {
      const left = (id: string) =>
        document.querySelector(`[data-testid="${id}"] > *`)?.getBoundingClientRect().left ?? null;
      const before = Object.fromEntries(ids.map((id) => [id, left(id)]));
      document.querySelector<HTMLElement>('[data-testid="sidebar-collapse-toggle"]')!.click();
      // React 18 commits a discrete event's state change in a microtask, not
      // inside the dispatch, so one animation frame later the DOM carries the
      // collapsed layout while the 200ms width transition has barely begun.
      // This is the frame in which the user sees the jump.
      await new Promise((r) => requestAnimationFrame(r));
      const atStart = Object.fromEntries(ids.map((id) => [id, left(id)]));
      return { before, atStart };
    }, ICONS);

    for (const id of ICONS) {
      const b = probe.before[id];
      const a = probe.atStart[id];
      if (b === null) continue; // hidden by permissions in this fixture
      expect(a, `${id} vanished when the sidebar started closing`).not.toBeNull();
      expect(
        Math.abs(a! - b),
        `${id} icon jumped ${Math.round(a! - b)}px the instant the sidebar started closing`,
      ).toBeLessThan(8);
    }

    await page.waitForTimeout(SETTLE_MS);
    const settled = await page.evaluate((ids) => {
      const aside = document.querySelector("aside")!.getBoundingClientRect();
      return ids.map((id) => {
        const r = document.querySelector(`[data-testid="${id}"] > *`)?.getBoundingClientRect();
        return r ? { id, off: r.left + r.width / 2 - (aside.left + aside.width / 2) } : null;
      });
    }, ICONS);
    for (const s of settled) {
      if (!s) continue;
      expect(Math.abs(s.off), `${s.id} icon sits ${s.off.toFixed(1)}px off the rail's centre once collapsed`).toBeLessThan(2);
    }
  });

  /**
   * The settle checks above say nothing about the 200ms in between. The pill
   * eases its left/width toward the row it is measured from, and during the
   * collapse that row shrinks faster than the pill follows - at real speed the
   * pill overhangs the nav by up to ~110px around the 90ms mark. Because the
   * nav scrolls vertically, that overhang made it scrollable sideways too, and
   * macOS flashed a horizontal scrollbar under the icons every time the rail
   * closed. Slowed ten-fold so the wheel reliably lands mid-flight.
   */
  test("cannot be scrolled sideways while the rail is closing", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await expect(page.getByTestId("sidebar-collapse-toggle")).toBeVisible();
    await page.evaluate(() => {
      const st = document.createElement("style");
      st.textContent = "aside, aside nav > div[aria-hidden] { transition-duration: 2000ms !important; }";
      document.head.appendChild(st);
    });
    await page.getByTestId("sidebar-collapse-toggle").click();
    await page.waitForTimeout(600);

    const nav = page.locator("aside nav");
    const box = (await nav.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.wheel(80, 0);
    await page.waitForTimeout(100);

    const state = await nav.evaluate((el) => ({ scrollLeft: el.scrollLeft, over: el.scrollWidth - el.clientWidth }));
    expect(state.over, "precondition: the pill should be overhanging the nav mid-flight").toBeGreaterThan(0);
    expect(state.scrollLeft, `nav scrolled ${state.scrollLeft}px sideways during the collapse`).toBe(0);
  });
});
