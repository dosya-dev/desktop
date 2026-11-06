import type { Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { test, guestTest, expect, launchApp, navigateTo, resizeWindow, electronAppFor } from "../fixtures";
import { startMockServer } from "../helpers/mock-api";
import { boxOf, horizontalOverflow, leftoverEnglish, physicalClassesIn, switchLanguage, unflippedIcons } from "../helpers/i18n-sweep";

/**
 * The app in a right-to-left language, in the real Electron window: the page
 * direction, which side the sidebar and its flyouts sit on, no sideways
 * overflow, and the shell (sidebar and titlebar) free of physical-direction
 * classes and of directional icons that do not flip. Later tasks extend this
 * file with their screens.
 */

// The titlebar row itself is left out: its padding is the reservation for the
// macOS traffic lights, physical on purpose (rtl-ok in TitleBar.tsx).
const SHELL = "aside, [data-testid=titlebar] > *";

test.describe("right-to-left shell in Arabic", () => {
  test("the page is rtl and the sidebar sits on the right", async ({ appPage: page }) => {
    await switchLanguage(page, "ar");
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");

    const aside = await boxOf(page, "aside");
    const main = await boxOf(page, "main");
    expect(aside.x).toBeGreaterThanOrEqual(main.x + main.width - 1);
  });

  test("nothing overflows sideways at 1200 and 700 px", async ({ appPage: page }) => {
    await switchLanguage(page, "ar");
    for (const [w, h] of [[1200, 800], [700, 560]] as const) {
      await resizeWindow(page, w, h);
      expect(await horizontalOverflow(page), `${w}px`).toBe(0);
    }
  });

  test("the shell has no physical class and no unflipped icon", async ({ appPage: page }) => {
    await switchLanguage(page, "ar");
    // The Files tree open, so its indented children are in the sweep too.
    await page.getByTestId("nav-files-toggle").click();
    await expect(page.getByTestId("nav-files-images")).toBeVisible();
    expect(await physicalClassesIn(page, SHELL)).toEqual([]);
    expect(await unflippedIcons(page, SHELL)).toEqual([]);

    // And with the tree shut (the disclosure chevron at rest).
    await page.getByTestId("nav-files-toggle").click();
    expect(await unflippedIcons(page, SHELL)).toEqual([]);

    // Collapsed: the rail's own icons.
    await page.getByTestId("sidebar-collapse-toggle").click();
    await expect(page.locator("aside")).toHaveCSS("width", "60px");
    expect(await physicalClassesIn(page, SHELL)).toEqual([]);
    expect(await unflippedIcons(page, SHELL)).toEqual([]);
  });

  test("the collapsed sidebar's flyouts open toward the content, left of the rail", async ({ appPage: page }) => {
    await switchLanguage(page, "ar");
    await page.getByTestId("sidebar-collapse-toggle").click();
    await expect(page.locator("aside")).toHaveCSS("width", "60px");
    const aside = await boxOf(page, "aside");

    // The mirror of left-to-right, where the flyout starts 6px past the row's right edge.
    const row = await boxOf(page, "[data-testid=nav-files]");
    await page.getByTestId("nav-files").click();
    const files = await boxOf(page, "[data-testid=nav-files-flyout]");
    expect(Math.abs(files.x + files.width - (row.x - 6))).toBeLessThanOrEqual(1);
    expect(files.x).toBeLessThan(aside.x);
    expect(files.x).toBeGreaterThanOrEqual(0);
    await page.keyboard.press("Escape");
    await page.mouse.click(10, 300);

    const switcher = await boxOf(page, "[data-testid=workspace-switcher]");
    await page.getByTestId("workspace-switcher").click();
    const ws = await boxOf(page, "[data-testid=workspace-menu]");
    expect(Math.abs(ws.x + ws.width - (switcher.x - 6))).toBeLessThanOrEqual(1);
    expect(ws.x).toBeLessThan(aside.x);
    expect(ws.x).toBeGreaterThanOrEqual(0);
  });

  test("the popups stay on screen", async ({ appPage: page }) => {
    await switchLanguage(page, "ar");
    const width = await page.evaluate(() => window.innerWidth);
    await page.getByTestId("open-notifications").click();
    const bell = await boxOf(page, "[data-testid=notification-dropdown]");
    expect(bell.x).toBeGreaterThanOrEqual(0);
    expect(bell.x + bell.width).toBeLessThanOrEqual(width);
  });
});

test.describe("right-to-left Windows title bar", () => {
  test("the button cluster ends before the caption buttons", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_E2E_PLATFORM: "win32" });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      await expect(page.getByTestId("app-menu-button")).toBeVisible();
      expect(await page.evaluate(() => document.documentElement.dataset.platform)).toBe("win32");

      // English first: the cluster sits on the left, clear of the overlay as before.
      const ltr = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll("[data-testid=titlebar] button")].map((b) => b.getBoundingClientRect());
        return { left: Math.min(...buttons.map((r) => r.left)) };
      });
      expect(ltr.left).toBeLessThan(100);

      await switchLanguage(page, "ar");
      const geometry = await page.evaluate(() => {
        const probe = document.createElement("div");
        probe.style.width = "var(--titlebar-inset-right)";
        probe.style.position = "absolute";
        document.body.appendChild(probe);
        const insetRight = probe.getBoundingClientRect().width;
        probe.remove();
        const buttons = [...document.querySelectorAll("[data-testid=titlebar] button")].map((b) => b.getBoundingClientRect());
        return { insetRight, innerWidth: window.innerWidth, rightmost: Math.max(...buttons.map((r) => r.right)) };
      });
      expect(geometry.insetRight).toBeGreaterThan(0);
      expect(geometry.rightmost).toBeLessThanOrEqual(geometry.innerWidth - geometry.insetRight);
      expect(await physicalClassesIn(page, "[data-testid=titlebar]")).toEqual([]);
      expect(await unflippedIcons(page, "[data-testid=titlebar]")).toEqual([]);
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});

