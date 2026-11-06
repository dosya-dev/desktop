import type { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * File requests, Shared links, Activity and Integrations in Turkish. Each
 * surface is spot-checked for a few Turkish strings (src/i18n/messages/tr.json),
 * then swept for English the catalog knows, scoped to the page (its dialogs
 * and the request detail panel render inside it) and to toasts where one is
 * raised. The lock dialog's lib/lock-mode.ts text is covered in
 * i18n-file-panels.spec.ts.
 *
 * The endpoints are stubbed here so every state shows at once: requests that
 * are active, full, expired and closed; recipients invited, uploaded and not
 * sent; links active, expiring, expired and revoked; an activity feed of
 * several event types with a second page.
 */

const REQUESTS = "[data-testid=file-requests-page]";
const SHARED = "[data-testid=shared-links-page]";
const ACTIVITY = "[data-testid=activity-page]";
const INTEGRATIONS = "[data-testid=integrations-page]";
const TOASTS = "[data-sonner-toaster]";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const now = Math.floor(Date.now() / 1000);

function request(id: string, title: string | null, extra: Record<string, unknown> = {}) {
  return {
    id, token: `tok_${id}`, title, message: null, is_password_protected: 0, expires_at: null,
    allowed_extensions: null, max_file_size_bytes: null, max_files: null, upload_count: 0, is_revoked: 0,
    created_at: now - 3600, folder_id: null, created_by_name: "Test User", folder_name: null,
    url: `https://dosya.dev/upload-request/tok_${id}`, ...extra,
  };
}

const REQUEST_ROWS = [
  request("req_a", "Client brand assets", { upload_count: 1, is_password_protected: 1, expires_at: now + 7 * 86_400 }),
  request("req_b", "Tax receipts", { upload_count: 3, max_files: 3, folder_id: "fld_gone" }),
  request("req_c", null, { expires_at: now - 86_400, folder_id: "fld_x", folder_name: "Clients" }),
  request("req_d", "Old invoices", { is_revoked: 1 }),
];

async function stubRequests(page: Page) {
  await page.route("**/api/file-requests?*", (r) => r.fulfill(json({ ok: true, requests: REQUEST_ROWS })));
  await page.route("**/api/file-requests/req_a/uploads", (r) =>
    r.fulfill(json({
      ok: true,
      uploads: [
        { id: "u1", file_id: "f1", uploader_email: null, uploader_name: null, created_at: now, file_name: "logo.png", size_bytes: 512 },
        { id: "u2", file_id: "f2", uploader_email: null, uploader_name: null, created_at: now, file_name: "brief.pdf", size_bytes: 1536 },
      ],
    })),
  );
  await page.route("**/api/file-requests/req_a/recipients*", (r) =>
    r.fulfill(json({
      ok: true,
      recipients: [
        { id: "r1", email: "client@example.com", sent_at: now, uploaded_at: null, created_at: now },
        { id: "r2", email: "done@example.com", sent_at: now, uploaded_at: now, created_at: now },
        { id: "r3", email: "later@example.com", sent_at: null, uploaded_at: null, created_at: now },
      ],
    })),
  );
  await page.route("**/api/file-requests/req_c/uploads", (r) => r.fulfill(json({ ok: true, uploads: [] })));
  await page.route("**/api/file-requests/req_c/recipients*", (r) => r.fulfill(json({ ok: true, recipients: [] })));
  await page.route("**/api/file-requests/req_a", (r) => r.fulfill(json({ ok: true })));
}

function link(id: string, name: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    link_id: id, token: id, expires_at: null, view_count: 3, download_count: 1, is_revoked: status === "revoked" ? 1 : 0,
    shared_at: now - 86_400, is_password_protected: 0, file_id: `f_${id}`, file_name: name, size_bytes: 1024,
    extension: "pdf", region: "eu-west", folder_name: null, sharer_name: "Test User", status,
    display_name: name, url: `https://dosya.dev/s/${id}`, is_mine: true, ...extra,
  };
}

async function stubShares(page: Page) {
  await page.route("**/api/shares?*", (r) =>
    r.fulfill(json({
      ok: true,
      links: [
        link("s1", "Launch plan.pdf", "active", { is_password_protected: 1 }),
        link("s2", "Budget 2026.xlsx", "expiring", { expires_at: now + 86_400 }),
        link("s3", "Old deck.key", "expired", { expires_at: now - 86_400, region: null }),
        link("s4", "Draft.docx", "revoked"),
      ],
      stats: { total: 4, active: 1, expiring: 1, total_views: 12 },
    })),
  );
  await page.route("**/api/shares/s1/revoke", (r) => r.fulfill(json({ ok: true })));
}

