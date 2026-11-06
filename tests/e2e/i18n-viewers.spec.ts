import type { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The file viewers in Turkish: the viewer's own chrome (header, version
 * column, filmstrip) around an image, a PDF, a Live Photo and its video, an
 * audio file, an archive, a book, a vCard, office documents, and the text,
 * CSV and Markdown stages with the find bar. Each one is spot-checked for a
 * few Turkish strings (src/i18n/messages/tr.json), then swept for English the
 * catalog knows, scoped to the viewer.
 *
 * The audio, book, office and versioned files come from the shared mock (the
 * existing viewer specs use the same ones). The rest is stubbed here, shaped
 * like the real API: the shared mock serves every /raw as an MP3 and has no
 * archive index.
 *
 * The language is switched on /files before a viewer opens: the viewer is a
 * full-window overlay that covers the titlebar language menu.
 */

const VIEWER = '[data-testid="file-viewer"]';
const now = 1_741_000_000;

function row(id: string, name: string, mime: string, extra: Record<string, unknown> = {}) {
  return {
    id, name, size_bytes: 4_096, mime_type: mime, extension: name.split(".").pop(),
    region: "eu-west-1", created_at: now, updated_at: now, current_version: 1, lock_mode: "none",
    is_hidden: 0, hidden_mode: "none", uploaded_by: "user_test_1", uploader_name: "Test User",
    share_count: 0, comment_count: 0, is_synced: 0, origin: "desktop", folder_id: null, ...extra,
  };
}

const FILES = [
  row("f_still", "Harbour dusk.jpg", "image/jpeg", { live_video_id: "f_twin" }),
  row("f_twin", "Harbour dusk.mov", "video/quicktime", { live_photo_id: "f_still" }),
  row("f_zip", "Field kit.zip", "application/zip"),
  row("f_badzip", "Broken kit.zip", "application/zip"),
  row("f_vcf", "Crew.vcf", "text/vcard"),
  row("f_txt", "harbour-log.txt", "text/plain"),
  row("f_tsv", "tides.tsv", "text/tab-separated-values"),
  row("f_md", "harbour.md", "text/markdown"),
];

const ok = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const text = (body: string, contentType = "text/plain") => ({ status: 200, contentType, body });