/** The macOS titlebar row's padding, its buttons' outer edges and the two inset variables. */
async function macTitlebarGeometry(page: Page) {
  return page.evaluate(() => {
    const probe = (v: string) => {
      const el = document.createElement("div");
      el.style.position = "absolute";
      el.style.width = `var(${v})`;
      document.body.appendChild(el);
      const w = el.getBoundingClientRect().width;
      el.remove();
      return w;
    };
    const row = document.querySelector<HTMLElement>("[data-testid=titlebar]")!;
    const cs = getComputedStyle(row);
    const buttons = [...row.querySelectorAll("button")].map((b) => b.getBoundingClientRect()).filter((r) => r.width > 0);
    return {
      osDir: document.documentElement.dataset.osDir ?? null,
      innerWidth: window.innerWidth,
      paddingLeft: parseFloat(cs.paddingLeft),
      paddingRight: parseFloat(cs.paddingRight),
      leftmost: Math.min(...buttons.map((r) => r.left)),
      rightmost: Math.max(...buttons.map((r) => r.right)),
      insetLeft: probe("--titlebar-inset-left"),
      insetRight: probe("--titlebar-inset-right"),
    };
  });
}

test.describe("macOS title bar on the side the OS draws the traffic lights", () => {
  test("an LTR macOS keeps the lights' room on the left in both app directions", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_E2E_PLATFORM: "darwin" });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      await expect(page.getByTestId("titlebar")).toBeVisible();
      for (const lang of ["en", "ar"] as const) {
        if (lang === "ar") await switchLanguage(page, "ar");
        const g = await macTitlebarGeometry(page);
        expect(g.osDir, lang).toBeNull();
        expect(g.paddingLeft, lang).toBe(80);
        expect(g.paddingRight, lang).toBe(16);
        expect(g.leftmost, lang).toBeGreaterThanOrEqual(80);
        expect(g.insetLeft, lang).toBe(80);
        expect(g.insetRight, lang).toBe(0);
      }
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });

  test("an RTL macOS moves the room to the right, in English and in Arabic", async () => {
    const mock = await startMockServer({ authenticated: true });
    const { app, cleanup } = await launchApp(mock.url, { DOSYA_E2E_PLATFORM: "darwin", DOSYA_E2E_OS_DIR: "rtl" });
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      await expect(page.getByTestId("titlebar")).toBeVisible();
      for (const lang of ["en", "ar"] as const) {
        if (lang === "ar") await switchLanguage(page, "ar");
        const g = await macTitlebarGeometry(page);
        expect(g.osDir, lang).toBe("rtl");
        expect(g.paddingRight, lang).toBe(80);
        expect(g.paddingLeft, lang).toBe(16);
        // The outermost button on the right (the bell in English, the back
        // chevron in Arabic) ends 80px short of the window's right edge.
        expect(g.rightmost, lang).toBeLessThanOrEqual(g.innerWidth - 80);
        expect(g.leftmost, lang).toBeGreaterThanOrEqual(16);
        // Surfaces that cover the title bar (viewer, editors) follow suit.
        expect(g.insetLeft, lang).toBe(0);
        expect(g.insetRight, lang).toBe(80);
      }
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});

