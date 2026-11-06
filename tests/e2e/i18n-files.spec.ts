import type { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The Files page in Turkish: the folder listing as a table and as cards, a
 * file's and a folder's context menu, the bulk-selection bar, the move
 * picker, a delete confirmation, the trash, and the photo and document
 * libraries. Each surface is spot-checked for a few Turkish strings
 * (src/i18n/messages/tr.json), then swept for English the catalog knows.
 *
 * /api/files and /api/library are stubbed here, shaped like the real API:
 * the shared mock answers /api/files without `folders` or `pagination`, so a
 * folder row, its menu and the pager would never render against it.
 */

const now = 1_741_000_000;

function file(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, size_bytes: 2_048_000, mime_type: "application/octet-stream", extension: name.split(".").pop(),
    region: "eu-west-1", created_at: now, updated_at: now, current_version: 1, lock_mode: "none",
    is_hidden: 0, hidden_mode: "none", uploaded_by: "user_test_1", uploader_name: "Test User",
    share_count: 0, comment_count: 0, is_synced: 0, origin: "desktop", folder_id: null, ...extra,
  };
}

const FOLDER = {
  id: "fld_client", name: "Client Work", created_at: now, updated_at: now, file_count: 3, lock_mode: "none",
  is_hidden: 0, hidden_mode: "none", is_synced: 0, total_size_bytes: 9_000_000, content_updated_at: now,
  region: "eu-west-1", uploader_name: "Test User", share_count: 0, comment_count: 0, origin: "mobile",
};

const FILES = [
  file("f_plan", "Launch plan.docx", { current_version: 2, comment_count: 2, share_count: 1 }),
  file("f_budget", "Budget sheet.xlsx", { is_hidden: 1, hidden_mode: "everyone" }),
  file("f_notes", "Meeting notes.txt", { lock_mode: "read_only" }),
];

async function stubFiles(page: Page) {
  await page.route("**/api/files?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, folders: [FOLDER], files: FILES, breadcrumbs: [],
        pagination: { page: 1, per_page: 100, total_files: 140, total_pages: 2 },
        can_lock: true, can_hide: true, folder_view_only: false,
      }),
    }),
  );
}

async function stubLibrary(page: Page) {
  await page.route("**/api/library?*", (route) => {
    const kind = new URL(route.request().url()).searchParams.get("kind");
    const names = kind === "documents" ? ["Contract draft.pdf", "Invoice 0042.pdf"] : ["Harbour at dusk.jpg", "Market street.jpg"];
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, kind,
        months: [{ key: "2025-03", label: "March 2025", files: names.map((n, i) => ({ ...file(`lib_${i}`, n), taken_at: now })) }],
        next_cursor: null, counts: { "2025-03": 2 }, total: 2, can_lock: true, can_hide: true,
      }),
    });
  });
}

async function openFiles(page: Page, route = "/files") {
  await stubFiles(page);
  await stubLibrary(page);
  await navigateTo(page, route);
  await switchLanguage(page, "tr");
}

test.describe("Files page in Turkish", () => {
  test("file list as a table and as cards", async ({ appPage: page }) => {
    await openFiles(page);
    await expect(page.getByRole("button", { name: "Yeni klasör" })).toBeVisible();
    await expect(page.getByPlaceholder("Dosyalarda ara…")).toBeVisible();
    await expect(page.locator("thead")).toContainText("Boyut");
    await expect(page.getByText("3 dosya", { exact: true })).toBeVisible();
    await expect(page.getByText("Sayfa 1 / 2 (140 dosya)")).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);

    // The column picker.
    await page.getByTitle("Tablo sütunları").click();
    expect(await leftoverEnglish(page)).toEqual([]);
    await page.getByTitle("Tablo sütunları").click({ force: true });

    await page.getByRole("button", { name: "Izgara görünümü" }).click();
    await expect(page.getByText("Klasörler", { exact: true })).toBeVisible();
    await expect(page.getByText("3 öğe", { exact: true })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
    await page.getByRole("button", { name: "Liste görünümü" }).click();
  });

  test("file and folder context menus, bulk bar, move picker", async ({ appPage: page }) => {
    await openFiles(page);

    await page.locator("tbody").getByText("Launch plan.docx", { exact: true }).click({ button: "right" });
    await expect(page.getByRole("button", { name: "Düzenleyicide aç" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sürüm geçmişi" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);

    // Move to... opens the destination picker.
    await page.getByRole("button", { name: "Taşıma hedefi seç…" }).click();
    await expect(page.getByText("Taşıma: “Launch plan.docx”")).toBeVisible();
    await expect(page.getByText("Kök (en üst düzey)")).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
    await page.getByRole("button", { name: "İptal" }).click();

    await page.locator("tbody").getByText("Client Work", { exact: true }).click({ button: "right" });
    await expect(page.getByRole("button", { name: "Aç", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Bilgileri göster" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
    await page.keyboard.press("Escape");
    await page.mouse.click(5, 5);

    await page.getByRole("checkbox", { name: "Seç: Launch plan.docx" }).check();
    await expect(page.getByText("1 öğe seçildi")).toBeVisible();
    await expect(page.getByRole("button", { name: "ZIP olarak indir" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  test("delete confirmation", async ({ appPage: page }) => {
    await openFiles(page);
    await page.locator("tbody").getByText("Meeting notes.txt", { exact: true }).click({ button: "right" });
    await page.getByRole("button", { name: "Sil", exact: true }).click();
    await expect(page.getByText(/Bu işlemi Silinenler filtresinden geri alabilirsiniz/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "1 öğe silinsin mi?" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  test("trash view", async ({ appPage: page }) => {
    await openFiles(page, "/files?deleted=1");
    await expect(page.getByText(/Çöp kutusundaki öğeler de depolama alanınızı kullanır/)).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);

    await page.locator("tbody").getByText("Budget sheet.xlsx", { exact: true }).click({ button: "right" });
    await expect(page.getByRole("button", { name: "Geri yükle" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
    await page.getByRole("button", { name: "Kalıcı olarak sil" }).click();
    await expect(page.getByRole("heading", { name: "Kalıcı olarak silinsin mi?" })).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
  });

  test("photo and document libraries", async ({ appPage: page }) => {
    await openFiles(page, "/files?filter=images");
    await expect(page.getByText("Fotoğraflar", { exact: true }).first()).toBeVisible();
    await expect(page.getByText("2 fotoğraf · tüm klasörler")).toBeVisible();
    await expect(page.getByText("2 fotoğrafın tümü gösteriliyor.")).toBeVisible();
    await expect(page.locator("select").first()).toContainText("Çekim tarihi · en yeni");
    expect(await leftoverEnglish(page)).toEqual([]);

    await navigateTo(page, "/files?filter=documents");
    await expect(page.getByTestId("library-table-header")).toContainText("Oluşturulma tarihi");
    await expect(page.getByText("2 belgenin tümü gösteriliyor.")).toBeVisible();
    expect(await leftoverEnglish(page)).toEqual([]);
  });
});
