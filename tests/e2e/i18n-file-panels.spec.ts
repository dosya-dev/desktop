import type { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The file detail panel and the file dialogs in Turkish: the panel's Details
 * tab (versions, properties, share links, actions) and its Comments tab, the
 * share dialog, Get info for a file and a folder, and the hide and lock
 * dialogs. Each surface is spot-checked for a few Turkish strings
 * (src/i18n/messages/tr.json), then swept for English the catalog knows,
 * scoped to that surface.
 *
 * The listing and the endpoints the dialogs read are stubbed here, shaped
 * like the real API: the shared mock has no folders, no can_lock/can_hide,
 * no share-link list and no lock/hide state.
 */

const now = 1_741_000_000;

function file(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, size_bytes: 2_048_000, mime_type: "application/pdf", extension: name.split(".").pop(),
    region: "eu-west-1", created_at: now, updated_at: now, current_version: 1, lock_mode: "none",
    is_hidden: 0, hidden_mode: "none", uploaded_by: "user_test_1", uploader_name: "Test User",
    share_count: 0, comment_count: 0, is_synced: 0, origin: "desktop", folder_id: null, ...extra,
  };
}

const FOLDER = {
  id: "fld_client", name: "Client Work", created_at: now, updated_at: now, file_count: 3, lock_mode: "view_only",
  is_hidden: 1, hidden_mode: "everyone", is_synced: 0, total_size_bytes: 9_000_000, content_updated_at: now,
  region: "eu-west-1", uploader_name: "Test User", share_count: 0, comment_count: 0, origin: "mobile",
};

const FILES = [
  file("f_plan", "Launch plan.pdf", { current_version: 2, comment_count: 3, share_count: 2 }),
  file("f_notes", "Meeting notes.pdf", { lock_mode: "full_lock" }),
  // No versions stub: the shared mock answers with a single version.
  file("f_summary", "Summary.pdf"),
];

const DENIED = { status: 403, contentType: "application/json", body: JSON.stringify({ ok: false, error: "x" }) };

async function stubApi(page: Page) {
  await page.route("**/api/files?*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, folders: [FOLDER], files: FILES, breadcrumbs: [],
        pagination: { page: 1, per_page: 100, total_files: 2, total_pages: 1 },
        can_lock: true, can_hide: true, folder_view_only: false,
      }),
    }),
  );
  // Two versions, so the older one offers Restore.
  await page.route("**/api/files/f_plan/versions", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true, current_version: 2,
        versions: [2, 1].map((n) => ({
          id: `ver_${n}`, version_number: n, size_bytes: 1024 * n, extension: "pdf",
          uploaded_by: "user_test_1", created_at: now - (2 - n) * 86_400, uploader_name: "Test User",
        })),
      }),
    }),
  );
  await page.route("**/api/files/f_plan/share", (route) => {
    if (route.request().method() === "POST") {
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, link: { url: "https://dosya.dev/s/abc123" } }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        links: [
          { id: "sl_1", url: "https://dosya.dev/s/abc123", view_count: 4, download_count: 1, expires_at: null, is_password_protected: 1, is_revoked: 0, created_at: now },
          { id: "sl_2", url: "https://dosya.dev/s/def456", view_count: 0, download_count: 0, expires_at: now - 10, is_password_protected: 0, is_revoked: 0, created_at: now },
        ],
      }),
    });
  });
  await page.route("**/api/files/*/lock", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, lock_mode: "full_lock", locked_by_name: "Test User", locked_at: null }),
    }),
  );
  await page.route("**/api/files/*/hide", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, hidden_mode: "users", rules: [{ target_id: "user_other" }] }),
    }),
  );
  await page.route("**/api/team?*", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        members: [
          { user_id: "user_test_1", name: "Test User", email: "test@example.com", role_id: "role_owner", is_you: true },
          { user_id: "user_other", name: "Grace Hopper", email: "grace@example.com", role_id: "role_member", is_you: false },
        ],
      }),
    }),
  );
  await page.route("**/api/roles?*", (route) =>
    route.fulfill({
      status: 200, contentType: "application/json",
      body: JSON.stringify({ ok: true, roles: [{ id: "role_owner", name: "Finance team" }, { id: "role_member", name: "Design crew" }] }),
    }),
  );
}

