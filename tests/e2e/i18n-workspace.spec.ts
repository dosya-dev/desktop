import type { Page } from "@playwright/test";
import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The workspace pages in Turkish: Settings (General with the icon and the
 * troubleshooting confirmations, Hard limits, Security, Roles, Updates,
 * Danger zone), Team (member list, role change, invite and remove dialogs,
 * pending invites, error and empty states) and Groups (list, rename with the
 * colour row, create with its length rule, delete, empty and error states).
 * Each surface is spot-checked for a few Turkish strings
 * (src/i18n/messages/tr.json), then swept for English the catalog knows,
 * scoped to the page, and toasts where one is raised.
 */

const SETTINGS = "[data-testid=settings-page]";
const TEAM = "[data-testid=team-page]";
const GROUPS = "[data-testid=groups-page]";
const TOASTS = "[data-sonner-toaster]";

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const workspaceResponse = {
  ok: true,
  workspace: { id: "ws_test_1", name: "Test Workspace", slug: "test-workspace", icon_initials: "TW", icon_color: "#3B82F6", icon_image_url: null },
  settings: {
    max_file_size_gb: 5, max_total_storage_gb: 100, max_storage_per_member_gb: 10, max_concurrent_uploads: 5,
    allowed_extensions: null, blocked_extensions: null, require_2fa: 0, disable_share_links: 0,
    force_share_password: 0, share_max_expiry_days: null,
  },
};

async function inTurkish(page: Page, route: string, root: string): Promise<void> {
  await navigateTo(page, route);
  await switchLanguage(page, "tr");
  await expect(page.locator(root)).toBeVisible();
}

async function settingsInTurkish(page: Page): Promise<void> {
  await page.route("**/api/workspaces/ws_test_1", (r) => r.fulfill(json(workspaceResponse)));
  await inTurkish(page, "/settings", SETTINGS);
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.locator(SETTINGS).getByRole("button", { name, exact: true }).click();
}

/** Pushes an update status into the renderer as the updater would. */
async function sendUpdateStatus(page: Page, status: unknown): Promise<void> {
  await electronAppFor(page).evaluate(({ BrowserWindow }, s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("updater:status-changed", s);
  }, status);
}

