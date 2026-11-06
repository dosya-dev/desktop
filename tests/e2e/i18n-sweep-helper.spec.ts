import { test, expect } from "@playwright/test";
import { boxOf, filterLeftover, horizontalOverflow, physicalClassesIn, unflippedIcons } from "../helpers/i18n-sweep";

/**
 * The sweep's exclusions, without an app: mock user data is skipped, but
 * never when it is also English the catalog knows. "Documents" is both a
 * sidebar label and a mock notification-group label; "System" is both the
 * theme mode and a mock group label.
 */
test.describe("i18n sweep exclusions", () => {
  test("English that also appears in the mock data is still reported", () => {
    expect(filterLeftover(["Documents", "System", "File requests", "Genel bakış"])).toEqual([
      "Documents",
      "File requests",
      "System",
    ]);
  });

  test("plain user data and do-not-translate names are skipped", () => {
    expect(filterLeftover(["Test User", "test@dosya.dev", "Test Workspace", "report.pdf was uploaded", "Vault", "dosya.dev"])).toEqual([]);
  });

  test("an explicit allow-list excuses a catalog string shown as user data", () => {
    expect(filterLeftover(["Documents", "Upload"], { allow: ["Documents"] })).toEqual(["Upload"]);
  });
});

/**
 * The right-to-left helpers, on an injected DOM (no app): they read the live
 * page, so a blank page with a few elements is enough.
 */
test.describe("rtl sweep helpers", () => {
  test("physicalClassesIn finds an injected ml-2 and ignores it under [dir=ltr]", async ({ page }) => {
    await page.setContent('<div id="a" class="flex ml-2 text-left"></div>');
    expect(await physicalClassesIn(page)).toEqual(["ml-2", "text-left"]);
    await page.setContent('<div dir="ltr"><div class="ml-2"></div></div><div class="ms-2"></div>');
    expect(await physicalClassesIn(page)).toEqual([]);
  });

  test("physicalClassesIn scopes to a root and skips a centering pair", async ({ page }) => {
    await page.setContent(
      '<div id="in"><div class="absolute left-1/2 -translate-x-1/2"></div></div><div id="out" class="mr-1"></div>',
    );
    expect(await physicalClassesIn(page, "#in")).toEqual([]);
    expect(await physicalClassesIn(page, "#out")).toEqual(["mr-1"]);
  });

  test("unflippedIcons finds a bare chevron and accepts one with rtl:-scale-x-100", async ({ page }) => {
    await page.setContent('<svg class="lucide lucide-chevron-right"></svg>');
    expect(await unflippedIcons(page)).toEqual(["lucide-chevron-right"]);
    await page.setContent(
      '<svg class="lucide lucide-chevron-right rtl:-scale-x-100"></svg>' +
        '<div dir="ltr"><svg class="lucide lucide-arrow-left"></svg></div>' +
        '<svg class="lucide lucide-external-link"></svg>',
    );
    expect(await unflippedIcons(page)).toEqual([]);
  });

  test("boxOf and horizontalOverflow read the layout", async ({ page }) => {
    await page.setContent('<div id="b" style="width:40px;height:20px"></div>');
    expect(await boxOf(page, "#b")).toMatchObject({ width: 40, height: 20 });
    expect(await horizontalOverflow(page)).toBe(0);
    await page.setContent('<div style="width:5000px;height:10px"></div>');
    expect(await horizontalOverflow(page)).toBeGreaterThan(0);
  });
});