// ── The screens, with the mock API's content on them ──────────────────────

/** The Arabic catalog, to find a control by the label it has in Arabic. */
const AR: Record<string, string> = JSON.parse(
  readFileSync(path.join(__dirname, "../../src/i18n/messages/ar.json"), "utf8"),
);

/** Everything the app draws in the main window except the titlebar row's own padding. */
const CONTENT = `${SHELL}, main`;

/** No physical class, no unflipped direction icon, no sideways overflow. */
async function expectMirrored(page: Page, label: string, root = CONTENT): Promise<void> {
  expect(await physicalClassesIn(page, root), `${label}: physical classes`).toEqual([]);
  expect(await unflippedIcons(page, root), `${label}: unflipped icons`).toEqual([]);
  expect(await horizontalOverflow(page), `${label}: sideways overflow`).toBe(0);
}

test.describe("right-to-left screens in Arabic", () => {
  test("files as a list and a grid, the context menu at the cursor, sharing and the viewer", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    await switchLanguage(page, "ar");
    await expect(page.getByText("Project Report.pdf")).toBeVisible();
    await expectMirrored(page, "files list");

    // The menu at the cursor: its right edge on the click, opening leftward.
    const row = await boxOf(page, "text=Project Report.pdf");
    await page.mouse.click(300, row.y + row.height / 2, { button: "right" });
    const menu = await boxOf(page, "div.fixed.z-50.w-52");
    expect(Math.abs(menu.x + menu.width - 300)).toBeLessThanOrEqual(1);
    await expectMirrored(page, "context menu");

    // Near the left edge the menu cannot end at the cursor: it is clamped to
    // 16px from the window's left, the mirror of the right-hand margin in LTR.
    const height = await page.evaluate(() => window.innerHeight);
    await page.mouse.click(5, height - 5); // the overlay behind the menu closes it
    await expect(page.locator("div.fixed.z-50.w-52")).toHaveCount(0);
    await page.mouse.click(40, row.y + row.height / 2, { button: "right" });
    const clamped = await boxOf(page, "div.fixed.z-50.w-52");
    expect(Math.abs(clamped.x - 16)).toBeLessThanOrEqual(1);
    await page.mouse.click(300, row.y + row.height / 2, { button: "right" });

    await page.getByRole("button", { name: AR["files.action.share"], exact: true }).click();
    await expect(page.locator("[data-testid=restrict-to-recipients]")).toBeVisible();
    await expectMirrored(page, "share modal");
    await page.getByRole("button", { name: AR["common.cancel"], exact: true }).click();
    await expect(page.locator("[data-testid=restrict-to-recipients]")).toHaveCount(0);

    await page.getByRole("button", { name: AR["files.accessibility.gridView"] }).first().click();
    await expect(page.getByText("Photo.png").first()).toBeVisible();
    await expectMirrored(page, "files grid");
    await page.getByRole("button", { name: AR["files.accessibility.listView"] }).first().click();

    await navigateTo(page, "/files?view=file_2");
    await expect(page.locator("[data-testid=file-viewer]")).toBeVisible();
    await expectMirrored(page, "file viewer", "[data-testid=file-viewer]");
    expect(await horizontalOverflow(page)).toBe(0);
  });

  test("search, shared links, dashboard, uploads, settings, profile, LAN transfer and the vault", async ({ appPage: page }) => {
    await switchLanguage(page, "ar");
    // `ready` is mock content on the screen, or the screen itself where it
    // shows none from the API.
    const screens: { route: string; ready: string }[] = [
      { route: "/dashboard", ready: "main >> text=Test User" },
      { route: "/search?q=report", ready: "[data-testid=search-page] >> text=Project Report.pdf" },
      { route: "/shared", ready: "[data-testid=shared-links-page] >> text=Project Report.pdf" },
      { route: "/upload", ready: "[data-testid=upload-page]" },
      // The mock API serves no workspace settings: the form shows its defaults.
      { route: "/settings", ready: "[data-testid=settings-page] input[type=text]" },
      { route: "/profile", ready: "[data-testid=profile-page] input[value='test@dosya.dev']" },
      { route: "/lan-transfer", ready: "[data-testid=lan-transfer-page]" },
      { route: "/vault", ready: "[data-testid=vault-setup]" },
    ];
    for (const s of screens) {
      await navigateTo(page, s.route);
      await expect(page.locator(s.ready).first(), s.route).toBeVisible();
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(300);
      expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      await expectMirrored(page, s.route);
    }
  });

  test("sync, with folders, and its row menu under the button's inline end", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    await stageSync(page);
    await switchLanguage(page, "ar");
    const root = page.locator("[data-testid=sync-page]");
    await expect(root).toContainText("Invoices");
    await expectMirrored(page, "sync");

    const button = root.getByRole("row").filter({ hasText: "Invoices" }).locator("button").last();
    const anchor = await button.boundingBox();
    await button.click();
    const menu = await boxOf(page, "[data-testid=sync-page] div.fixed.z-50.w-40");
    // The mirror of left-to-right, where the menu's right edge meets the button's.
    expect(Math.abs(menu.x - anchor!.x)).toBeLessThanOrEqual(1);
    expect(menu.y).toBeGreaterThan(anchor!.y);
    await expectMirrored(page, "sync row menu");
  });
});

