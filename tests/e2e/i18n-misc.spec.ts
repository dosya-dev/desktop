import fs from "fs";
import os from "os";
import path from "path";
import type { Page } from "@playwright/test";
import { test, guestTest, expect, navigateTo, electronAppFor } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The remaining surfaces in Turkish: the Report a problem dialog (signed in,
 * with its diagnostics card, the sent and failed toasts; and signed out), the
 * About window (rows, update states, Copy Details, Acknowledgements), the
 * Maintenance screen, and a helper's own error text (an upload whose bytes
 * fail, worded by lib/upload-in-parts.ts and lib/upload-transport.ts). Each
 * surface is spot-checked for a few Turkish strings
 * (src/i18n/messages/tr.json), then swept for English the catalog knows.
 *
 * The report dialog has one category (bug): there are no category options
 * to show.
 */

const DIALOG = "[role=dialog][aria-labelledby=report-problem-title]";
const TOASTS = "[data-sonner-toaster]";

// The diagnostics card's Page row shows the route as sent ("/files"), which
// happens to equal a catalog string.
const PAGE_ROUTE = ["/files"];

const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

/** Opens the report dialog the way Help > Report a problem does. */
async function openReport(page: Page): Promise<void> {
  await electronAppFor(page).evaluate(({ BrowserWindow }) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("report-problem:open");
  });
  await expect(page.locator(DIALOG)).toBeVisible();
}

async function sendUpdateStatus(page: Page, status: unknown): Promise<void> {
  await electronAppFor(page).evaluate(({ BrowserWindow }, s) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("updater:status-changed", s);
  }, status);
}

/** Clicks a menu item by label in whichever top-level menu holds it. */
async function clickMenuLabel(page: Page, label: string): Promise<void> {
  const found = await electronAppFor(page).evaluate(({ Menu }, l) => {
    for (const top of Menu.getApplicationMenu()?.items ?? []) {
      const item = top.submenu?.items.find((i) => i.label === l);
      if (item) { item.click(); return true; }
    }
    return false;
  }, label);
  expect(found, `menu item ${label} exists`).toBe(true);
}