/** Switches to Turkish first: an open panel covers the titlebar language menu. */
async function open(page: Page, route = "/files") {
  await stubApi(page);
  await navigateTo(page, "/files");
  await switchLanguage(page, "tr");
  if (route !== "/files") await navigateTo(page, route);
}

const PANEL = '[data-testid="file-detail-panel"]';
const MODAL = ".anim-modal-panel";

async function rowMenu(page: Page, name: string, item: string) {
  await page.locator("tbody").getByText(name, { exact: true }).click({ button: "right" });
  await page.getByRole("button", { name: item, exact: true }).click();
}

test.describe("File panel and dialogs in Turkish", () => {
  test("detail panel: details tab with versions and share links", async ({ appPage: page }) => {
    await open(page, "/files?panel=f_plan");
    const panel = page.locator(PANEL);
    await expect(panel.getByText("Dosya ayrıntıları")).toBeVisible();
    await expect(panel.getByText("Sürümler", { exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Geri yükle" })).toBeVisible();
    await expect(panel.getByText("Paylaşım bağlantıları")).toBeVisible();
    await expect(panel.getByText("4 görüntüleme")).toBeVisible();
    await expect(panel.getByText("Süresiz")).toBeVisible();
    await expect(panel.getByText("Yükleyen")).toBeVisible();
    expect(await leftoverEnglish(page, PANEL)).toEqual([]);
  });

  test("detail panel: the lone-version hint from Version history", async ({ appPage: page }) => {
    await open(page);
    await rowMenu(page, "Summary.pdf", "Sürüm geçmişi");
    const panel = page.locator(PANEL);
    await expect(panel.getByText("Sürümler", { exact: true })).toBeVisible();
    await expect(panel.getByTitle("Sürümü indir: 1")).toBeVisible();
    await expect(panel.getByText(/^Şimdilik tek sürüm var/)).toBeVisible();
    expect(await leftoverEnglish(page, PANEL)).toEqual([]);
  });

  test("detail panel: comments tab", async ({ appPage: page }) => {
    await open(page, "/files?panel=f_plan");
    const panel = page.locator(PANEL);
    await panel.getByRole("button", { name: /^Yorumlar/ }).click();
    await expect(page.getByTestId("comment-cmt_1")).toBeVisible();
    await expect(page.getByTestId("comment-input")).toHaveAttribute("placeholder", "Yorum yazın…");
    await page.getByTestId("comment-cmt_1-reply").click();
    await expect(page.getByTestId("comment-reply-strip")).toContainText("Yanıt: Test User");
    expect(await leftoverEnglish(page, PANEL)).toEqual([]);

    await page.getByTestId("comment-cmt_1-edit").click();
    await expect(page.getByTestId("comment-edit-save")).toHaveText("Kaydet");
    expect(await leftoverEnglish(page, PANEL)).toEqual([]);
  });

  test("share dialog: by email, by link, advanced options, created link", async ({ appPage: page }) => {
    await open(page);
    await rowMenu(page, "Launch plan.pdf", "Paylaş");
    const modal = page.locator(MODAL);
    await expect(modal.getByRole("button", { name: "E-posta ile" })).toBeVisible();
    await expect(modal.getByText("Alıcılar", { exact: true })).toBeVisible();
    await expect(modal.getByText("Bağlantı süresi")).toBeVisible();
    await modal.getByRole("button", { name: "Gelişmiş ayarlar" }).click();
    await expect(modal.getByText("Parola (isteğe bağlı)")).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);

    await modal.getByTestId("restrict-to-recipients").check();
    await modal.getByRole("button", { name: "Gönder" }).click();
    await expect(modal.getByText("En az bir e-posta adresi ekleyin.")).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);

    await modal.getByRole("button", { name: "Bağlantı ile" }).click();
    await expect(modal.getByText("Bağlantıya sahip herkes bu dosyaya erişebilir.")).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);
    await modal.getByRole("button", { name: "Bağlantı oluştur" }).click();
    await expect(modal.getByText("https://dosya.dev/s/abc123")).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);
  });

  test("Get info for a file and a folder", async ({ appPage: page }) => {
    await open(page);
    await rowMenu(page, "Launch plan.pdf", "Bilgileri göster");
    const modal = page.locator(MODAL);
    await expect(modal.getByText("Tür", { exact: true })).toBeVisible();
    await expect(modal.getByText("2 sürüm")).toBeVisible();
    await expect(modal.getByText("3 yorum")).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);
    await modal.getByRole("button", { name: "Kapat" }).click();

    await rowMenu(page, "Client Work", "Bilgileri göster");
    await expect(modal.getByText(/^Klasör · 3 öğe · /)).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);
  });

  test("hide dialog", async ({ appPage: page }) => {
    await open(page);
    await rowMenu(page, "Launch plan.pdf", "Gizle");
    const modal = page.locator(MODAL);
    await expect(modal.getByText("Dosya gizleme")).toBeVisible();
    await expect(modal.getByText("Belirli üyelerden gizli")).toBeVisible();
    await expect(modal.getByText("1 seçili")).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);

    await modal.getByText("Belirli rollerden gizli").click();
    await modal.getByRole("button", { name: "Uygula" }).click();
    await expect(modal.getByText("En az bir rol seçin.")).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);
  });

  test("lock dialog", async ({ appPage: page }) => {
    await open(page);
    await rowMenu(page, "Meeting notes.pdf", "Kilidi aç");
    const modal = page.locator(MODAL);
    await expect(modal.getByText("Dosya kilidi")).toBeVisible();
    await expect(modal.getByRole("radiogroup", { name: "Erişim düzeyi" })).toBeVisible();
    await expect(modal.getByPlaceholder("Yeni bir parola yazın")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Parolayı göster" })).toBeVisible();
    await modal.getByPlaceholder("Yeni bir parola yazın").fill("abc");
    await modal.getByPlaceholder("Yeni bir parola yazın").press("Enter");
    await expect(modal.getByText("En az 8 karakter kullanın.")).toBeVisible();
    // The mode names, descriptions, status line, password label and apply
    // button (lib/lock-mode.ts) follow the language too.
    await expect(modal.getByText("Kilitsiz", { exact: true })).toBeVisible();
    await expect(modal.getByText("Parolalı kilit · Ayarlayan: Test User")).toBeVisible();
    await expect(modal.getByText("Yeni parola", { exact: true })).toBeVisible();
    await expect(modal.getByRole("button", { name: "Parolayı güncelle" })).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);
  });

  test("lock dialog for a folder", async ({ appPage: page }) => {
    await page.route("**/api/folders/*/lock", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, lock_mode: "view_only", locked_by_name: null, locked_at: null }),
      }),
    );
    await open(page);
    await rowMenu(page, "Client Work", "Kilidi aç");
    const modal = page.locator(MODAL);
    await expect(modal.getByText("Şu anda salt görüntüleme")).toBeVisible();
    await expect(modal.getByText(/^Klasör · 3 dosya · /)).toBeVisible();
    await expect(modal.getByText("Üyeler içeriğe göz atabilir ve önizleme yapabilir ancak içeriği indiremez.")).toBeVisible();
    await modal.getByText("Kilitsiz", { exact: true }).click();
    await expect(modal.getByRole("button", { name: "Kilidi kaldır" })).toBeVisible();
    await modal.getByText("Parola", { exact: true }).click();
    await expect(modal.getByText("En az 8 karakter.")).toBeVisible();
    await expect(modal.getByRole("button", { name: "Parolayla kilitle" })).toBeVisible();
    expect(await leftoverEnglish(page, MODAL)).toEqual([]);
  });
});