/** Where each probe's text sits in its 400 px box, with the app's own CSS. */
async function nameAlignment(page: Page): Promise<Record<string, { align: string; offset: number }>> {
  return page.evaluate(() => {
    document.getElementById("t10-probe")?.remove();
    const host = document.createElement("div");
    host.id = "t10-probe";
    host.style.width = "400px";
    host.innerHTML = [
      '<p dir="auto" class="truncate" id="t10-he">\u05d2\u05d9\u05d1\u05d5\u05d9 2026 (final).zip</p>',
      '<p dir="auto" class="truncate" id="t10-en">report (1).pdf</p>',
      '<p dir="auto" class="truncate text-end" id="t10-end">\u05d2\u05d9\u05d1\u05d5\u05d9</p>',
      '<div class="text-center"><p dir="auto" class="truncate" id="t10-c">report.pdf</p></div>',
      // A block that does not truncate (a sync folder name, a comment).
      '<p dir="auto" class="text-sm font-medium" id="t10-block">\u05d2\u05d9\u05d1\u05d5\u05d9 (2)</p>',
      '<p dir="auto" class="text-sm" id="t10-block-en">Quota exceeded (1).</p>',
    ].join("");
    document.body.appendChild(host);
    const out: Record<string, { align: string; offset: number }> = {};
    for (const id of ["t10-he", "t10-en", "t10-end", "t10-c", "t10-block", "t10-block-en"]) {
      const el = document.getElementById(id)!;
      const range = document.createRange();
      range.selectNodeContents(el);
      const text = range.getBoundingClientRect();
      const box = el.getBoundingClientRect();
      // 0 = flush left, 1 = flush right.
      out[id] = { align: getComputedStyle(el).textAlign, offset: Math.round(((text.left - box.left) / (box.width - text.width)) * 10) / 10 };
    }
    host.remove();
    return out;
  });
}

test.describe("names in their own direction keep their row's alignment", () => {
  test("English carries no dir=auto at all; in Arabic a Latin name sits on the right, truncating or not", async ({ appPage: page }) => {
    await navigateTo(page, "/files");
    expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");
    // A left-to-right language lays names out exactly as before: no dir="auto" anywhere.
    await expect.poll(() => page.locator("main [title]").count()).toBeGreaterThan(0);
    expect(await page.locator('[dir="auto"]').count()).toBe(0);

    await switchLanguage(page, "ar");
    await expect.poll(() => page.locator('main [dir="auto"]').count()).toBeGreaterThan(0);
    const ar = await nameAlignment(page);
    expect(ar["t10-he"].offset).toBe(1);
    expect(ar["t10-en"].offset).toBe(1);
    expect(ar["t10-end"].offset).toBe(0);
    expect(ar["t10-c"].align).toBe("center");
    expect(ar["t10-block"].offset).toBe(1);
    expect(ar["t10-block-en"].offset).toBe(1);
  });
});