test.describe("misc surfaces in Turkish", () => {
  test("Report a problem: the form, its diagnostics and the sent toast", async ({ appPage: page }) => {
    await page.route("**/api/support/tickets", (r) => r.fulfill(json({ ok: true, ticket: { id: "abcdef1234567890" } })));
    await navigateTo(page, "/files");
    await switchLanguage(page, "tr");
    await openReport(page);
    const dialog = page.locator(DIALOG);

    await expect(dialog.getByRole("heading", { name: "Hata bildirimi" })).toBeVisible();
    await expect(dialog).toContainText("Tarayıcıda takip edebileceğiniz bir destek talebi oluşturur.");
    await expect(dialog).toContainText("Son günlük kayıtlarını ekle (son 200 satır)");
    await expect(dialog).toContainText("Tanılama bilgileri");
    await expect(dialog).toContainText("Dosyalarınızdan hiçbir şey eklenmez.");
    await expect(dialog.getByPlaceholder("Nasıl bir sorun yaşadınız? Ne olmasını bekliyordunuz?")).toBeVisible();
    await expect(dialog.getByRole("textbox", { name: "Sorunun açıklaması" })).toBeVisible();
    // Diagnostics rows: labels and the sync summary.
    await expect(dialog.locator("dt", { hasText: "Uygulama" })).toBeVisible();
    await expect(dialog.locator("dt", { hasText: "Sayfa" })).toBeVisible();
    await expect(dialog.locator("dt", { hasText: "Senkronizasyon" })).toBeVisible();
    await expect(dialog.locator("dd", { hasText: "klasör yok" })).toBeVisible();
    expect(await leftoverEnglish(page, DIALOG, { allow: PAGE_ROUTE })).toEqual([]);

    await dialog.getByTestId("include-screenshot").uncheck();
    await dialog.getByRole("textbox").fill("Önizleme açılmıyor");
    await dialog.getByRole("button", { name: "Bildirimi gönder" }).click();
    const toasts = page.locator(TOASTS);
    await expect(toasts).toContainText("Bildirim gönderildi");
    await expect(toasts).toContainText("Teşekkürler. Hesabınızdaki e-posta adresine yanıt veririz. Talep: abcdef12.");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("Report a problem: the failed toast", async ({ appPage: page }) => {
    await page.route("**/api/support/tickets", (r) => r.fulfill(json({ ok: false, error: "Ticket service unavailable" }, 500)));
    await navigateTo(page, "/files");
    await switchLanguage(page, "tr");
    await openReport(page);
    const dialog = page.locator(DIALOG);
    await dialog.getByTestId("include-screenshot").uncheck();
    await dialog.getByRole("textbox").fill("Önizleme açılmıyor");
    await dialog.getByRole("button", { name: "Bildirimi gönder" }).click();
    const toasts = page.locator(TOASTS);
    await expect(toasts).toContainText("Bildirim gönderilemedi.");
    // The server's sentence, shown as sent.
    await expect(toasts).toContainText("Ticket service unavailable");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
    // The dialog stays open for another try.
    await expect(dialog.getByRole("button", { name: "Bildirimi gönder" })).toBeEnabled();
    expect(await leftoverEnglish(page, DIALOG, { allow: PAGE_ROUTE })).toEqual([]);
  });

  test("About window: rows, update states, Copy Details and Acknowledgements", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    const app = electronAppFor(page);
    const windowPromise = app.waitForEvent("window");
    await clickMenuLabel(page, "dosya.dev hakkında");
    const about = await windowPromise;
    await about.waitForLoadState("domcontentloaded");

    const { version } = JSON.parse(fs.readFileSync(path.join(__dirname, "../../package.json"), "utf8")) as { version: string };
    await expect(about.getByTestId("about-version")).toHaveText(`Sürüm ${version}`);
    await expect(about.getByText("Oturum açan hesap")).toBeVisible();
    await expect(about.getByText("Dağıtım kanalı")).toBeVisible();
    await expect(about.getByText("Doğrudan indirme")).toBeVisible();
    await expect(about.getByText("Uygulama motoru")).toBeVisible();
    await expect(about.getByText("Klasör yok")).toBeVisible();
    await expect(about.getByRole("link", { name: "Sürüm notları" })).toBeVisible();
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    const body = about.locator("body");
    await sendUpdateStatus(page, { state: "checking" });
    await expect(about.getByRole("button", { name: "Kontrol ediliyor…" })).toBeVisible();
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await sendUpdateStatus(page, { state: "downloading", percent: 42 });
    await expect(about.getByRole("button", { name: "İndiriliyor (%42)" })).toBeVisible();
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await sendUpdateStatus(page, { state: "available", version: "9.9.9" });
    await expect(body).toContainText("9.9.9 sürümü kullanılabilir");
    await expect(about.getByRole("button", { name: "Güncellemeleri denetle" })).toBeVisible();
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await sendUpdateStatus(page, { state: "ready", version: "9.9.9" });
    await expect(about.getByRole("button", { name: "Güncellemek için yeniden başlat" })).toBeVisible();
    await expect(body).toContainText("Kuruluma hazır sürüm: 9.9.9");
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await sendUpdateStatus(page, { state: "installing", version: "9.9.9" });
    await expect(body).toContainText("Sürüm kuruluyor: 9.9.9. dosya.dev birazdan yeniden açılacak.");
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await sendUpdateStatus(page, { state: "not-available" });
    await expect(body).toContainText("En yeni sürümü kullanıyorsunuz");
    await sendUpdateStatus(page, { state: "error", message: "net::ERR_INTERNET_DISCONNECTED" });
    await expect(body).toContainText("Güncellemeler denetlenemedi: net::ERR_INTERNET_DISCONNECTED");
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await about.getByRole("button", { name: "Ayrıntıları kopyala" }).click();
    await expect(about.getByRole("button", { name: "Kopyalandı" })).toBeVisible();
    // The copied details go to support, so they are English while the rows
    // on screen stay Turkish.
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    expect(copied).toContain(`dosya ${version} (Direct download)`);
    expect(copied).toContain("Channel: Direct download");
    expect(copied).toContain("Signed in as: ");
    expect(copied).toContain("Sync: No folders");
    expect(copied).not.toMatch(/Dağıtım|Oturum|Klasör yok|dosya\.dev /);
    await expect(about.getByText("Dağıtım kanalı")).toBeVisible();
    await expect(about.getByText("Klasör yok")).toBeVisible();
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await about.getByRole("button", { name: "Açık kaynak bildirimleri" }).click();
    await expect(about.getByText("dosya.dev bu açık kaynak paketleriyle geliştirildi. Lisansını okumak için bir paket seçin.")).toBeVisible();
    await expect(about.getByRole("button", { name: "Geri" })).toBeVisible();
    expect(await leftoverEnglish(about, "body")).toEqual([]);

    await about.keyboard.press("Escape").catch(() => {});
  });

  test("Maintenance screen", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");
    await page.route("**/api/me", (r) =>
      r.fulfill(json({ ok: false, code: "surface_disabled", surface: "desktop", message: "Back at 14:00 UTC." }, 503)));
    await page.reload();
    const root = page.getByTestId("maintenance-screen");
    await expect(root).toBeVisible({ timeout: 15_000 });

    await expect(root.getByRole("heading", { name: "Masaüstü uygulaması bakımda" })).toBeVisible();
    await expect(root).toContainText("Senkronizasyon duraklatıldı ve yerel dosyalarınıza dokunulmadı.");
    await expect(root).toContainText("Ekipten");
    await expect(root).toContainText("Sonraki kontrole");
    await expect(root.getByRole("button", { name: "Şimdi kontrol et" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Durum sayfası" })).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=maintenance-screen]")).toEqual([]);
  });

  test("an upload's own failure text (helpers)", async ({ appPage: page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-i18n-misc-"));
    const folder = path.join(dir, "Batch");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "refused.txt"), "refused");
    fs.writeFileSync(path.join(folder, "dropped.txt"), "dropped");

    // Both inits succeed; refused.txt's bytes are answered 500 with no
    // sentence (the helper's own fallback shows), dropped.txt's connection
    // is cut (the transport's network error shows).
    await page.route("**/api/upload/init", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      const session = body.file_name === "refused.txt" ? "sess_refused" : "sess_dropped";
      return route.fulfill(json({ ok: true, session_id: session }));
    });
    await page.route("**/api/upload/sess_refused*", (r) => r.fulfill(json({}, 500)));
    await page.route("**/api/upload/sess_dropped*", (r) => r.abort("connectionreset"));

    await navigateTo(page, "/upload");
    await switchLanguage(page, "tr");
    await page.getByTestId("upload-folder-input").setInputFiles(folder);

    const root = page.getByTestId("upload-page");
    await expect(root).toContainText("Dosya yüklenemedi. (500)", { timeout: 15_000 });
    await expect(root).toContainText("Ağ hatası oluştu.", { timeout: 15_000 });
    expect(await leftoverEnglish(page, "[data-testid=upload-page]")).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

test.describe("a helper's failure in Turkish (archive save)", () => {
  test("saving an archive folder whose folder cannot be created", async ({ appPage: page }) => {
    const zip = {
      id: "f_zip", name: "Field kit.zip", size_bytes: 4_096, mime_type: "application/zip", extension: "zip",
      region: "eu-west-1", created_at: 1_741_000_000, updated_at: 1_741_000_000, current_version: 1, lock_mode: "none",
      is_hidden: 0, hidden_mode: "none", uploaded_by: "user_test_1", uploader_name: "Test User",
      share_count: 0, comment_count: 0, is_synced: 0, origin: "desktop", folder_id: null,
    };
    await page.route("**/api/files?*", (r) =>
      r.fulfill(json({
        ok: true, folders: [], files: [zip], breadcrumbs: [],
        pagination: { page: 1, per_page: 100, total_files: 1, total_pages: 1 },
        can_lock: true, can_hide: true, folder_view_only: false,
      })));
    await page.route("**/api/files/f_zip/archive", (r) =>
      r.fulfill(json({
        kind: "zip", archiveSize: 90_000, totalEntries: 1, truncated: false,
        entries: [{ i: 0, name: "readme.txt", size: 40, csize: 30, method: 0, dir: false, encrypted: false, mtime: null }],
      })));
    // The server answers but creates nothing: lib/archive-save.ts's own
    // "Folder could not be created", translated where the toast shows it.
    await page.route("**/api/folders/batch", (r) => r.fulfill(json({ ok: true, folders: [] })));

    await navigateTo(page, "/files");
    await switchLanguage(page, "tr");
    await navigateTo(page, "/files?view=f_zip");
    await page.getByTestId("archive-save-all").click();
    await page.getByRole("button", { name: "Buraya kaydet" }).click();

    const toasts = page.locator(TOASTS);
    await expect(toasts).toContainText("Field kit: Klasör oluşturulamadı.");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });
});

guestTest.describe("misc surfaces in Turkish (signed out)", () => {
  guestTest("Report a problem asks to sign in first", async ({ appPage: page }) => {
    // Signed out there is no titlebar language menu: set it the way the
    // signed-out specs do, then reload.
    await page.evaluate(() => window.electronAPI.setLocale("tr"));
    await page.reload();
    await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe("tr");
    await openReport(page);
    const dialog = page.locator(DIALOG);
    await expect(dialog.getByRole("heading", { name: "Hata bildirimi" })).toBeVisible();
    await expect(dialog).toContainText("Önce oturum açın");
    await expect(dialog.getByRole("button", { name: "Kapat" }).first()).toBeVisible();
    expect(await leftoverEnglish(page, DIALOG)).toEqual([]);
  });
});