test.describe("Workspace settings in Turkish", () => {
  test("General tab, icon, save toast and the troubleshooting rows", async ({ appPage: page }) => {
    await settingsInTurkish(page);
    const root = page.locator(SETTINGS);

    await expect(root.getByRole("heading", { name: "Çalışma alanı bilgileri" })).toBeVisible();
    await expect(root).toContainText("Çalışma alanı simgesi");
    await expect(root.getByRole("button", { name: "Fotoğraf yükle" })).toBeVisible();
    await expect(root).toContainText("Özel bir fotoğraf seçilmediğinde kullanılır.");
    await expect(root.getByRole("heading", { name: "Sorun giderme" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Önbelleği temizle" })).toBeVisible();
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);

    await root.getByRole("button", { name: "Değişiklikleri kaydet" }).click();
    await expect(page.locator(TOASTS)).toContainText("Çalışma alanı güncellendi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);

    await root.getByRole("button", { name: "Önbelleği temizle" }).click();
    await expect(page.locator(TOASTS)).toContainText("Önbellek temizlendi", { timeout: 10_000 });
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("Reset app data confirmation", async ({ appPage: page }) => {
    await settingsInTurkish(page);
    const root = page.locator(SETTINGS);

    await root.getByRole("button", { name: "Uygulama verilerini sıfırla" }).click();
    await expect(root.getByRole("heading", { name: "Uygulama verileri sıfırlansın mı?" })).toBeVisible();
    await expect(root).toContainText("Bu cihazdaki oturumunuz");
    await expect(root.getByRole("button", { name: "Sıfırla ve yeniden başlat" })).toBeVisible();
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);

    await root.getByRole("button", { name: "İptal" }).click();
    await expect(root.getByRole("heading", { name: "Uygulama verileri sıfırlansın mı?" })).toHaveCount(0);
  });

  test("Hard limits and Security, saved", async ({ appPage: page }) => {
    await settingsInTurkish(page);
    const root = page.locator(SETTINGS);

    await openTab(page, "Üst sınırlar");
    await expect(root).toContainText("Bir sınırı kaldırmak için değerini 0 yapın.");
    await expect(root).toContainText("Üye başına depolama alanı (GB)");
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);
    await root.getByRole("button", { name: "Sınırları kaydet" }).click();
    await expect(page.locator(TOASTS)).toContainText("Sınırlar güncellendi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);

    await openTab(page, "Güvenlik");
    await expect(root).toContainText("Paylaşım bağlantılarını devre dışı bırak");
    await expect(root).toContainText("Üyeler iki adımlı doğrulamayı etkinleştirmeli.");
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);
    await root.getByRole("button", { name: "Güvenlik ayarlarını kaydet" }).click();
    await expect(page.locator(TOASTS)).toContainText("Güvenlik ayarları güncellendi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("a role that may not change limits or security is told so", async ({ appPage: page }) => {
    await page.route("**/api/me/permissions*", (r) => r.fulfill(json({
      ok: true, user_id: "user_test_1", role_id: "role_viewer", role_name: "viewer", is_builtin: true, root_folder_id: null, permissions: {},
    })));
    // The fixture has already fetched (and cached) the permissions; reload so
    // the app asks again and gets the routed answer.
    await page.reload();
    await page.waitForLoadState("domcontentloaded");
    await settingsInTurkish(page);
    const root = page.locator(SETTINGS);

    await openTab(page, "Üst sınırlar");
    await expect(root).toContainText("Rolünüz bu sınırları değiştirmeye izin vermiyor.");
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);
    await openTab(page, "Güvenlik");
    await expect(root).toContainText("Rolünüz güvenlik ayarlarını değiştirmeye izin vermiyor.");
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);
  });

  test("Roles and Danger zone", async ({ appPage: page }) => {
    await settingsInTurkish(page);
    const root = page.locator(SETTINGS);

    await openTab(page, "Roller");
    await expect(root.getByRole("heading", { name: "Roller ve izinler" })).toBeVisible();
    await expect(root.getByRole("heading", { name: "Rol ve izin yönetimi" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Tarayıcıda aç" })).toBeVisible();
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);

    await openTab(page, "Kritik işlemler");
    await expect(root.getByRole("heading", { name: "Çalışma alanından ayrıl" })).toBeVisible();
    await expect(root.getByRole("heading", { name: "Çalışma alanını sil" })).toBeVisible();
    await expect(root).toContainText("“Test Workspace” adlı çalışma alanına ve dosyalarına erişiminiz hemen sona erer.");
    await expect(root.getByRole("button", { name: "Web üzerinden sil" })).toBeVisible();
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);
  });

  test("Updates tab with builds and update states", async ({ appPage: page }) => {
    await page.route("**/api/desktop/releases", (r) => r.fulfill(json({
      ok: true,
      releases: [
        { version: "9.9.9", date: "2026-10-01", prerelease: true, builds: { windows: { url: "https://x.test/a", size: 1e8, name: "a" }, mac: { url: "https://x.test/b", size: 1e8, name: "b" }, linux: { url: "https://x.test/c", size: 1e8, name: "c" } } },
        { version: "9.9.8", date: "2026-09-01", prerelease: false, builds: { windows: null, mac: null, linux: null } },
      ],
    })));
    await settingsInTurkish(page);
    const root = page.locator(SETTINGS);

    await openTab(page, "Güncellemeler");
    await expect(root.getByRole("heading", { name: "Uygulama güncellemeleri" })).toBeVisible();
    await expect(root).toContainText("dosya.dev masaüstü uygulaması");
    await expect(root).toContainText("Kullandığınız sürüm:");
    await expect(root).toContainText("Ön sürüm");
    await expect(root).toContainText("Mevcut değil");
    await expect(root.getByRole("button", { name: "Güncellemeleri denetle" })).toBeVisible();
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);

    await sendUpdateStatus(page, { state: "downloading", percent: 40 });
    await expect(root).toContainText("İndiriliyor (%40)");
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);

    await sendUpdateStatus(page, { state: "ready", version: "9.9.9" });
    await expect(root).toContainText("Güncelleme hazır: 9.9.9");
    await expect(root.getByRole("button", { name: "Kur ve yeniden başlat" })).toBeVisible();
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);

    await sendUpdateStatus(page, { state: "installing" });
    await expect(root).toContainText("Kuruluyor… dosya.dev birazdan yeniden açılacak.");
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);

    await sendUpdateStatus(page, { state: "not-available" });
    await expect(root).toContainText("Güncel");
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);
  });

  test("Updates tab when the build list fails", async ({ appPage: page }) => {
    await page.route("**/api/desktop/releases", (r) => r.fulfill(json({ ok: false, error: "nope" })));
    await settingsInTurkish(page);
    const root = page.locator(SETTINGS);

    await openTab(page, "Güncellemeler");
    await expect(root).toContainText("Derlemeler yüklenemedi.");
    await expect(root.getByRole("button", { name: "Yeniden dene" })).toBeVisible();
    expect(await leftoverEnglish(page, SETTINGS)).toEqual([]);
  });
});