test.describe("native menu bar in Arabic", () => {
  test("the application menu carries the Arabic labels", async ({ appPage: page }) => {
    await switchLanguage(page, "ar");
    const labels = await electronAppFor(page).evaluate(({ Menu }) =>
      (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label),
    );
    expect(labels).toContain(AR["menus.label.file.menu"]);
    expect(labels).toContain(AR["menus.heading.edit.menu"]);
  });
});

guestTest.describe("right-to-left onboarding in Arabic", () => {
  guestTest("every step", async ({ appPage: page }) => {
    await page.evaluate(() => window.electronAPI.setLocale("ar"));
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl");
    const next = page.getByRole("button", { name: AR["common.next"] });
    await expect(next).toBeVisible();
    for (let i = 0; i < 4; i++) {
      await expectMirrored(page, `onboarding step ${i + 1}`, "body");
      await next.click();
    }
    await expectMirrored(page, "onboarding last step", "body");
  });
});

// ── The core-screen sweep: ar, he and fa, every screen, both window sizes ──

type RtlLang = "ar" | "he" | "fa";
const RTL_LANGS: readonly RtlLang[] = ["ar", "he", "fa"];

const CATALOGS: Record<RtlLang, Record<string, string>> = Object.fromEntries(
  RTL_LANGS.map((l) => [l, JSON.parse(readFileSync(path.join(__dirname, `../../src/i18n/messages/${l}.json`), "utf8"))]),
) as Record<RtlLang, Record<string, string>>;

/** The mock listing carries a folder row named "Documents": user data that equals a catalog string. */
const MOCK_ALLOW = [
  "Documents",
  // Storage categories on the dashboard and the server's notification group names: text the server sends, shown as it arrives.
  "Images", "Videos", "Account", "Comments", "System", "Share links", "File requests",
];

/** Roster stubs with built-in role names as the server stores them (lowercase): the app shows its own catalog names. */
async function stubTeam(page: Page): Promise<void> {
  const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  const now = Math.floor(Date.now() / 1000);
  await page.route("**/api/team?*", (r) => r.fulfill(json({
    ok: true,
    workspace: { name: "Test Workspace", icon_initials: "TW", icon_color: "#3B82F6" },
    members: [
      { membership_id: "m_me", user_id: "user_test_1", role_id: "role_owner", joined_at: 1_740_000_000, name: "Test User", email: "test@dosya.dev", is_you: true },
      { membership_id: "m_ada", user_id: "u_ada", role_id: "role_member", joined_at: 1_741_000_000, name: "Ada Lovelace", email: "ada@example.test", is_you: false },
      { membership_id: "m_bo", user_id: "u_bo", role_id: "role_viewer", joined_at: 1_742_000_000, name: "Bo Bramble", email: "bo@example.test", is_you: false },
    ],
    invites: [{ id: "inv_1", email: "cy@example.test", role_id: "role_member", created_at: now - 7200, expires_at: 2_000_000_000, invited_by_name: "Test User" }],
    activity: [{ id: "a1", action: "file.upload", metadata: null, created_at: now - 600, user_name: "Ada Lovelace" }],
    stats: { members: 3, pending: 1, shares_this_week: 4 },
  })));
  await page.route("**/api/roles?*", (r) => r.fulfill(json({
    ok: true,
    roles: ["owner", "admin", "member", "viewer"].map((n) => ({ id: `role_${n}`, name: n, is_builtin: true, is_custom: false, permissions: {} })),
  })));
}

/** The app's windows draw in the page, in a modal panel, or in a dialog. */
const EVERYTHING = `${CONTENT}, .anim-modal-panel, [role=dialog]`;

/**
 * One screen in a right-to-left language: the page is rtl, no English the
 * catalog knows is left, no physical class, no unflipped icon, and nothing
 * overflows sideways at 1200x800 or at 700x560.
 */
