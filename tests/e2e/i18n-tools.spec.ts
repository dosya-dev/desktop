import fs from "fs";
import os from "os";
import path from "path";
import type { Page } from "@playwright/test";
import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The tool pages in Turkish: Upload (empty, then a folder queue with a done,
 * a failed and a still-running file, plus its folder picker and new-folder
 * dialog), LAN Transfer (idle, hosting, and a connected session that is
 * sending and has received a file), Duplicates (groups, scanning note and the
 * delete confirmation), Search (empty prompt, results in every section, no
 * results), Map (chip, filters, empty and approximate-only states) and the
 * Editor page chrome (loading, read-only, error). Each surface is
 * spot-checked for a few Turkish strings (src/i18n/messages/tr.json), then
 * swept for English the catalog knows, scoped to the page.
 *
 * The editor page has no app shell (so no language menu): the language is
 * switched on the dashboard first, then the editor is opened.
 */

const TOASTS = "[data-sonner-toaster]";

// MapLibre's canvas aria-label, set from the catalog through MapLibre's
// locale option (and kept up to date on a switch). Its control titles have
// no catalog entry and stay MapLibre's English.
const MAP_CANVAS = "[data-testid=map-page] canvas.maplibregl-canvas";

async function inTurkish(page: Page, route: string): Promise<void> {
  await navigateTo(page, route);
  await switchLanguage(page, "tr");
}