async function stubApi(page: Page) {
  await page.route("**/api/files?*", (route) =>
    route.fulfill(ok({
      ok: true, folders: [], files: FILES, breadcrumbs: [],
      pagination: { page: 1, per_page: 100, total_files: FILES.length, total_pages: 1 },
      can_lock: true, can_hide: true, folder_view_only: false,
    })),
  );
  // A twin that cannot load: the video player shows its failure card, and the
  // Live Photo still's badge reports the video as unavailable.
  await page.route("**/api/files/f_twin/raw*", (route) => route.fulfill({ status: 404, body: "" }));
  await page.route("**/api/files/f_zip/archive", (route) =>
    route.fulfill(ok({
      kind: "zip", archiveSize: 90_000, totalEntries: 12_000, truncated: true,
      entries: [
        { i: 0, name: "maps/", size: 0, csize: 0, method: 0, dir: true, encrypted: false, mtime: null },
        { i: 1, name: "maps/harbour.txt", size: 40, csize: 30, method: 8, dir: false, encrypted: false, mtime: null },
        { i: 2, name: "secret.txt", size: 40, csize: 30, method: 8, dir: false, encrypted: true, mtime: null },
        { i: 3, name: "packed.bin", size: 40, csize: 30, method: 14, dir: false, encrypted: false, mtime: null },
        { i: 4, name: "readme.txt", size: 40, csize: 30, method: 0, dir: false, encrypted: false, mtime: null },
      ],
    })),
  );
  await page.route("**/api/files/f_zip/archive/entry*", (route) => route.fulfill(text("tide tables for the harbour")));
  await page.route("**/api/files/f_badzip/archive", (route) =>
    route.fulfill({ status: 413, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Index over the cap" }) }),
  );
  await page.route("**/api/files/f_vcf/raw*", (route) =>
    route.fulfill(text(
      [
        "BEGIN:VCARD", "VERSION:3.0", "FN:Ada Lovelace", "TEL;TYPE=CELL:+44 20 7946 0000", "TEL;TYPE=main:+44 20 7946 0001",
        "TEL;TYPE=constructor:+44 20 7946 0002", "EMAIL:ada@example.com", "END:VCARD",
        "BEGIN:VCARD", "VERSION:3.0", "FN:Grace Hopper", "EMAIL:grace@example.com", "END:VCARD",
      ].join("\r\n"),
      "text/vcard",
    )),
  );
  await page.route("**/api/files/f_txt/raw*", (route) => route.fulfill(text("tide at six\nwind from the west\n")));
  // .tsv, not .csv: a .csv is an office file and previews as a converted PDF.
  await page.route("**/api/files/f_tsv/raw*", (route) =>
    route.fulfill(text("fruit\tqty\napple\t3\npear\t4\n", "text/tab-separated-values")),
  );
  await page.route("**/api/files/f_md/raw*", (route) =>
    route.fulfill(text("# Harbour log\n\nTide at six.\n", "text/markdown")),
  );
}

/** Turkish first, then the viewer: the open viewer covers the language menu. */
async function openViewer(page: Page, id: string, { stub = true } = {}) {
  if (stub) await stubApi(page);
  await navigateTo(page, "/files");
  await switchLanguage(page, "tr");
  await navigateTo(page, `/files?view=${id}`);
  await expect(page.locator(VIEWER)).toBeVisible();
}

async function noEnglish(page: Page, root = VIEWER, allow: string[] = []) {
  expect(await leftoverEnglish(page, root, { allow })).toEqual([]);
}

// The shared mock's listing carries a folder row named "Documents" among its
// files, and the viewer's filmstrip titles each thumbnail with the row's name:
// user data that happens to equal a catalog string.
const MOCK_FOLDER = ["Documents"];

test.describe("File viewers in Turkish", () => {
  test("image: viewer header and filmstrip", async ({ appPage: page }) => {
    await openViewer(page, "file_2", { stub: false });
    const viewer = page.locator(VIEWER);
    await expect(viewer.locator('button[title="İndir"]')).toBeVisible();
    await expect(viewer.locator('button[title="Kapat (Esc)"]')).toBeVisible();
    await noEnglish(page, VIEWER, MOCK_FOLDER);
  });

  test("pdf with versions: version column, latest badge, frame title", async ({ appPage: page }) => {
    await openViewer(page, "file_v1", { stub: false });
    await expect(page.getByTestId("viewer-versions-toggle")).toHaveAttribute("title", "Sürümler (3)");
    await page.getByTestId("viewer-versions-toggle").click();
    const panel = page.getByTestId("viewer-versions-panel");
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Sürümler");
    await expect(panel.getByText("En yeni", { exact: true })).toBeVisible();
    await expect(page.getByTestId("viewer-versions-toggle")).toHaveAttribute("title", "Sürümleri gizle");
    await expect(page.locator('iframe[title="PDF: Versioned Report.pdf"]')).toBeAttached();
    await noEnglish(page, VIEWER, MOCK_FOLDER);
  });

  test("live photo: still with its badge, and the twin's way back", async ({ appPage: page }) => {
    await openViewer(page, "f_still");
    const stage = page.getByTestId("live-stage");
    await expect(stage).toBeVisible();
    await expect(stage.getByRole("button", { name: "Live Photo'yu oynat" })).toBeVisible();
    // "Canlı", shown in capitals by the badge's own CSS.
    await expect(stage.getByTestId("live-badge")).toHaveText("Canlı");
    await noEnglish(page);

    await navigateTo(page, "/files?view=f_twin");
    await expect(page.getByRole("button", { name: "Live Photo videosu: Harbour dusk.jpg" })).toBeVisible();
    // The video player's own failure card carries the app's sentence.
    await expect(page.getByText(/Bu video uygulamada çözümlenemiyor/)).toBeVisible({ timeout: 15_000 });
    await noEnglish(page, `${VIEWER} > div:first-child`);
    await noEnglish(page, `${VIEWER} button.font-mono`);
    // The whole viewer. The sweep cannot see inside the player: Video.js
    // marks its root translate="no". The vendored player takes only the
    // app's sentence (failureText, checked above); its own words ("Couldn't
    // load this video", "Download", "Report a problem", control titles) have
    // no option to replace them and stay English.
    await noEnglish(page);
  });

  test("audio: transport, modes, sleep menu and queue", async ({ appPage: page }) => {
    await openViewer(page, "file_audio", { stub: false });
    const viewer = page.locator(VIEWER);
    await expect(viewer.locator("h2", { hasText: "Midnight Ferry" })).toBeVisible({ timeout: 15_000 });
    await expect(viewer.getByRole("button", { name: "Kuyruğu karıştır" })).toBeVisible();
    await expect(viewer.getByRole("tab", { name: /Sıradakiler/ })).toBeVisible();
    await expect(viewer.locator('button[title="Oynatma hızı"]')).toBeVisible();
    await viewer.getByText("Uyku zamanlayıcısı", { exact: true }).click();
    await expect(viewer.getByText("Otomatik durdurma süresi")).toBeVisible();
    await expect(viewer.getByRole("button", { name: "5 dakika", exact: true })).toBeVisible();
    await noEnglish(page, VIEWER, MOCK_FOLDER);
  });

  test("archive: summary, filter, tree reasons, truncation and entry preview", async ({ appPage: page }) => {
    await openViewer(page, "f_zip");
    const viewer = page.locator(VIEWER);
    await expect(viewer.getByPlaceholder("Kayıtları filtrele")).toBeVisible();
    await expect(viewer.getByText("Önizlemek için bir dosya seçin.")).toBeVisible();
    await expect(viewer.getByTestId("archive-kind")).toHaveText("arşiv");
    await expect(viewer.getByTestId("archive-save-all")).toHaveText("Tümünü dosya.dev'e kaydet");
    await expect(viewer.getByTestId("archive-entry-2")).toHaveAttribute("title", "Bu kayıt için parola gerekiyor.");
    await noEnglish(page);

    await viewer.getByTestId("archive-entry-4").click();
    await expect(viewer.getByText("tide tables for the harbour")).toBeVisible();
    await expect(viewer.getByTestId("archive-save-entry")).toBeVisible();
    await noEnglish(page);
  });

  test("archive the server will not list", async ({ appPage: page }) => {
    await openViewer(page, "f_badzip");
    await expect(page.getByText("Bu arşiv listelenemeyecek kadar büyük.")).toBeVisible();
    // "Index over the cap" is the server's message, shown as sent.
    await noEnglish(page);
  });

  test("book: toolbar, bookmarks and search panels", async ({ appPage: page }) => {
    await openViewer(page, "file_book", { stub: false });
    const viewer = page.locator(VIEWER);
    await expect(page.getByTestId("book-viewer")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId("book-toc-toggle")).toHaveAttribute("title", "İçindekiler");
    await page.getByTestId("book-bookmarks-toggle").click();
    await expect(page.getByTestId("book-bookmarks-empty")).toHaveText(
      "Henüz yer imi yok. Bu sayfayı işaretlemek için yer imi simgesini kullanın.",
    );
    await noEnglish(page, VIEWER, MOCK_FOLDER);
    await page.getByTestId("book-search-toggle").click();
    await expect(viewer.getByPlaceholder("Bu kitapta ara")).toBeVisible();
    await noEnglish(page, VIEWER, MOCK_FOLDER);
  });

  test("book the reader library cannot open: its error in Turkish", async ({ appPage: page }) => {
    // Not a book at all: foliate-js's view.js throws "File type not supported".
    await page.route("**/api/files/file_book/raw*", (route) =>
      route.fulfill({ status: 200, contentType: "application/epub+zip", body: "this is not an epub" }),
    );
    await openViewer(page, "file_book", { stub: false });
    const err = page.getByTestId("book-error");
    await expect(err).toBeVisible({ timeout: 20_000 });
    await expect(err).toContainText("Dosya türü desteklenmiyor");
    await expect(err).not.toContainText("File type not supported");
    await noEnglish(page, VIEWER, MOCK_FOLDER);
  });

  test("book themes panel", async ({ appPage: page }) => {
    await openViewer(page, "file_book", { stub: false });
    await expect(page.getByTestId("book-viewer")).toBeVisible({ timeout: 20_000 });
    await page.getByTestId("book-themes-toggle").click();
    const themes = page.getByTestId("book-themes");
    await expect(themes.getByTestId("book-theme-app")).toHaveText("Uygulamayla aynı");
    await expect(themes.getByTestId("book-theme-sepia")).toContainText("Sepya");
    await noEnglish(page, VIEWER, MOCK_FOLDER);
  });

  test("vCard: contact list and card", async ({ appPage: page }) => {
    await openViewer(page, "f_vcf");
    const viewer = page.locator(VIEWER);
    // The phone's TYPE=CELL and the untyped email read as the app's own words.
    await expect(viewer.getByText("Mobil", { exact: true })).toBeVisible();
    await expect(viewer.getByText("Ana", { exact: true })).toBeVisible();
    // A type named after an Object property is the file's own word: shown, not a crash.
    await expect(viewer.getByText("constructor", { exact: true })).toBeVisible();
    await expect(viewer.getByPlaceholder("Kişilerde ara")).toBeVisible();
    await expect(viewer.locator('button[title="Kopyala"]').first()).toBeAttached();
    await viewer.getByPlaceholder("Kişilerde ara").fill("zzz");
    await expect(viewer.getByText("Sonuç yok", { exact: true })).toBeVisible();
    await noEnglish(page);
  });

  test("office: converted frame and the too-large note", async ({ appPage: page }) => {
    await openViewer(page, "file_docx", { stub: false });
    await expect(page.locator('iframe[title="Önizleme: report.docx"]')).toBeVisible();
    await noEnglish(page, VIEWER, MOCK_FOLDER);

    await navigateTo(page, "/files?view=file_huge");
    await expect(page.getByText("Bu dosya önizlenemeyecek kadar büyük. Dosyayı indirin.")).toBeVisible();
    await noEnglish(page, VIEWER, MOCK_FOLDER);
  });

  test("text: find bar", async ({ appPage: page }) => {
    await openViewer(page, "f_txt");
    const viewer = page.locator(VIEWER);
    await expect(viewer.getByText("wind from the west")).toBeVisible();
    await page.keyboard.press("ControlOrMeta+f");
    const find = viewer.getByPlaceholder("Bul");
    await expect(find).toBeVisible();
    await find.fill("zzz");
    await expect(viewer.getByText("Sonuç yok", { exact: true })).toBeVisible();
    await noEnglish(page);
  });

  test("table and markdown stages", async ({ appPage: page }) => {
    await openViewer(page, "f_tsv");
    const viewer = page.locator(VIEWER);
    await expect(viewer.getByText("2 satır × 2 sütun")).toBeVisible();
    await noEnglish(page);

    await navigateTo(page, "/files?view=f_md");
    await expect(viewer.getByRole("tab", { name: "Önizleme" })).toBeVisible();
    await expect(viewer.getByRole("tablist", { name: "Markdown görünümü" })).toBeVisible();
    await noEnglish(page);
  });
});