async function sweepScreen(page: Page, lang: RtlLang, label: string, root = EVERYTHING, resize = true): Promise<void> {
  expect(await page.evaluate(() => document.documentElement.dir), `${label}: dir`).toBe("rtl");
  // The sweep's matcher reads the mock file "Versioned Report.pdf" as the word
  // "Version" plus a suffix when a result row's text is read whole: a false
  // positive on user data, so rows that start with that name are not leftovers.
  const leftover = (await leftoverEnglish(page, "body", { lang, allow: MOCK_ALLOW })).filter((t) => !t.startsWith("Versioned Report.pdf"));
  expect(leftover, `${label}: leftover English`).toEqual([]);
  expect(await physicalClassesIn(page, root), `${label}: physical classes`).toEqual([]);
  expect(await unflippedIcons(page, root), `${label}: unflipped icons`).toEqual([]);
  if (!resize) {
    // A window the harness has no handle on (About): its own size.
    expect(await horizontalOverflow(page), `${label}: sideways overflow`).toBe(0);
    return;
  }
  for (const [w, h] of [[1200, 800], [700, 560]] as const) {
    await resizeWindow(page, w, h);
    await page.waitForTimeout(150);
    expect(await horizontalOverflow(page), `${label}: sideways overflow at ${w}px`).toBe(0);
  }
  await resizeWindow(page, 1200, 800);
}

async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(300);
}