test.describe("tool pages in Turkish", () => {
  test("Upload page: empty state, folder picker and new folder dialog", async ({ appPage: page }) => {
    await inTurkish(page, "/upload");
    const root = page.getByTestId("upload-page");

    await expect(root.getByRole("heading", { name: "Dosya yükle" })).toBeVisible();
    await expect(root).toContainText("Yüklemek için dosyaları veya klasörleri buraya bırakın");
    await expect(root).toContainText("Kök (en üst düzey)");
    await expect(root).toContainText("Güvenli yükleme");
    expect(await leftoverEnglish(page, "[data-testid=upload-page]")).toEqual([]);

    // The folder picker.
    await root.getByRole("button", { name: "Kök (en üst düzey)" }).click();
    await expect(root.getByRole("heading", { name: "Klasör seçimi" })).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=upload-page]")).toEqual([]);
    await root.getByRole("button", { name: "İptal" }).click();

    // The new folder dialog.
    await root.getByRole("button", { name: "Yeni klasör oluştur" }).click();
    await expect(root.getByPlaceholder("Klasör adı")).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=upload-page]")).toEqual([]);
  });

  test("Upload page: a folder queue with a failed and a running file", async ({ appPage: page }) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dosya-i18n-upload-"));
    const folder = path.join(dir, "Holiday");
    fs.mkdirSync(folder);
    fs.writeFileSync(path.join(folder, "done.txt"), "done");
    fs.writeFileSync(path.join(folder, "broken.txt"), "broken");
    fs.writeFileSync(path.join(folder, "slow.txt"), "slow");

    // broken.txt is refused by the server; slow.txt's bytes never finish.
    await page.route("**/api/upload/init", async (route) => {
      const body = JSON.parse(route.request().postData() ?? "{}");
      if (body.file_name === "broken.txt") {
        // Server text, shown as sent.
        return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ ok: false, error: "Upload refused by the storage quota service" }) });
      }
      const session = body.file_name === "slow.txt" ? "sess_slow" : "sess_ok";
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, session_id: session }) });
    });
    await page.route("**/api/upload/sess_slow*", () => { /* held: stays uploading */ });

    await inTurkish(page, "/upload");
    await page.getByTestId("upload-folder-input").setInputFiles(folder);

    const root = page.getByTestId("upload-page");
    await expect(root).toContainText("Upload refused by the storage quota service", { timeout: 15_000 });
    await expect(root.getByRole("heading", { name: "Yükleniyor" })).toBeVisible();
    await expect(root).toContainText("1/3 dosya");
    await expect(root).toContainText("1 dosya yüklenemedi");
    await expect(root.getByRole("button", { name: "Tümünü iptal et" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Tamamlananları temizle" })).toBeVisible();
    await expect(root.locator('[title="Bu klasörde yüklenemeyenleri yeniden dene"]')).toHaveCount(1);
    await expect(page.locator(TOASTS)).toContainText("Klasör yükleniyor");

    expect(await leftoverEnglish(page, "[data-testid=upload-page]")).toEqual([]);
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);

    fs.rmSync(dir, { recursive: true, force: true });
  });

  test("LAN Transfer: idle and hosting", async ({ appPage: page }) => {
    await inTurkish(page, "/lan-transfer");
    const root = page.getByTestId("lan-transfer-page");

    await expect(root.getByRole("heading", { name: "LAN aktarımı" })).toBeVisible();
    await expect(root).toContainText("Oda oluşturma");
    await expect(root).toContainText("2. Diğer cihaz bu kodla katılır");
    await expect(root.getByPlaceholder("6 haneli kod")).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=lan-transfer-page]")).toEqual([]);

    await root.getByText("Oda oluşturma").click();
    await expect(root.locator(".font-mono.text-4xl")).toHaveText("482917", { timeout: 10_000 });
    await expect(root).toContainText("Bu kodu diğer cihazla paylaşın");
    await expect(root).toContainText("Diğer cihazın katılması bekleniyor…");
    await expect(root.getByRole("button", { name: "Kodu kopyala" })).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=lan-transfer-page]")).toEqual([]);
  });

  test("LAN Transfer: a connected session sending and receiving", async ({ appPage: page }) => {
    // The save side of a received file, staged in main: no dialog, a fixed path.
    await electronAppFor(page).evaluate(({ ipcMain }) => {
      for (const ch of ["lan:recv-open", "lan:recv-chunk", "lan:recv-close", "lan:recv-abort"]) ipcMain.removeHandler(ch);
      ipcMain.handle("lan:recv-open", () => ({ ok: true, id: "sink_1" }));
      ipcMain.handle("lan:recv-chunk", () => ({ ok: true }));
      ipcMain.handle("lan:recv-close", () => ({ path: "/Users/test/Downloads/minutes.pdf" }));
      ipcMain.handle("lan:recv-abort", () => ({ ok: true }));
    });
    await inTurkish(page, "/lan-transfer");

    // A peer connection whose channel opens at once and never drains, so a
    // send stays on screen; the test drives what the channel receives.
    await page.evaluate(() => {
      const channel: any = {
        readyState: "open", bufferedAmount: 64 * 1024 * 1024, bufferedAmountLowThreshold: 0, binaryType: "arraybuffer",
        send() {}, close() {}, addEventListener() {}, removeEventListener() {},
      };
      (window as any).__lanChannel = channel;
      class FakePeer {
        connectionState = "new";
        onicecandidate: unknown = null;
        onconnectionstatechange: unknown = null;
        ondatachannel: ((e: { channel: unknown }) => void) | null = null;
        constructor() {
          setTimeout(() => {
            this.ondatachannel?.({ channel });
            setTimeout(() => channel.onopen?.(), 50);
          }, 50);
        }
        createDataChannel() { return channel; }
        async createOffer() { return { type: "offer", sdp: "" }; }
        async createAnswer() { return { type: "answer", sdp: "" }; }
        async setLocalDescription() {}
        async setRemoteDescription() {}
        async addIceCandidate() {}
        close() {}
      }
      (window as any).RTCPeerConnection = FakePeer;
    });

    const root = page.getByTestId("lan-transfer-page");
    await root.getByPlaceholder("6 haneli kod").fill("482917");
    await root.getByRole("button", { name: "Katıl" }).click();
    await expect(root).toContainText("Cihaz bağlandı", { timeout: 10_000 });
    await expect(root).toContainText("Göndermek için dosyaları bırakın");

    // A file arrives.
    await page.evaluate(async () => {
      const ch = (window as any).__lanChannel;
      ch.onmessage({ data: JSON.stringify({ v: 1, t: "file-start", id: "r1", name: "minutes.pdf", size: 3 }) });
      await new Promise((r) => setTimeout(r, 50));
      ch.onmessage({ data: new Uint8Array([1, 2, 3]).buffer });
      await new Promise((r) => setTimeout(r, 50));
      ch.onmessage({ data: JSON.stringify({ v: 1, t: "file-end", id: "r1" }) });
    });
    await expect(root).toContainText("Alınanlar");
    await expect(page.locator(TOASTS)).toContainText("“minutes.pdf” alındı");

    // A send that stays in flight.
    await root.locator('input[type="file"]').setInputFiles({ name: "agenda.txt", mimeType: "text/plain", buffer: Buffer.from("x".repeat(2048)) });
    await expect(root).toContainText("agenda.txt");
    await expect(root).toContainText(" / ");
    await expect(root.getByRole("button", { name: "Bağlantıyı kes" })).toBeVisible();

    expect(await leftoverEnglish(page, "[data-testid=lan-transfer-page]")).toEqual([]);
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("Duplicates page with groups and the delete confirmation", async ({ appPage: page }) => {
    // The API sends folder_path null for a file at the root (the page then
    // says "Workspace root" itself); the mock spells it out, so put it back.
    await page.route("**/api/duplicates?*", async (route) => {
      const body = await (await route.fetch()).json();
      for (const g of body.groups) for (const f of g.files) if (f.folder_path === "Workspace root") f.folder_path = null;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await inTurkish(page, "/duplicates");
    const root = page.getByTestId("duplicates-page");
    await expect(page.getByTestId("dup-group-hash_a")).toBeVisible();

    await expect(root.getByRole("heading", { name: "Yinelenen dosyalar" })).toBeVisible();
    await expect(page.getByTestId("dup-summary")).toContainText("2 yinelenen dosya grubu");
    await expect(page.getByTestId("dup-group-hash_a")).toContainText("3 kopya");
    await expect(root).toContainText("en yeni");
    await expect(root).toContainText("Çalışma alanı kökü");
    // "Documents" is a folder path from the mock (user data).
    expect(await leftoverEnglish(page, "[data-testid=duplicates-page]", { allow: ["Documents"] })).toEqual([]);

    await page.getByTestId("dup-check-dupfile_4").check();
    await page.getByTestId("dup-check-dupfile_5").check();
    await expect(page.getByTestId("dup-delete")).toHaveText("Sil (2)");
    await expect(page.getByTestId("dup-summary")).toContainText("Seçilen:");
    await page.getByTestId("dup-delete").click();
    await expect(root).toContainText("2 dosya çöp kutusuna taşınsın mı?");
    await expect(page.getByTestId("dup-full-group-warning")).toContainText("1 grupta tüm kopyalar seçili.");
    expect(await leftoverEnglish(page, "[data-testid=duplicates-page]", { allow: ["Documents"] })).toEqual([]);
  });

  test("Duplicates page while scanning, empty", async ({ appPage: page }) => {
    await page.route("**/api/duplicates?*", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, groups: [], total_groups: 0, total_wasted_bytes: 0, scanning: { pending: 7 } }),
      }),
    );
    await inTurkish(page, "/duplicates");
    const root = page.getByTestId("duplicates-page");
    await expect(page.getByTestId("dup-scanning")).toContainText("7 dosya hâlâ taranıyor.");
    await expect(page.getByTestId("dup-empty")).toContainText("Yinelenen dosya yok");
    expect(await leftoverEnglish(page, "[data-testid=duplicates-page]")).toEqual([]);
    await expect(root).toBeVisible();
  });

  test("Search page: prompt, results in every section, no results", async ({ appPage: page }) => {
    const now = Math.floor(Date.now() / 1000);
    await page.route("**/api/search?*", (route) => {
      const q = new URL(route.request().url()).searchParams.get("q");
      const empty = { ok: true, query: q, files: [], folders: [], shared: [], file_requests: [] };
      if (q !== "harbour") return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(empty) });
      const link = (id: string, status: string) => ({
        link_id: id, token: `t_${id}`, file_name: `harbour-${status}.jpg`, size_bytes: 2048, extension: ".jpg",
        region: "eu", sharer_name: "Dana Owner", status, shared_at: now,
      });
      return route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ...empty,
          files: [{ id: "f1", name: "harbour.jpg", size_bytes: 4096, mime_type: "image/jpeg", extension: ".jpg", region: "eu", folder_id: null, uploader_name: "Dana Owner", created_at: now - 3600 }],
          folders: [{ id: "d1", name: "harbour trip", parent_id: null, created_at: now - 7200, file_count: 4 }],
          shared: [link("s1", "active"), link("s2", "expiring"), link("s3", "expired"), link("s4", "revoked")],
          file_requests: [{ id: "r1", title: "harbour photos", message: null, created_by_name: "Dana Owner", created_at: now - 600 }],
        }),
      });
    });

    await inTurkish(page, "/search");
    const root = page.getByTestId("search-page");
    await expect(root).toContainText("Dosyalarda, klasörlerde, paylaşımlarda ve dosya isteklerinde arama yapın");
    await expect(root.getByPlaceholder("Dosya, klasör ve paylaşım arayın…")).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=search-page]")).toEqual([]);

    await root.getByPlaceholder("Dosya, klasör ve paylaşım arayın…").fill("harbour");
    await expect(root).toContainText("“harbour” için 7 sonuç");
    await expect(root).toContainText("Paylaşım bağlantıları");
    await expect(root).toContainText("Yükleyen: Dana Owner");
    await expect(root).toContainText("· Paylaşan: Dana Owner");
    await expect(root).toContainText("Oluşturan: Dana Owner");
    await expect(root).toContainText("4 dosya");
    await expect(root).toContainText("Süresi dolmak üzere");
    await expect(root.getByRole("button", { name: /İstekler/ })).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=search-page]")).toEqual([]);

    await root.getByPlaceholder("Dosya, klasör ve paylaşım arayın…").fill("nothing");
    await expect(root).toContainText("“nothing” için sonuç yok");
    expect(await leftoverEnglish(page, "[data-testid=search-page]")).toEqual([]);
  });

  test("Map page with the filter panel", async ({ appPage: page }) => {
    await page.route("**/api/map/pins?*", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          pins: [{ kind: "folder", id: "folder_1", name: "Trip", latitude: 40.7, longitude: -74, source: "ip" }],
          counts: { gps: 2, approximate: 1, pending: 4 },
        }),
      }),
    );
    await inTurkish(page, "/map");
    const root = page.getByTestId("map-page");

    await expect(root).toContainText("Konumu belirlenen: 2");
    await expect(root).toContainText("1 yaklaşık konum");
    await expect(root).toContainText("4 taranıyor…");
    await expect(root).toContainText("Yaklaşık konumları göster");
    await expect(root).toContainText("Harita arka planı şu anda kullanılamıyor.");
    await expect(page.getByTestId("map-filter-folder").locator("option").first()).toHaveText("Tüm klasörler");
    await page.getByTestId("map-filter-from").fill("2025-01-01");
    await expect(page.getByTestId("map-filter-clear")).toHaveText("Temizle");
    await expect(root).toContainText("Başlangıç");

    // Approximate pins hidden: nothing left to show.
    await root.getByRole("button", { name: "Yaklaşık konumları göster" }).click();
    await expect(root).toContainText("Gösterilecek işaretçi yok");
    // Switched after the map was built: the canvas and control labels follow.
    await expect(page.locator(MAP_CANVAS)).toHaveAttribute("aria-label", "Harita");
    await expect(page.locator(".maplibregl-ctrl-zoom-in")).toHaveAttribute("title", "Yakınlaştır");
    await expect(page.locator(".maplibregl-ctrl-zoom-out")).toHaveAttribute("aria-label", "Uzaklaştır");
    expect(await leftoverEnglish(page, "[data-testid=map-page]")).toEqual([]);
  });

  test("Map markers created after a switch are labelled in Turkish", async ({ appPage: page }) => {
    await page.route("**/api/map/pins?*", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({
          ok: true,
          pins: [
            { kind: "folder", id: "folder_ny", name: "New York", latitude: 40.7, longitude: -74, source: "gps" },
            { kind: "folder", id: "folder_la", name: "Los Angeles", latitude: 34.05, longitude: -118.24, source: "gps" },
          ],
          counts: { gps: 2, approximate: 0, pending: 0 },
        }),
      }),
    );
    // Built in English, then switched: the markers below are made afterwards.
    await navigateTo(page, "/map");
    const markers = page.locator("[data-testid=map-page] .maplibregl-marker");
    await expect(markers).toHaveCount(2);
    await switchLanguage(page, "tr");
    // Zoom in until both pins leave the view (their markers are removed), then
    // back out so moveend builds new ones.
    const zoomIn = page.locator(".maplibregl-ctrl-zoom-in");
    const zoomOut = page.locator(".maplibregl-ctrl-zoom-out");
    for (let i = 0; i < 4; i++) { await zoomIn.click(); await page.waitForTimeout(400); }
    await expect(markers).toHaveCount(0);
    for (let i = 0; i < 4; i++) { await zoomOut.click(); await page.waitForTimeout(400); }
    await expect(markers).toHaveCount(2);
    for (const m of await markers.all()) await expect(m).toHaveAttribute("aria-label", "Harita işaretçisi");
    expect(await leftoverEnglish(page, "[data-testid=map-page]")).toEqual([]);
  });

  test("Map page with nothing located", async ({ appPage: page }) => {
    await page.route("**/api/map/pins?*", (route) =>
      route.fulfill({
        status: 200, contentType: "application/json",
        body: JSON.stringify({ ok: true, pins: [], counts: { gps: 0, approximate: 0, pending: 0 } }),
      }),
    );
    // Turkish before the map is built: MapLibre gets the label at construction.
    await switchLanguage(page, "tr");
    await navigateTo(page, "/map");
    await expect(page.getByTestId("map-empty")).toContainText("Henüz konum etiketli fotoğraf yok");
    await expect(page.getByTestId("map-empty")).toContainText("Dosyalara git");
    await expect(page.locator(MAP_CANVAS)).toHaveAttribute("aria-label", "Harita");
    await expect(page.locator(".maplibregl-ctrl-zoom-in")).toHaveAttribute("title", "Yakınlaştır");
    expect(await leftoverEnglish(page, "[data-testid=map-page]")).toEqual([]);
  });

  test("Editor page chrome: loading, read-only, error", async ({ appPage: page }) => {
    await switchLanguage(page, "tr");

    // Loading: the config never answers.
    await page.route("**/api/files/file_hold/editor-config", () => { /* held */ });
    await navigateTo(page, "/editor/file_hold");
    const root = page.getByTestId("editor-page");
    await expect(root).toContainText("Düzenleyici yükleniyor…");
    await expect(root.getByRole("link", { name: /Dosyalar/ })).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=editor-page]")).toEqual([]);

    // Read-only, with a document server that cannot be reached.
    await page.route("**/api/files/file_view/editor-config", async (route) => {
      const res = await route.fetch({ url: route.request().url().replace("file_view", "file_5") });
      const body = await res.json();
      body.config.editorConfig.mode = "view";
      body.documentServerUrl = `${body.documentServerUrl}/missing`;
      return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    await navigateTo(page, "/editor/file_view");
    await expect(root).toContainText("Salt okunur");
    await expect(root).toContainText("Belge düzenleyicisi yüklenemedi.", { timeout: 15_000 });
    await expect(root.getByRole("button", { name: "Yeniden dene" })).toBeVisible();
    expect(await leftoverEnglish(page, "[data-testid=editor-page]")).toEqual([]);
  });
});
