import type { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../fixtures";

/**
 * The photo library's grid, virtualized (audit finding DSK-004).
 *
 * Before this, LibraryGrid rendered every loaded item and `useLibrary` kept
 * every page: 25 "Load 60 more" pages put 15,322 elements in the DOM, and the
 * append itself grew from 104 ms to 433 ms with 16 long tasks. What these specs
 * pin down is that both costs are now flat in the number of pages, and - the
 * part virtualization is easy to get wrong - that selecting a whole month still
 * covers the photos in it that the viewport has never mounted.
 *
 * The library feed is stubbed here rather than in `tests/helpers/mock-api.ts`:
 * the helper has no /api/library route (its fallback answers `{ok: true}`), and
 * these are the only specs that need one.
 */

const PAGE_SIZE = 60;

/** A 1x1 PNG, so every tile's <img> actually decodes instead of failing over to the icon. */
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function monthOf(index: number, perMonth: number) {
  const bucket = Math.floor(index / perMonth);
  const year = 2024 - Math.floor(bucket / 12);
  const month = 12 - (bucket % 12);
  return { key: `${year}-${String(month).padStart(2, "0")}`, label: `${MONTHS[month - 1]} ${year}` };
}

function photo(index: number) {
  const taken = 1_700_000_000 - index * 3_600;
  return {
    id: `lib_${index}`,
    name: `IMG_${10_000 + index}.jpg`,
    size_bytes: 2_000_000,
    mime_type: "image/jpeg",
    extension: "jpg",
    region: "eu-west",
    created_at: taken,
    updated_at: taken,
    current_version: 1,
    lock_mode: "none",
    is_hidden: 0,
    uploaded_by: "user_test_1",
    uploader_name: "Test User",
    share_count: 0,
    comment_count: 0,
    is_synced: 1,
    folder_id: null,
    taken_at: taken,
  };
}

/**
 * A cursor-paged /api/library, shaped like the real one: `counts`, `total`,
 * `can_lock` and `can_hide` ride the FIRST (cursor-less) page only, which is
 * also what makes the page cap's eviction of that page interesting.
 */
async function stubLibrary(page: Page, total: number, perMonth: number) {
  const counts: Record<string, number> = {};
  for (let i = 0; i < total; i++) {
    const { key } = monthOf(i, perMonth);
    counts[key] = (counts[key] ?? 0) + 1;
  }

  await page.route("**/api/library*", async (route) => {
    const url = new URL(route.request().url());
    const limit = Number(url.searchParams.get("limit")) || PAGE_SIZE;
    const raw = url.searchParams.get("cursor");
    const cursor = raw ? Number(raw) : 0;
    const months: { key: string; label: string; files: ReturnType<typeof photo>[] }[] = [];
    for (let i = cursor; i < Math.min(total, cursor + limit); i++) {
      const { key, label } = monthOf(i, perMonth);
      const last = months[months.length - 1];
      if (last && last.key === key) last.files.push(photo(i));
      else months.push({ key, label, files: [photo(i)] });
    }
    const next = cursor + limit;
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        kind: "photos",
        months,
        next_cursor: next < total ? String(next) : null,
        ...(raw ? {} : { counts, total, can_lock: true, can_hide: true }),
      }),
    });
  });

  for (const glob of ["**/api/files/*/raw*", "**/api/files/*/thumb*"]) {
    await page.route(glob, (route) => route.fulfill({ status: 200, contentType: "image/png", body: PNG }));
  }
}

/**
 * What the footer gauge says is loaded. On the last page the gauge is replaced
 * by "That's all N photos.", so both spellings count - and reading it is how
 * these specs know an append has COMMITTED, not merely been fetched. The
 * reading is spelled out inside each `evaluate` rather than shared: the
 * renderer's CSP has no 'unsafe-eval', so a stringified helper cannot run.
 */