for (const lang of RTL_LANGS) {
  const M = CATALOGS[lang];

  test.describe(`core screens in ${lang}`, () => {
    test.describe.configure({ timeout: 180_000 });

    test("dashboard, files, a folder, the detail panel, the viewers and the share modal", async ({ appPage: page }) => {
      await navigateTo(page, "/files");
      await switchLanguage(page, lang);
      expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");

      await navigateTo(page, "/dashboard");
      await expect(page.locator("main >> text=Test User").first()).toBeVisible();
      await settle(page);
      await sweepScreen(page, lang, "dashboard");

      await navigateTo(page, "/files");
      await expect(page.getByText("Project Report.pdf")).toBeVisible();
      await sweepScreen(page, lang, "files list");

      await page.getByRole("button", { name: M["files.accessibility.gridView"] }).first().click();
      await expect(page.getByText("Photo.png").first()).toBeVisible();
      await sweepScreen(page, lang, "files grid");
      await page.getByRole("button", { name: M["files.accessibility.listView"] }).first().click();

      const row = await boxOf(page, "text=Project Report.pdf");
      await page.mouse.click(300, row.y + row.height / 2, { button: "right" });
      await page.getByRole("button", { name: M["files.action.share"], exact: true }).click();
      await expect(page.locator("[data-testid=restrict-to-recipients]")).toBeVisible();
      await sweepScreen(page, lang, "share modal");
      await page.getByRole("button", { name: M["common.cancel"], exact: true }).click();
      await expect(page.locator("[data-testid=restrict-to-recipients]")).toHaveCount(0);

      await navigateTo(page, "/files?folder=folder_1");
      await settle(page);
      await sweepScreen(page, lang, "a folder");

      await navigateTo(page, "/files?panel=file_1");
      await expect(page.locator("[data-testid=file-detail-panel]")).toBeVisible();
      await settle(page);
      await sweepScreen(page, lang, "file detail panel");

      // The open viewer covers the titlebar, so each is opened from the list.
      await navigateTo(page, "/files");
      await navigateTo(page, "/files?view=file_2");
      await expect(page.locator("[data-testid=file-viewer]")).toBeVisible();
      await settle(page);
      await sweepScreen(page, lang, "image viewer", "[data-testid=file-viewer]");

      await navigateTo(page, "/files");
      await navigateTo(page, "/files?view=file_1");
      await expect(page.locator("[data-testid=file-viewer]")).toBeVisible();
      await settle(page);
      await sweepScreen(page, lang, "pdf viewer", "[data-testid=file-viewer]");
    });

    test("shared links, file requests, search, upload, LAN transfer and the vault gate", async ({ appPage: page }) => {
      await switchLanguage(page, lang);
      const screens: { route: string; ready: string }[] = [
        { route: "/shared", ready: "[data-testid=shared-links-page] >> text=Project Report.pdf" },
        { route: "/file-requests", ready: "[data-testid=request-req_1]" },
        { route: "/search?q=report", ready: "[data-testid=search-page] >> text=Project Report.pdf" },
        { route: "/upload", ready: "[data-testid=upload-page]" },
        { route: "/lan-transfer", ready: "[data-testid=lan-transfer-page]" },
        { route: "/vault", ready: "[data-testid=vault-setup]" },
      ];
      for (const s of screens) {
        await navigateTo(page, s.route);
        await expect(page.locator(s.ready).first(), s.route).toBeVisible();
        await settle(page);
        await sweepScreen(page, lang, s.route);
      }
    });

    test("sync with a pair, settings, team, groups and notifications", async ({ appPage: page }) => {
      await stubTeam(page);
      await navigateTo(page, "/sync");
      await stageSync(page);
      await switchLanguage(page, lang);
      await expect(page.locator("[data-testid=sync-page]")).toContainText("Invoices");
      await settle(page);
      await sweepScreen(page, lang, "sync");

      const screens: { route: string; ready: string }[] = [
        { route: "/settings", ready: "[data-testid=settings-page] input[type=text]" },
        { route: "/team", ready: "[data-testid=team-page]" },
        { route: "/groups", ready: "[data-testid=groups-page]" },
        { route: "/notifications", ready: "main" },
      ];
      for (const s of screens) {
        await navigateTo(page, s.route);
        await expect(page.locator(s.ready).first(), s.route).toBeVisible();
        await settle(page);
        await sweepScreen(page, lang, s.route);
      }

      // Every tab of the workspace settings.
      await navigateTo(page, "/settings");
      const settingsTabs = page.locator("[data-testid=settings-page] button").filter({ has: page.locator("svg") });
      const settingsCount = await settingsTabs.count();
      for (let i = 0; i < Math.min(settingsCount, 6); i++) {
        await settingsTabs.nth(i).click();
        await settle(page);
        await sweepScreen(page, lang, `settings tab ${i + 1}`);
      }
    });

    test("every profile tab", async ({ appPage: page }) => {
      await switchLanguage(page, lang);
      await navigateTo(page, "/profile");
      await expect(page.locator("[data-testid=profile-page] input[value='test@dosya.dev']").first()).toBeVisible();
      const tabs = page.locator("[data-testid=profile-page] > div.w-48 button");
      const count = await tabs.count();
      expect(count).toBeGreaterThanOrEqual(8);
      for (let i = 0; i < count; i++) {
        const name = ((await tabs.nth(i).innerText()) || `tab ${i + 1}`).trim();
        await tabs.nth(i).click();
        await settle(page);
        await sweepScreen(page, lang, `profile tab ${i + 1} (${name})`);
      }
    });

    test("the About window", async ({ appPage: page }) => {
      await switchLanguage(page, lang);
      const app = electronAppFor(page);
      const windowPromise = app.waitForEvent("window");
      const found = await app.evaluate(({ Menu }, l) => {
        for (const top of Menu.getApplicationMenu()?.items ?? []) {
          const item = top.submenu?.items.find((i) => i.label === l);
          if (item) { item.click(); return true; }
        }
        return false;
      }, M["about.window.aboutDosya"]);
      expect(found, "the About menu item").toBe(true);
      const about = await windowPromise;
      await about.waitForLoadState("domcontentloaded");
      await expect(about.getByTestId("about-version")).toBeVisible();
      await sweepScreen(about, lang, "about window", "body", false);
    });

    test("then German: ltr and German text in place", async ({ appPage: page }) => {
      await switchLanguage(page, lang);
      expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      await switchLanguage(page, "de");
      expect(await page.evaluate(() => document.documentElement.dir)).toBe("ltr");
      const de: Record<string, string> = JSON.parse(readFileSync(path.join(__dirname, "../../src/i18n/messages/de.json"), "utf8"));
      await expect(page.getByTestId("nav-dashboard")).toHaveText(de["common.label.dashboard"]);
      const aside = await boxOf(page, "aside");
      const main = await boxOf(page, "main");
      expect(aside.x + aside.width).toBeLessThanOrEqual(main.x + 1);
    });
  });
}

guestTest.describe("right-to-left sign-in and onboarding in ar, he and fa", () => {
  for (const lang of RTL_LANGS) {
    guestTest(`${lang}: onboarding and login`, async ({ appPage: page }) => {
      const M = CATALOGS[lang];
      await page.evaluate((l) => window.electronAPI.setLocale(l), lang);
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      const next = page.getByRole("button", { name: M["common.next"], exact: true });
      await expect(next).toBeVisible();
      for (let i = 0; i < 4; i++) {
        await sweepScreen(page, lang, `${lang} onboarding step ${i + 1}`, "body");
        await next.click();
      }
      await sweepScreen(page, lang, `${lang} onboarding last step`, "body");

      await navigateTo(page, "/login");
      await page.reload();
      await page.waitForLoadState("domcontentloaded");
      await expect.poll(() => page.evaluate(() => document.documentElement.dir)).toBe("rtl");
      await settle(page);
      await sweepScreen(page, lang, `${lang} login`, "body");
    });
  }
});

