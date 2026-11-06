import type { Page } from "@playwright/test";
import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The Profile page in Turkish, tab by tab: Identity (and the change-email
 * dialog's two steps), Appearance, Password & 2FA (off, on, the change
 * password dialog with its validator messages, authenticator setup, recovery
 * codes, disable and regenerate), API keys, Sessions, Notifications, Billing,
 * Family (payer with members and usage, a member action dialog, and the
 * member's Leave dialog), About (update states), Help & Contact and Delete
 * account (blocked, code step, scheduled). Each surface is spot-checked for a
 * few Turkish strings (src/i18n/messages/tr.json), then swept for English the
 * catalog knows, scoped to the page.
 */

const PAGE = "[data-testid=profile-page]";
const TOASTS = "[data-sonner-toaster]";

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function profileInTurkish(page: Page): Promise<void> {
  await navigateTo(page, "/profile");
  await switchLanguage(page, "tr");
  await expect(page.locator(PAGE)).toBeVisible();
}

async function openTab(page: Page, name: string): Promise<void> {
  await page.locator(PAGE).getByRole("button", { name, exact: true }).click();
}

const pool = { used_bytes: 300e9, limit_bytes: 2e12, used_label: "300 GB", limit_label: "2 TB" };
const payerFamily = {
  ok: true, role: "payer", limit: 6, included: 5, extra_places: 1, can_buy_places: true, over_capacity: false,
  eligible: true, ineligible_reason: null, pool, plan: { id: "pro", name: "Pro" }, payer: null,
  members: [
    { id: "fm_a", email: "ada@example.test", name: "Ada Lovelace", status: "active", joined_at: 1, expires_at: null, over_free: true },
    { id: "fm_b", email: "bo@example.test", name: null, status: "invited", joined_at: null, expires_at: 2_000_000_000 },
  ],
  usage: [
    { id: "u_me", name: "Test User", is_you: true, is_payer: true, used_bytes: 200e9, used_label: "200 GB" },
    { id: "u_a", name: "Ada Lovelace", is_you: false, is_payer: false, used_bytes: 100e9, used_label: "100 GB" },
  ],
};
const memberFamily = {
  ok: true, role: "member", limit: 5, eligible: false, ineligible_reason: "is_member", pool,
  plan: { id: "pro", name: "Pro" }, payer: { name: "Grace Hopper" }, members: null, own_used_bytes: 7e9, own_used_label: "7 GB",
};

/** Pushes an update status into the renderer as the updater would. */
async function sendUpdateStatus(page: Page, status: unknown): Promise<void> {
  await electronAppFor(page).evaluate(({ BrowserWindow }, s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("updater:status-changed", s);
  }, status);
}

test.describe("Profile page in Turkish", () => {
  test("Identity tab and the change-email dialog", async ({ appPage: page }) => {
    await page.route("**/api/me/email", (route) => route.fulfill(json({ ok: true })));
    await profileInTurkish(page);
    const root = page.locator(PAGE);

    await expect(root.getByRole("heading", { name: "Profil bilgileri" })).toBeVisible();
    await expect(root).toContainText("Ad soyad");
    await expect(root).toContainText("Üyelik başlangıcı:");
    await expect(root.getByRole("button", { name: "Değiştir" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await root.getByRole("button", { name: "Değiştir" }).click();
    await expect(root.getByRole("heading", { name: "E-posta değişikliği" })).toBeVisible();
    await expect(root).toContainText("Mevcut parola");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await root.locator('input[type="email"]').last().fill("new@example.test");
    await root.locator('input[type="password"]').fill("hunter2hunter2");
    await root.getByRole("button", { name: "Kod gönder" }).click();
    await expect(root.getByRole("heading", { name: "Yeni e-posta adresini doğrula" })).toBeVisible();
    await expect(root).toContainText("Şu adrese gönderilen 6 haneli kodu girin: new@example.test");
    await expect(page.locator(TOASTS)).toContainText("Doğrulama kodu yeni e-posta adresinize gönderildi");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("Appearance tab", async ({ appPage: page }) => {
    await profileInTurkish(page);
    await openTab(page, "Görünüm");
    const root = page.locator(PAGE);
    await expect(root.getByRole("heading", { name: "Görünüm" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Koyu" })).toBeVisible();
    await expect(root).toContainText("Varsayılan");
    await expect(root).toContainText("Tema");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("Password & 2FA tab: off, change password, authenticator setup and recovery codes", async ({ appPage: page }) => {
    let enabled = false;
    await page.route("**/api/me/2fa/status", (route) =>
      route.fulfill(json(enabled
        ? { ok: true, method: "totp", totp_enabled: true, recovery_codes_remaining: 8 }
        : { ok: true, method: null, totp_enabled: false, recovery_codes_remaining: 0 })));
    await page.route("**/api/me/2fa/setup-totp", (route) =>
      route.fulfill(json({ ok: true, secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/dosya:test?secret=JBSWY3DPEHPK3PXP" })));
    await page.route("**/api/me/2fa/verify-totp", (route) => {
      enabled = true;
      return route.fulfill(json({ ok: true, recovery_codes: ["aaaa-bbbb", "cccc-dddd"] }));
    });
    await profileInTurkish(page);
    await openTab(page, "Parola ve 2FA");
    const root = page.locator(PAGE);

    await expect(root.getByRole("heading", { name: "Parola ve 2FA" })).toBeVisible();
    await expect(root).toContainText("İki adımlı doğrulama etkin değil. Ek güvenlik için etkinleştirin.");
    await expect(root.getByRole("button", { name: "E-posta kullan" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // Change password, with the validator's and the mismatch messages showing.
    await root.getByRole("button", { name: "Parolayı değiştir" }).click();
    await expect(root.getByRole("heading", { name: "Parola değişikliği" })).toBeVisible();
    const pw = root.locator('input[type="password"]');
    await pw.nth(1).fill("short");
    await pw.nth(2).fill("different");
    await expect(root).toContainText("Yeni parola tekrarı");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await root.getByRole("button", { name: "İptal" }).click();

    // Authenticator setup, then the recovery codes.
    await root.getByRole("button", { name: "Kimlik doğrulama uygulamasını ayarla" }).click();
    await expect(root.getByRole("heading", { name: "Kimlik doğrulama uygulaması kurulumu" })).toBeVisible();
    await expect(root).toContainText("Taranmıyor mu? Anahtarı elle gir");
    await expect(root.getByAltText("Kimlik doğrulama uygulaması QR kodu")).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await root.locator('input[placeholder="000000"]').fill("123456");
    await root.getByRole("button", { name: "Doğrula ve etkinleştir" }).click();
    await expect(root.getByRole("heading", { name: "Kurtarma kodları" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Kodları kaydettim" })).toBeVisible();
    await root.getByRole("button", { name: "Tümünü kopyala" }).click();
    await expect(page.locator(TOASTS)).toContainText("Tümü panoda");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("Password & 2FA tab: on, disable and regenerate dialogs", async ({ appPage: page }) => {
    await page.route("**/api/me/2fa/status", (route) =>
      route.fulfill(json({ ok: true, method: "totp", totp_enabled: true, recovery_codes_remaining: 7 })));
    await profileInTurkish(page);
    await openTab(page, "Parola ve 2FA");
    const root = page.locator(PAGE);

    await expect(root).toContainText("Kimlik doğrulama uygulaması etkin");
    await expect(root).toContainText("7 kurtarma kodu kaldı");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await root.getByRole("button", { name: "2FA'yı kapat" }).click();
    await expect(root.getByRole("heading", { name: "2FA'yı kapat" })).toBeVisible();
    await expect(root).toContainText("İki adımlı doğrulamayı devre dışı bırakmak için parolanızı girin.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await root.getByRole("button", { name: "İptal" }).click();

    await root.getByRole("button", { name: "Kurtarma kodlarını yeniden oluştur" }).click();
    await expect(root.getByRole("button", { name: "Kodları yeniden oluştur" })).toBeVisible();
    await expect(root).toContainText("Bu işlem mevcut kodlarınızı geçersiz kılar.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("Change password shows the length rule in Turkish", async ({ appPage: page }) => {
    await page.route("**/api/me/2fa/status", (route) =>
      route.fulfill(json({ ok: true, method: null, totp_enabled: false, recovery_codes_remaining: 0 })));
    await profileInTurkish(page);
    await openTab(page, "Parola ve 2FA");
    const root = page.locator(PAGE);
    await root.getByRole("button", { name: "Parolayı değiştir" }).click();
    const pw = root.locator('input[type="password"]');
    await pw.nth(1).fill("short");
    await pw.nth(2).fill("different");
    // The shared validator's English sentences, never shown in Turkish.
    await expect(root).not.toContainText("Password must");
    await expect(root).not.toContainText("Passwords don't match");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("API keys, Billing and Help & Contact tabs", async ({ appPage: page }) => {
    await profileInTurkish(page);
    const root = page.locator(PAGE);

    await openTab(page, "API anahtarları");
    await expect(root.getByRole("heading", { name: "API anahtarı yönetimi" })).toBeVisible();
    await expect(root).toContainText("API anahtarlarını web uygulamasından oluşturun ve yönetin.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await openTab(page, "Faturalandırma");
    await expect(root.getByRole("heading", { name: "Abonelik yönetimi" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Faturalandırmayı tarayıcıda aç" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await openTab(page, "Yardım ve iletişim");
    await expect(root).toContainText("Yardım merkezi");
    await expect(root).toContainText("Ekibimizle iletişime geçin");
    await expect(root).toContainText("Hizmet Koşulları");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("Sessions tab and its revoke toasts", async ({ appPage: page }) => {
    await page.route("**/api/me/sessions**", (route) => {
      if (route.request().method() === "DELETE") return route.fulfill(json({ ok: true }));
      return route.fulfill(json({
        ok: true,
        sessions: [
          { id: "s1", device: "MacBook Pro", kind: "desktop", browser: "dosya 3.1.4", meta: "127.0.0.1", is_current: true, created_at: 1 },
          { id: "s2", device: "iPhone", kind: "mobile", browser: "Safari", meta: "10.0.0.2", is_current: false, created_at: 1 },
        ],
      }));
    });
    await profileInTurkish(page);
    await openTab(page, "Oturumlar");
    const root = page.locator(PAGE);

    await expect(root.getByRole("heading", { name: "Oturumlar" })).toBeVisible();
    await expect(root).toContainText("Bu oturum");
    await root.getByRole("button", { name: "Diğer tüm oturumları sonlandır" }).click();
    await expect(page.locator(TOASTS)).toContainText("Diğer tüm oturumlar sonlandırıldı");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("Notifications tab: app text in Turkish, server group text as sent", async ({ appPage: page }) => {
    // Turn one group into an always-on group so its badge shows.
    await page.route("**/api/me/notifications", async (route) => {
      if (route.request().method() !== "GET") return route.fulfill(json({ ok: true }));
      const body = await (await route.fetch()).json();
      body.groups[0].alwaysOn = "all";
      return route.fulfill(json(body));
    });
    await profileInTurkish(page);
    await openTab(page, "Bildirimler");
    const root = page.locator(PAGE);

    await expect(root.getByRole("heading", { name: "Bildirimler" })).toBeVisible();
    await expect(root).toContainText("Her zaman açık");
    await root.getByTestId("notif-group-product").getByRole("switch").click();
    await expect(page.locator(TOASTS)).toContainText("Tercihler kaydedildi");
    // Group labels and descriptions come from the server (stay as sent);
    // these are the ones that also exist as app strings in the catalog.
    expect(await leftoverEnglish(page, PAGE, { allow: ["Account", "Comments", "System", "Share links", "File requests"] })).toEqual([]);
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("Family tab: payer with members, usage, and a member action dialog", async ({ appPage: page }) => {
    await page.route("**/api/family", (route) => route.fulfill(json(payerFamily)));
    await page.route("**/api/family/invites", (route) => route.fulfill(json({ ok: true })));
    await profileInTurkish(page);
    await openTab(page, "Aile");
    const root = page.locator(PAGE);

    await expect(root.getByRole("heading", { name: "Aile planı" })).toBeVisible();
    await expect(root).toContainText("Ailenin ortak depolama alanı kullanımı: 300 GB / 2 TB.");
    await expect(root).toContainText("Kontenjan kullanımı: 2/6 (5 dahil, 1 ek).");
    await expect(root).toContainText("Davet edildi · son geçerlilik tarihi:");
    await expect(root.getByRole("button", { name: "Kontenjanı web üzerinden yönet" })).toBeVisible();
    await expect(root.getByPlaceholder("aile@example.com")).toBeVisible();
    await expect(root.getByRole("button", { name: "Daveti yeniden gönder: bo@example.test" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // Remove a member: the confirmation dialog.
    await root.getByRole("button", { name: "Üyeyi kaldır: Ada Lovelace" }).click();
    const dialog = root.getByRole("dialog");
    await expect(dialog).toContainText("“Ada Lovelace” aile planınızdan kaldırılsın mı?");
    await expect(dialog).toContainText("yüklemeleri duraklatılır");
    await expect(dialog.getByRole("button", { name: "Kalsın" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await dialog.getByRole("button", { name: "Kalsın" }).click();

    // Resend an invitation: dialog, then the toast.
    await root.getByRole("button", { name: "Daveti yeniden gönder: bo@example.test" }).click();
    await expect(root.getByRole("dialog")).toContainText("“bo@example.test” adresine davet yeniden gönderilsin mi?");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await root.getByRole("dialog").getByRole("button", { name: "Yeniden gönder" }).click();
    await expect(page.locator(TOASTS)).toContainText("Davet yeniden gönderildi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);

    // Usage tab.
    await root.getByRole("tab", { name: "Kullanım" }).click();
    await expect(root).toContainText("Siz");
    await expect(root).toContainText("· plan ücretini ödüyor");
    await expect(root).toContainText("Ortak depolama alanındaki boş kapasite");
    await expect(root.getByRole("img", { name: "Ailenin ortak depolama alanının kullanım oranı: %15" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("Family tab: a member and the Leave dialog", async ({ appPage: page }) => {
    await page.route("**/api/family", (route) => route.fulfill(json(memberFamily)));
    await profileInTurkish(page);
    await openTab(page, "Aile");
    const root = page.locator(PAGE);

    await expect(root).toContainText("Dahil olduğunuz plan: Pro. Plan ücretini ödeyen: Grace Hopper.");
    await expect(root).toContainText("Ayrılırsanız hesabınız 5 GB sunan ücretsiz plana döner.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await root.getByRole("button", { name: "Aile planından ayrıl" }).click();
    const dialog = root.getByRole("dialog");
    await expect(dialog).toContainText("Aile planından ayrılmak istiyor musunuz? Plan ücretini ödeyen: Grace Hopper");
    await expect(dialog).toContainText("Şu an depoladığınız veri: 7 GB.");
    await expect(dialog.getByRole("button", { name: "Ayrıl" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("Family tab: plan ended", async ({ appPage: page }) => {
    await page.route("**/api/family", (route) =>
      route.fulfill(json({ ...payerFamily, eligible: false, ineligible_reason: "free_plan" })));
    await profileInTurkish(page);
    await openTab(page, "Aile");
    const root = page.locator(PAGE);
    await expect(root).toContainText("Planınız sona erdiği için yeni kişi davet edemezsiniz.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("About tab and its update states", async ({ appPage: page }) => {
    await profileInTurkish(page);
    await openTab(page, "Hakkında");
    const root = page.locator(PAGE);

    await expect(root.getByRole("heading", { name: "Hakkında" })).toBeVisible();
    await expect(root).toContainText("Sürüm ");
    await expect(root).toContainText("dosya.dev masaüstü uygulaması");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await sendUpdateStatus(page, { state: "downloading", percent: 42 });
    await expect(root).toContainText("%42");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await sendUpdateStatus(page, { state: "not-available" });
    await expect(root).toContainText("En yeni sürümü kullanıyorsunuz");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await sendUpdateStatus(page, { state: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    await expect(root).toContainText("Güncelleme yapılamadı: net::ERR_INTERNET_DISCONNECTED");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await sendUpdateStatus(page, { state: "installing", version: "9.9.9" });
    await expect(root).toContainText("Kuruluyor…");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("Delete account tab: blocked, then the code step", async ({ appPage: page }) => {
    let blocked = true;
    await page.route("**/api/me/delete-preview", (route) =>
      route.fulfill(json({
        ok: true, window_days: 30, deletion_scheduled_for: null, file_count: 12,
        workspaces: [{ id: "ws_1" }, { id: "ws_2" }],
        blockers: blocked ? [{ workspace_id: "ws_2", workspace_name: "Studio", member_count: 3 }] : [],
      })));
    await page.route("**/api/me/delete-request", (route) => route.fulfill(json({ ok: true })));
    await profileInTurkish(page);
    await openTab(page, "Hesabı sil");
    const root = page.locator(PAGE);

    await expect(root.getByRole("heading", { name: "Kritik işlemler" })).toBeVisible();
    await expect(root).toContainText("Silme işlemi, iptal edebilmeniz için 30 gün sonrasına planlanır. 2 çalışma alanı ve 12 dosya silinir.");
    await expect(page.getByTestId("delete-blockers")).toContainText("“Studio” adlı çalışma alanında hâlâ 3 başka üye var.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    blocked = false;
    await openTab(page, "Yardım ve iletişim");
    await openTab(page, "Hesabı sil");
    await page.getByTestId("start-delete").click();
    await expect(page.getByTestId("delete-code-step")).toContainText("E-posta adresinize 6 haneli bir kod gönderdik.");
    await expect(page.getByTestId("resend-countdown")).toContainText("sn. sonra yeniden gönderilebilir");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("Delete account tab: a wrong code, then a scheduled deletion", async ({ appPage: page }) => {
    const when = Math.floor(Date.now() / 1000) + 20 * 86400 + 3600;
    let scheduled = false;
    await page.route("**/api/me/delete-preview", (route) =>
      route.fulfill(json({
        ok: true, window_days: 30, deletion_scheduled_for: scheduled ? when : null, file_count: 1,
        workspaces: [{ id: "ws_1" }], blockers: [],
      })));
    await page.route("**/api/me/delete-request", (route) => route.fulfill(json({ ok: true })));
    await page.route("**/api/me", async (route) => {
      if (route.request().method() !== "DELETE") return route.fallback();
      const code = JSON.parse(route.request().postData() ?? "{}").code;
      if (code !== "654321") return route.fulfill({ status: 400, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Invalid or expired code" }) });
      scheduled = true;
      return route.fulfill(json({ ok: true, deletion_scheduled_for: when }));
    });
    await profileInTurkish(page);
    await openTab(page, "Hesabı sil");
    const root = page.locator(PAGE);

    await expect(root).toContainText("1 çalışma alanı ve 1 dosya silinir.");
    await page.getByTestId("start-delete").click();
    await page.getByTestId("delete-code").fill("123456");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("delete-error")).toHaveText("Kod yanlış veya süresi doldu. 6 haneli kodu kontrol edin ya da yeni bir kod isteyin.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await page.getByTestId("delete-code").fill("654321");
    await page.getByTestId("confirm-delete").click();
    await expect(page.getByTestId("delete-scheduled")).toContainText("Silme işlemi planlandı");
    await expect(page.getByTestId("delete-scheduled")).toContainText("Hesabınız ve dosyalarınız 20 gün sonra silinecek.");
    await expect(page.getByTestId("cancel-deletion")).toHaveText("Silme işlemini iptal et");
    await expect(page.locator(TOASTS)).toContainText("Tüm oturumlarınızdan çıkış yapıldı.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });
});