const teamResponse = {
  ok: true,
  workspace: { name: "Test Workspace", icon_initials: "TW", icon_color: "#3B82F6" },
  members: [
    { membership_id: "m_me", user_id: "user_test_1", role_id: "role_owner", joined_at: 1_740_000_000, name: "Test User", email: "test@dosya.dev", is_you: true },
    { membership_id: "m_ada", user_id: "u_ada", role_id: "role_member", joined_at: 1_741_000_000, name: "Ada Lovelace", email: "ada@example.test", is_you: false },
    { membership_id: "m_bo", user_id: "u_bo", role_id: "role_viewer", joined_at: 1_742_000_000, name: "Bo Bramble", email: "bo@example.test", is_you: false },
  ],
  invites: [
    { id: "inv_1", email: "cy@example.test", role_id: "role_member", created_at: Math.floor(Date.now() / 1000) - 7200, expires_at: 2_000_000_000, invited_by_name: "Test User" },
    { id: "inv_2", email: "di@example.test", role_id: "role_viewer", created_at: Math.floor(Date.now() / 1000) - 3600, expires_at: 2_000_000_000, invited_by_name: null },
  ],
  activity: [{ id: "a1", action: "file.upload", metadata: null, created_at: Math.floor(Date.now() / 1000) - 600, user_name: "Ada Lovelace" }],
  stats: { members: 3, pending: 2, shares_this_week: 4 },
};

/** Built-in names as the server stores them (lowercase); the app shows its own catalog names. */
const rolesResponse = {
  ok: true,
  roles: [
    { id: "role_owner", name: "owner", is_builtin: true, is_custom: false, permissions: {} },
    { id: "role_admin", name: "admin", is_builtin: true, is_custom: false, permissions: {} },
    { id: "role_member", name: "member", is_builtin: true, is_custom: false, permissions: {} },
    { id: "role_viewer", name: "viewer", is_builtin: true, is_custom: false, permissions: {} },
    { id: "role_cust", name: "Editors", is_builtin: false, is_custom: true, permissions: { upload_files: true, download_files: true } },
  ],
};

async function teamInTurkish(page: Page, team: unknown = teamResponse, status = 200): Promise<void> {
  await page.route("**/api/team?*", (r) => r.fulfill(json(team, status)));
  await page.route("**/api/roles?*", (r) => r.fulfill(json(rolesResponse)));
  await inTurkish(page, "/team", TEAM);
}