function activity(id: string, action: string, meta: Record<string, unknown> | null = null, userName: string | null = "Test User") {
  return {
    id, action, entity_type: "file", entity_id: "f1", created_at: now - 120, user_name: userName,
    user_id: "user_other", user_email: null, user_avatar: null, meta,
  };
}

async function stubActivity(page: Page) {
  await page.route("**/api/activity?*", (r) =>
    r.fulfill(json({
      ok: true,
      activities: [
        activity("a1", "file_uploaded", { name: "Launch plan.pdf" }),
        activity("a2", "file_renamed", { old_name: "a.txt", new_name: "b.txt" }),
        activity("a3", "folder_created", { name: "Clients" }),
        activity("a4", "member_invited", { email: "grace@example.com" }),
        activity("a5", "file_request_uploaded", { file_count: 4, via: "Tax receipts" }),
        activity("a6", "file_permanently_deleted", null, null),
      ],
      pagination: { page: 1, per_page: 50, total: 1234, total_pages: 25 },
    })),
  );
}

async function inTurkish(page: Page, route: string, root: string): Promise<void> {
  await navigateTo(page, route);
  await switchLanguage(page, "tr");
  await expect(page.locator(root)).toBeVisible();
}

test.describe("File requests in Turkish", () => {
  test("list with every status", async ({ appPage: page }) => {
    await stubRequests(page);
    await inTurkish(page, "/file-requests", REQUESTS);
    const root = page.locator(REQUESTS);

    await expect(root.getByRole("heading", { name: "Dosya istekleri" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Yeni istek" })).toBeVisible();
    await expect(page.getByTestId("request-req_a")).toContainText("Etkin");
    await expect(page.getByTestId("request-req_a")).toContainText("1 dosya");
    await expect(page.getByTestId("request-req_a")).toContainText("Parola");
    await expect(page.getByTestId("request-req_a")).toContainText("Çalışma alanı kökü");
    await expect(page.getByTestId("request-req_b")).toContainText("Dolu");
    await expect(page.getByTestId("request-req_b")).toContainText("Bilinmeyen klasör");
    await expect(page.getByTestId("request-req_c")).toContainText("Başlıksız istek");
    await expect(page.getByTestId("request-req_c")).toContainText("Süresi doldu");
    await expect(page.getByTestId("request-req_d")).toContainText("Kapalı");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);

    await page.getByTestId("request-req_a-copy").click();
    await expect(page.locator(TOASTS)).toContainText("Bağlantı kopyalandı");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("empty list", async ({ appPage: page }) => {
    await page.route("**/api/file-requests?*", (r) => r.fulfill(json({ ok: true, requests: [] })));
    await inTurkish(page, "/file-requests", REQUESTS);
    await expect(page.getByTestId("requests-empty")).toContainText("Henüz dosya isteği yok");
    await expect(page.getByTestId("requests-empty")).toContainText("Herkesten dosya almak için bir istek oluşturun");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);
  });

  test("create dialog and the close confirmation", async ({ appPage: page }) => {
    await stubRequests(page);
    await page.route("**/api/file-requests/req_a", (r) => r.fulfill(json({ ok: true })));
    await inTurkish(page, "/file-requests", REQUESTS);
    const root = page.locator(REQUESTS);

    await page.getByTestId("request-new").click();
    await expect(root.getByRole("heading", { name: "Yeni dosya isteği" })).toBeVisible();
    await expect(page.getByTestId("create-title")).toHaveAttribute("placeholder", "Ör. 2. çeyrek kampanyası için marka materyalleri");
    await expect(root).toContainText("E-posta ile davet (isteğe bağlı)");
    await expect(page.getByTestId("create-max-files")).toHaveAttribute("placeholder", "Sınırsız");
    await expect(page.getByTestId("create-submit")).toHaveText("İstek oluştur");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);
    await page.getByTestId("create-cancel").click();

    await page.getByTestId("request-req_a-close").click();
    await expect(root.getByRole("heading", { name: "Bu istek kapatılsın mı?" })).toBeVisible();
    await expect(page.getByTestId("close-confirm")).toHaveText("İsteği kapat");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);
    await page.getByTestId("close-confirm").click();
    await expect(page.locator(TOASTS)).toContainText("İstek kapatıldı");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("request detail: uploads, recipients and edit", async ({ appPage: page }) => {
    await stubRequests(page);
    await inTurkish(page, "/file-requests", REQUESTS);

    await page.getByTestId("request-req_a-open").click();
    const detail = page.getByTestId("request-detail");
    await expect(detail).toContainText("Yüklemeler (2)");
    await expect(detail.getByTestId("upload-u1")).toContainText("512 B");
    // The shared byte formatter: Turkish decimal comma.
    await expect(detail.getByTestId("upload-u2")).toContainText("1,5 KB");
    await expect(detail).toContainText("Alıcılar (3)");
    await expect(detail.getByTestId("request-resend-all")).toHaveText("Tümünü yeniden gönder (2)");
    await expect(detail.getByTestId("recipient-r1")).toContainText("Davet edildi");
    await expect(detail.getByTestId("recipient-r2")).toContainText("Yüklendi");
    await expect(detail.getByTestId("recipient-r3")).toContainText("Gönderilmedi");
    await expect(detail.getByTestId("recipient-r1-resend")).toHaveAttribute("title", "Daveti yeniden gönder");
    await expect(detail.getByTestId("recipient-add-input")).toHaveAttribute("placeholder", "Başka bir alıcı davet edin");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);

    // The client's own email check (the request dialog covers the titlebar,
    // so the language cannot be switched from here).
    await detail.getByTestId("recipient-add-input").fill("not-an-email");
    await detail.getByTestId("recipient-add").click();
    await expect(detail.getByTestId("recipient-add-error")).toHaveText("Geçerli bir e-posta adresi girin.");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);
    await detail.getByTestId("recipient-add-input").fill("");
    await expect(detail.getByTestId("recipient-add-error")).toHaveCount(0);

    await detail.getByTestId("request-edit").click();
    await expect(detail.getByTestId("request-edit-title")).toHaveAttribute("placeholder", "Başlık");
    await expect(detail.getByTestId("request-edit-save")).toHaveText("Kaydet");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);
    await detail.getByTestId("request-edit-title").fill("Q3 assets");
    await detail.getByTestId("request-edit-save").click();
    await expect(page.locator(TOASTS)).toContainText("İstek güncellendi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("request detail with nothing uploaded and nobody invited", async ({ appPage: page }) => {
    await stubRequests(page);
    await inTurkish(page, "/file-requests", REQUESTS);
    await page.getByTestId("request-req_c-open").click();
    const detail = page.getByTestId("request-detail");
    await expect(detail).toContainText("Başlıksız istek");
    await expect(detail.getByTestId("request-uploads-empty")).toHaveText("Henüz hiçbir şey yüklenmedi.");
    await expect(detail.getByTestId("request-recipients-empty")).toHaveText("Kimse davet edilmedi. Bağlantı, davet olmadan da çalışır.");
    expect(await leftoverEnglish(page, REQUESTS)).toEqual([]);
  });
});

test.describe("Shared links in Turkish", () => {
  test("list with active, expiring, expired and revoked links", async ({ appPage: page }) => {
    await stubShares(page);
    await inTurkish(page, "/shared", SHARED);
    const root = page.locator(SHARED);

    await expect(root.getByRole("heading", { name: "Paylaşılanlar" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Paylaştıklarım" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Tümü" })).toBeVisible();
    await expect(root.getByRole("columnheader", { name: "Geçerlilik süresi" })).toBeVisible();
    await expect(root.locator("tbody")).toContainText("Süresi dolmak üzere");
    await expect(root.locator("tbody")).toContainText("Geçersiz kılındı");
    await expect(root.locator("tbody")).toContainText("Süresiz");
    await expect(root).toContainText("Etkin bağlantılar");
    await expect(root.getByPlaceholder("Filtreleyin…")).toBeVisible();
    expect(await leftoverEnglish(page, SHARED)).toEqual([]);

    await root.getByRole("button", { name: "Süresi doldu" }).click();
    await expect(root.locator("tbody")).toContainText("Old deck.key");
    await root.getByRole("button", { name: "Geçersiz kılındı" }).click();
    await expect(root.locator("tbody")).toContainText("Draft.docx");
    await root.getByPlaceholder("Filtreleyin…").fill("zzz");
    await expect(root).toContainText("Paylaşım bağlantısı bulunamadı");
    expect(await leftoverEnglish(page, SHARED)).toEqual([]);
  });

  test("revoke confirmation and toast", async ({ appPage: page }) => {
    await stubShares(page);
    await inTurkish(page, "/shared", SHARED);
    const root = page.locator(SHARED);

    await root.locator("tr", { hasText: "Launch plan.pdf" }).getByTitle("Geçersiz kıl").click();
    await expect(root.getByRole("heading", { name: "Paylaşım bağlantısı geçersiz kılınsın mı?" })).toBeVisible();
    await expect(root).toContainText("Launch plan.pdf için paylaşım bağlantısını geçersiz kılmak istiyor musunuz? Bu işlem geri alınamaz.");
    expect(await leftoverEnglish(page, SHARED)).toEqual([]);
    // The row buttons share the name through their title; the dialog's comes last.
    await root.getByRole("button", { name: "Geçersiz kıl", exact: true }).last().click();
    await expect(page.locator(TOASTS)).toContainText("Paylaşım bağlantısı geçersiz kılındı");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });
});

test.describe("Activity in Turkish", () => {
  test("feed of several event types with paging", async ({ appPage: page }) => {
    await stubActivity(page);
    await inTurkish(page, "/activity", ACTIVITY);
    const root = page.locator(ACTIVITY);

    await expect(root.getByRole("heading", { name: "Etkinlik günlüğü" })).toBeVisible();
    await expect(root).toContainText("Bu çalışma alanında 1.234 etkinlik");
    await expect(root).toContainText("Test User bir dosya yükledi.");
    await expect(root).toContainText("Test User bir dosyayı yeniden adlandırdı.");
    await expect(root).toContainText("Test User bir klasör oluşturdu.");
    await expect(root).toContainText("Test User bir üye davet etti.");
    await expect(root).toContainText("Test User bir dosya isteği üzerinden dosya aldı.");
    await expect(root).toContainText("Birisi bir dosyayı kalıcı olarak sildi.");
    await expect(root).toContainText("4 dosya");
    await expect(root).toContainText("Kaynak: Tax receipts");
    // Pager numbers grouped the same way as the header total.
    await expect(root).toContainText("1–50 / 1.234");
    // The event code itself never reaches the screen.
    await expect(root).not.toContainText("file_renamed");
    expect(await leftoverEnglish(page, ACTIVITY)).toEqual([]);
  });

  test("error state", async ({ appPage: page }) => {
    await page.route("**/api/activity?*", (r) => r.fulfill(json({ ok: false, error: "boom" }, 500)));
    await inTurkish(page, "/activity", ACTIVITY);
    const root = page.locator(ACTIVITY);
    await expect(root).toContainText("Etkinlikler yüklenemedi. Bağlantınızı kontrol edip yeniden deneyin.", { timeout: 15_000 });
    expect(await leftoverEnglish(page, ACTIVITY)).toEqual([]);
  });

  test("empty feed", async ({ appPage: page }) => {
    await page.route("**/api/activity?*", (r) => r.fulfill(json({ ok: true, activities: [] })));
    await inTurkish(page, "/activity", ACTIVITY);
    const root = page.locator(ACTIVITY);
    await expect(root).toContainText("Henüz etkinlik yok.");
    expect(await leftoverEnglish(page, ACTIVITY)).toEqual([]);
  });
});

test.describe("Integrations in Turkish", () => {
  test("built-in tools and connection cards", async ({ appPage: page }) => {
    await inTurkish(page, "/integrations", INTEGRATIONS);
    const root = page.locator(INTEGRATIONS);

    await expect(root.getByRole("heading", { name: "Entegrasyonlar" })).toBeVisible();
    await expect(root.getByRole("heading", { name: "Yerleşik araçlar" })).toBeVisible();
    await expect(root).toContainText("Yinelenen dosya bulucu");
    await expect(root).toContainText("Web kancaları");
    await expect(root).toContainText("Uzaktan indirme");
    // Product names stay as they are.
    await expect(root).toContainText("WebDAV");
    await expect(root).toContainText("Google Drive");
    await expect(page.getByTestId("integration-card-webdav")).toHaveAttribute("aria-label", "Kurulumu aç: WebDAV");
    await expect(page.getByTestId("tool-card-duplicates")).toHaveAttribute("aria-label", "Aç: Yinelenen dosya bulucu");
    await expect(root.getByRole("button", { name: "Belgeleri oku" }).first()).toBeVisible();
    expect(await leftoverEnglish(page, INTEGRATIONS)).toEqual([]);
  });
});