test.describe("boot in a stored right-to-left language", () => {
  test("fa: the first titlebar paint is already rtl", async () => {
    const mock = await startMockServer({ authenticated: true });
    // The stored language, as the app wrote it on an earlier run.
    const { app, cleanup } = await launchApp(mock.url, {}, (dir) =>
      writeFileSync(path.join(dir, "locale.json"), JSON.stringify({ locale: "fa" })),
    );
    try {
      const page = await app.firstWindow();
      await page.waitForFunction(() => window.location.hash.includes("/dashboard"), { timeout: 15_000 });
      expect(await page.evaluate(() => document.documentElement.dir)).toBe("rtl");

      // Record the page direction the moment the titlebar first exists, then
      // load the app again from the stored language.
      await app.context().addInitScript(() => {
        const w = window as unknown as { __firstTitlebarDir?: string };
        const note = (): boolean => {
          if (w.__firstTitlebarDir || !document.querySelector("[data-testid=titlebar]")) return false;
          w.__firstTitlebarDir = document.documentElement.dir;
          return true;
        };
        new MutationObserver((_m, obs) => { if (note()) obs.disconnect(); }).observe(document, { childList: true, subtree: true });
      });
      await page.reload();
      await page.waitForSelector("[data-testid=titlebar]", { timeout: 15_000 });
      expect(await page.evaluate(() => (window as unknown as { __firstTitlebarDir?: string }).__firstTitlebarDir)).toBe("rtl");
    } finally {
      await app.close().catch(() => {});
      await mock.close().catch(() => {});
      cleanup();
    }
  });
});

/** Two pairs the engine reports (one idle, one syncing), held until the app closes. */
async function stageSync(page: Page): Promise<void> {
  const now = Date.now();
  const pair = (id: string, name: string, extra: Record<string, unknown> = {}) => ({
    pairId: id, workspaceId: "ws_test_1", workspaceName: "Test Workspace", remoteFolderName: name,
    localPath: `/Users/test/${name}`, syncMode: "push-safe", status: "idle",
    lastSyncedAt: now - 5 * 60_000, errorMessage: null, notices: [], fileErrors: [],
    fileErrorCount: 0, pendingDeletion: null, filesInQueue: 0, totalFilesInBatch: 0,
    completedFilesInBatch: 0, totalBytesInBatch: 0, completedBytesInBatch: 0, batchStartedAt: 0,
    syncStartedAt: 0, phase: null, scannedFiles: 0, scannedFolders: 0, statusText: "", ...extra,
  });
  const snapshot = {
    pairs: [
      pair("p_idle", "Invoices"),
      pair("p_sync", "Holiday clips", {
        status: "syncing", phase: "transferring", totalFilesInBatch: 10, completedFilesInBatch: 3,
        totalBytesInBatch: 100_000_000, completedBytesInBatch: 30_000_000, batchStartedAt: now - 60_000,
        syncStartedAt: now - 65_000,
      }),
    ],
    globalPaused: false, activeTransfers: [], unresolvedConflictCount: 0,
    conflictCountByPair: {}, recentLogs: [], fileErrorCount: 0,
  };
  await electronAppFor(page).evaluate(({ ipcMain, BrowserWindow }, snapshot) => {
    const g = globalThis as any;
    g.__stagedSync = snapshot;
    ipcMain.removeHandler("sync:get-config");
    ipcMain.handle("sync:get-config", () => ({ pairs: [] }));
    ipcMain.removeHandler("sync:get-status");
    ipcMain.handle("sync:get-status", () => g.__stagedSync);
    ipcMain.removeHandler("sync:list-conflicts");
    ipcMain.handle("sync:list-conflicts", () => ({ conflicts: [], total: 0 }));
    for (const w of BrowserWindow.getAllWindows()) {
      const wc = w.webContents as any;
      if (!wc.__syncStaged) {
        const send = wc.send.bind(wc);
        wc.send = (channel: string, ...args: unknown[]) =>
          channel === "sync:status-changed" ? send(channel, g.__stagedSync) : send(channel, ...args);
        wc.__syncStaged = true;
      }
      wc.send("sync:status-changed", snapshot);
    }
  }, snapshot);
}