test.describe("Team page in Turkish", () => {
  test("member list, invites, activity and role guide; role change toast", async ({ appPage: page }) => {
    await teamInTurkish(page);
    const root = page.locator(TEAM);

    await expect(root.getByRole("heading", { name: "Ekip" })).toBeVisible();
    await expect(root).toContainText("Bu haftaki paylaşımlar");
    await expect(root).toContainText("Katılma tarihi");
    await expect(root).toContainText("(siz)");
    await expect(root).toContainText("Sahip");
    await expect(root).toContainText("Davet eden: Test User");
    await expect(root).toContainText("Rol rehberi");
    await expect(root).toContainText("2 izin");
    const picker = root.getByRole("combobox", { name: "Rol: Ada Lovelace" });
    await expect(picker).toBeVisible();
    await expect(picker.locator("option")).toHaveText(["Yönetici", "Üye", "Görüntüleyen", "Editors"]);
    expect(await leftoverEnglish(page, TEAM)).toEqual([]);

    await root.getByRole("combobox", { name: "Rol: Ada Lovelace" }).selectOption("role_admin");
    await expect(page.locator(TOASTS)).toContainText("Rol güncellendi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);

    await root.getByRole("button", { name: "Geçersiz kıl" }).first().click();
    await expect(page.locator(TOASTS)).toContainText("Davet geçersiz kılındı");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("invite dialog sends", async ({ appPage: page }) => {
    await page.route("**/api/team/invite", (r) => r.fulfill(json({ ok: true })));
    await teamInTurkish(page);
    const root = page.locator(TEAM);

    await root.getByRole("button", { name: "Davet et" }).click();
    await expect(root.getByRole("heading", { name: "Çalışma alanına davet" })).toBeVisible();
    await expect(root.getByPlaceholder("ekiparkadasi@example.com")).toBeVisible();
    await expect(root.getByRole("button", { name: "Davet gönder" })).toBeVisible();
    expect(await leftoverEnglish(page, TEAM)).toEqual([]);

    await root.getByPlaceholder("ekiparkadasi@example.com").fill("new@example.test");
    await root.getByRole("button", { name: "Davet gönder" }).click();
    await expect(page.locator(TOASTS)).toContainText("Davet gönderildi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("remove member dialog", async ({ appPage: page }) => {
    await page.route("**/api/team/members/*", (r) => r.fulfill(json({ ok: true })));
    await teamInTurkish(page);
    const root = page.locator(TEAM);

    await root.locator("tr", { hasText: "Ada Lovelace" }).locator("button").click();
    await expect(root.getByRole("heading", { name: "Üye kaldırılsın mı?" })).toBeVisible();
    await expect(root).toContainText("Ada Lovelace bu çalışma alanından kaldırılsın mı?");
    expect(await leftoverEnglish(page, TEAM)).toEqual([]);

    await root.getByRole("button", { name: "Kaldır", exact: true }).click();
    await expect(page.locator(TOASTS)).toContainText("Üye kaldırıldı");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("a roster the role may not see, and an empty one", async ({ appPage: page }) => {
    await teamInTurkish(page, { ok: false, error: "Forbidden" }, 403);
    const root = page.locator(TEAM);
    await expect(root).toContainText("Ekip üyeleri yüklenemedi. Rolünüz üyeleri görüntülemeye izin vermiyor olabilir.");
    await expect(root).toContainText("Yakın zamanda etkinlik yok");
    // "Forbidden" is the server's own error text, shown as sent.
    expect(await leftoverEnglish(page, TEAM, { allow: ["Forbidden"] })).toEqual([]);
  });

  test("an empty roster", async ({ appPage: page }) => {
    await teamInTurkish(page, { ...teamResponse, members: [], invites: [], activity: [], stats: { members: 0, pending: 0, shares_this_week: 0 } });
    const root = page.locator(TEAM);
    await expect(root).toContainText("Henüz üye yok. Erişim vermek için ekip arkadaşlarınızı e-posta ile davet edin.");
    expect(await leftoverEnglish(page, TEAM)).toEqual([]);
  });
});

/** Mock folder "Documents" in group grp_1 is user data that equals a catalog string. */
const GROUP_DATA = ["Documents"];

test.describe("Groups page in Turkish", () => {
  test("list, rename with the colour row", async ({ appPage: page }) => {
    await inTurkish(page, "/groups", GROUPS);
    const root = page.locator(GROUPS);

    await expect(root.getByRole("heading", { name: "Gruplar" })).toBeVisible();
    await expect(root).toContainText("2 öğe");
    await expect(root).toContainText("Bu grupta henüz hiçbir şey yok.");
    await expect(root.getByTitle("Gruptan kaldır").first()).toBeVisible();
    expect(await leftoverEnglish(page, GROUPS, { allow: GROUP_DATA })).toEqual([]);

    await page.getByTestId("group-grp_1-rename").click();
    await expect(page.getByTestId("group-grp_1-color-blue")).toHaveAttribute("aria-label", "Rengi ayarla: Mavi");
    expect(await leftoverEnglish(page, GROUPS, { allow: GROUP_DATA })).toEqual([]);
    await page.getByTestId("group-rename-input").fill("Clients");
    await page.getByTestId("group-rename-save").click();
    await expect(page.getByTestId("group-grp_1")).toContainText("Clients");
  });

  test("create dialog with the length rule, and delete", async ({ appPage: page }) => {
    await inTurkish(page, "/groups", GROUPS);
    const root = page.locator(GROUPS);

    await page.getByTestId("group-new").click();
    await expect(root.getByRole("heading", { name: "Yeni grup" })).toBeVisible();
    await expect(page.getByTestId("group-create-name")).toHaveAttribute("placeholder", "Ör. Müşteri işleri");
    await page.getByTestId("group-create-name").fill("x".repeat(101));
    await expect(page.getByTestId("group-create-error")).toHaveText("Ad, 100 karakterden kısa olmalı.");
    await expect(page.getByTestId("group-create-color-blue")).toHaveAttribute("aria-label", "Renk: Mavi");
    expect(await leftoverEnglish(page, GROUPS, { allow: GROUP_DATA })).toEqual([]);

    await page.getByTestId("group-create-name").fill("Invoices");
    await page.getByTestId("group-create-submit").click();
    await expect(page.locator(TOASTS)).toContainText("Grup oluşturuldu");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);

    await page.getByTestId("group-grp_2-delete").click();
    await expect(root.getByRole("heading", { name: "“Reading list” silinsin mi?" })).toBeVisible();
    await expect(root).toContainText("Grup silinir. İçindeki dosya ve klasörler oldukları yerde kalır.");
    expect(await leftoverEnglish(page, GROUPS, { allow: GROUP_DATA })).toEqual([]);
    await page.getByTestId("group-delete-confirm").click();
    await expect(page.locator(TOASTS)).toContainText("Grup silindi");
    await expect(page.locator(TOASTS)).toContainText("İçindeki dosya ve klasörlere dokunulmadı.");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("empty state", async ({ appPage: page }) => {
    await page.route("**/api/groups?*", (r) => r.fulfill(json({ ok: true, groups: [] })));
    await inTurkish(page, "/groups", GROUPS);
    const root = page.locator(GROUPS);

    await expect(root).toContainText("Henüz grup yok");
    await expect(root).toContainText("Sık kullandığınız öğeleri gruplayın.");
    expect(await leftoverEnglish(page, GROUPS)).toEqual([]);
  });

  test("error state", async ({ appPage: page }) => {
    // 403: the app's query client does not retry it, so the error shows at once.
    await page.route("**/api/groups?*", (r) => r.fulfill(json({ ok: false, error: "x" }, 403)));
    await inTurkish(page, "/groups", GROUPS);

    await expect(page.getByTestId("groups-error")).toContainText("Gruplarınız yüklenemedi.");
    await expect(page.getByTestId("groups-retry")).toHaveText("Yeniden dene");
    expect(await leftoverEnglish(page, GROUPS)).toEqual([]);
  });
});