async function probe(page: Page) {
  return page.evaluate(() => {
    const rows = document.querySelector('[data-testid="library-rows"]');
    const t = document.body.innerText;
    const showing = t.match(/Showing ([\d,]+) of/);
    const all = t.match(/That's all ([\d,]+) photos/);
    return {
      tiles: document.querySelectorAll('[data-testid^="photo-"]').length,
      nodes: rows ? rows.querySelectorAll("*").length : 0,
      images: document.querySelectorAll("img").length,
      loaded: showing
        ? parseInt(showing[1].replace(/,/g, ""), 10)
        : all ? parseInt(all[1].replace(/,/g, ""), 10) : -1,
    };
  });
}

async function loadMore(page: Page, until: number): Promise<number> {
  const button = page.getByRole("button", { name: /^Load \d+ more$/ });
  const started = Date.now();
  await button.first().click();
  await page.waitForFunction(
    (want) => {
      const t = document.body.innerText;
      const showing = t.match(/Showing ([\d,]+) of/);
      if (showing) return parseInt(showing[1].replace(/,/g, ""), 10) >= want;
      const all = t.match(/That's all ([\d,]+) photos/);
      return all ? parseInt(all[1].replace(/,/g, ""), 10) >= want : false;
    },
    until,
    { timeout: 20_000 },
  );
  return Date.now() - started;
}

/** Put the scroller at `ratio` of its range (0 = top, 1 = bottom) and let the grid settle. */
async function scrollTo(page: Page, ratio: number) {
  await page.evaluate((r) => {
    // The grid does not own a scroller - FileBrowserPage wraps it in one, which
    // is also what the month headers stick to.
    const el = document.querySelector('[data-testid="library-grid"]')!.parentElement!;
    el.scrollTop = Math.floor((el.scrollHeight - el.clientHeight) * r);
  }, ratio);
  await page.waitForTimeout(300);
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

test.describe("Library grid", () => {
  test("25 pages of photos keep the DOM bounded and the append flat", async ({ appPage }) => {
    test.setTimeout(180_000);
    const TOTAL = 25 * PAGE_SIZE; // 1,500 - the size the audit measured
    await stubLibrary(appPage, TOTAL, 40); // 38 month sections, like the audit's feed
    await navigateTo(appPage, "/files?filter=images");
    await appPage.getByText(/Showing .* of 1,500 photos/).waitFor({ timeout: 30_000 });

    const first = await probe(appPage);
    expect(first.loaded).toBe(PAGE_SIZE);

    const clicks: number[] = [];
    const samples: Record<number, Awaited<ReturnType<typeof probe>>> = {};
    for (let p = 2; p <= 25; p++) {
      clicks.push(await loadMore(appPage, p * PAGE_SIZE));
      if (p === 9 || p === 17 || p === 25) samples[p] = await probe(appPage);
    }

    // The footer gauge has to keep climbing past the page cap (10 pages), or
    // the end of the feed is unreachable and the progress bar lies.
    expect(samples[25].loaded).toBe(TOTAL);
    await expect(appPage.getByText("That's all 1,500 photos.")).toBeVisible();

    // Mounted tiles are a function of the VIEWPORT, not of how much is loaded.
    // Unvirtualized this was 1,500 tiles and 15,322 elements.
    expect(samples[25].tiles).toBeLessThan(300);
    expect(samples[25].tiles).toBeLessThanOrEqual(Math.round(samples[9].tiles * 1.5) + 12);
    expect(samples[25].nodes).toBeLessThanOrEqual(Math.round(samples[9].nodes * 1.5) + 200);
    expect(samples[25].images).toBeLessThan(300);

    // ...and so the append is flat. Unvirtualized this went 104 -> 433 ms.
    const early = median(clicks.slice(0, 5));
    const late = median(clicks.slice(-5));
    expect(late).toBeLessThanOrEqual(early * 3 + 50);

    // A month header is still pinned to the top of the scrollport in the middle
    // of the feed, which is the sticky separator surviving virtualization.
    await scrollTo(appPage, 0.5);
    const pinned = await appPage.evaluate(() => {
      const scroller = document.querySelector('[data-testid="library-grid"]')!.parentElement!;
      const rows = [...document.querySelectorAll('[data-testid="library-rows"] > div')];
      const sticky = rows.filter((el) => getComputedStyle(el).position === "sticky");
      return {
        count: sticky.length,
        label: sticky[0]?.querySelector("h3")?.textContent ?? null,
        offset: sticky[0] ? Math.round(sticky[0].getBoundingClientRect().top - scroller.getBoundingClientRect().top) : -1,
      };
    });
    expect(pinned.count).toBe(1);
    expect(pinned.label).toMatch(/\w+ 20\d\d/);
    expect(Math.abs(pinned.offset)).toBeLessThanOrEqual(1);
  });

  test("selecting a month covers the photos in it that were never mounted", async ({ appPage }) => {
    test.setTimeout(120_000);
    // 300 photos in two months - 200 in December, 100 in November - so one
    // month is far larger than any window the virtualizer mounts.
    const TOTAL = 5 * PAGE_SIZE;
    await stubLibrary(appPage, TOTAL, 200);
    await navigateTo(appPage, "/files?filter=images");
    await appPage.getByText(/Showing .* of 300 photos/).waitFor({ timeout: 30_000 });
    for (let p = 2; p <= 5; p++) await loadMore(appPage, p * PAGE_SIZE);

    // Partway into the first month: its header is pinned, its first photos are
    // no longer mounted, and most of its 200 are not in the DOM at all.
    await scrollTo(appPage, 0.2);
    await expect(appPage.locator('[data-testid="photo-lib_0"]')).toHaveCount(0);
    const mounted = await appPage.locator('[data-testid^="photo-"]').count();
    expect(mounted).toBeLessThan(150);

    // The month's header row, not one of its tile rows - both carry data-month.
    const pinned = appPage.locator('[data-month="2024-12"]:has(h3)');
    await expect(pinned.locator("h3")).toHaveText("December 2024");

    // `onSelectMany` is handed the month's ids from the model, not from what is
    // mounted, so all 200 are selected even though `mounted` is far fewer.
    await pinned.getByRole("button", { name: "Select all" }).click();
    await expect(appPage.getByText("200 selected")).toBeVisible();
  });
});
