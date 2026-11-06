import type { Page } from "@playwright/test";
import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The Sync page in Turkish: the folder list with pairs in every state, the
 * transfer and scan banners, the held-deletion banner, the failed-files list,
 * the Issues tab (permission, error, notices, the paged conflict list and its
 * bulk bar), the Activity tab, the Settings tab with snooze, the How sync
 * works sheet and the three steps of Add sync folder. Each surface is
 * spot-checked for a few Turkish strings (src/i18n/messages/tr.json), then
 * swept for English the catalog knows, scoped to the page.
 *
 * The engine's state is staged in the main process: `sync:get-status` and
 * `sync:list-conflicts` answer with a fixed snapshot, and every
 * `sync:status-changed` broadcast carries that snapshot, so a real engine
 * tick cannot replace it mid-test.
 *
 * Text the sync engine writes (pair errors, notices, file errors, activity
 * lines, live status) stays English in the engine and is translated where it
 * is shown, when the catalog knows it; anything else shows as sent. A root
 * pair's stored default name "Root" shows in the chosen language.
 */

const WS = "ws_test_1";
const PAGE = "[data-testid=sync-page]";

// Engine text: the pair error the engine stores on a dead session.
const ENGINE_SESSION_EXPIRED = "Session expired. Please log in again.";
const TR_SESSION_EXPIRED = "Oturum süresi doldu. Yeniden oturum açın.";
// Engine text: the pair error the engine stores on a dropped macOS grant.
const ENGINE_NEEDS_PERMISSION = "macOS needs permission to this folder again. Reselect it to restore sync.";
// Engine text: a live phase line the engine writes while syncing.
const ENGINE_SCANNING = "Scanning for changes...";
const TR_SCANNING = "Değişiklikler taranıyor…";
// Engine text with an argument: the folder path passes through untouched.
const ENGINE_NOT_FOUND = "Sync folder not found: /Users/test/Gone";
const TR_NOT_FOUND = "Senkronizasyon klasörü bulunamadı: /Users/test/Gone";

function pair(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    pairId: id, workspaceId: WS, workspaceName: "Test Workspace", remoteFolderName: name,
    localPath: `/Users/test/${name}`, syncMode: "push-safe", status: "idle",
    lastSyncedAt: Date.now() - 5 * 60_000, errorMessage: null, notices: [], fileErrors: [],
    fileErrorCount: 0, pendingDeletion: null, filesInQueue: 0, totalFilesInBatch: 0,
    completedFilesInBatch: 0, totalBytesInBatch: 0, completedBytesInBatch: 0, batchStartedAt: 0,
    syncStartedAt: 0, phase: null, scannedFiles: 0, scannedFolders: 0, statusText: "", ...extra,
  };
}

function status(pairs: unknown[], extra: Record<string, unknown> = {}) {
  return {
    pairs, globalPaused: false, activeTransfers: [], unresolvedConflictCount: 0,
    conflictCountByPair: {}, recentLogs: [], fileErrorCount: 0, ...extra,
  };
}

function conflict(i: number) {
  return {
    id: `c${i}`, pairId: "p_two", localPath: `/Users/test/Thesis/chapter-${i}.docx`,
    remoteName: `chapter-${i}.docx`, remoteId: `f${i}`, localMtimeMs: Date.now() - 3_600_000,
    remoteUpdatedAt: Math.floor(Date.now() / 1000) - 7_200, localSizeBytes: 120_000,
    remoteSizeBytes: 118_000, detectedAt: Date.now(),
  };
}

/**
 * Replaces what the engine reports with `snapshot` (and `conflicts`, and the
 * pair config, which says which pairs sync a workspace root) until the app
 * closes.
 */
async function stageSync(
  page: Page,
  snapshot: unknown,
  conflicts: unknown[] = [],
  configPairs: { id: string; remoteFolderId: string | null }[] = [],
): Promise<void> {
  await electronAppFor(page).evaluate(({ ipcMain, BrowserWindow }, { snapshot, conflicts, configPairs }) => {
    const g = globalThis as any;
    g.__stagedSync = snapshot;
    g.__stagedConflicts = conflicts;
    g.__stagedConfigPairs = configPairs;
    ipcMain.removeHandler("sync:get-config");
    ipcMain.handle("sync:get-config", () => ({ pairs: g.__stagedConfigPairs }));
    ipcMain.removeHandler("sync:get-status");
    ipcMain.handle("sync:get-status", () => g.__stagedSync);
    ipcMain.removeHandler("sync:list-conflicts");
    ipcMain.handle("sync:list-conflicts", (_e: unknown, q: { offset: number; limit: number }) => ({
      conflicts: g.__stagedConflicts.slice(q.offset, q.offset + q.limit),
      total: g.__stagedConflicts.length,
    }));
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
  }, { snapshot, conflicts, configPairs });
}

/** Two-way pair with 60 conflicts (two pages), and pairs in every other state. */
function busySnapshot() {
  const now = Date.now();
  return status(
    [
      pair("p_idle", "Invoices"),
      pair("p_two", "Thesis", { syncMode: "two-way" }),
      pair("p_paused", "Camera roll", { status: "paused", syncMode: "pull" }),
      pair("p_err", "Backups", { status: "error", syncMode: "push", errorMessage: ENGINE_SESSION_EXPIRED }),
      pair("p_perm", "Scans", { status: "needs-permission", syncMode: "pull-safe", errorMessage: ENGINE_NEEDS_PERMISSION }),
      pair("p_conf", "Shared drive", {
        status: "needs-confirmation", pendingDeletion: { count: 4, sample: ["a.txt", "b.txt"], heldAt: now },
      }),
      pair("p_off", "Recipes", { status: "offline" }),
      pair("p_wait", "Archive", { status: "rate-limited", lastSyncedAt: null }),
      pair("p_odd", "Music", {
        status: "something-new",
        fileErrorCount: 3,
        fileErrors: [
          { path: "Music/live.flac", message: "EACCES: permission denied", permanent: true, at: now },
          { path: "Music/demo.wav", message: "EBUSY: resource busy", permanent: false, at: now },
        ],
      }),
      pair("p_sync", "Holiday clips", {
        status: "syncing", phase: "transferring", totalFilesInBatch: 10, completedFilesInBatch: 3,
        totalBytesInBatch: 100_000_000, completedBytesInBatch: 30_000_000, batchStartedAt: now - 60_000,
        syncStartedAt: now - 65_000,
      }),
    ],
    {
      globalPaused: true,
      conflictCountByPair: { p_two: 60 },
      unresolvedConflictCount: 60,
      activeTransfers: Array.from({ length: 6 }, (_, i) => ({
        pairId: "p_sync", fileName: `clip-${i}.mov`, direction: i % 2 ? "download" : "upload",
        bytesTotal: 10_000_000, bytesTransferred: 4_000_000, startedAt: now - 30_000,
      })),
      recentLogs: [
        // Engine text the catalog does not know: shown as sent.
        { timestamp: now - 1000, pairId: "p_idle", message: "Uploaded invoice-0042.pdf" },
      ],
    },
  );
}

test.describe("Sync page in Turkish", () => {
  test("folder list with pairs in every state", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    await stageSync(page, busySnapshot());
    await switchLanguage(page, "tr");

    const root = page.locator(PAGE);
    await expect(root.getByRole("heading", { name: "Senkronizasyon", exact: true })).toBeVisible();
    await expect(root).toContainText("Dosyalar senkronize ediliyor: 3/10");
    await expect(root).toContainText("Son senkronizasyon");
    await expect(root).toContainText("Duraklatıldı");
    await expect(root).toContainText("İzin gerekiyor");
    await expect(root).toContainText("İşlem gerekiyor");
    await expect(root).toContainText("Koru ve yükle");
    await expect(root).toContainText("3 dosya senkronize edilmedi");

    // The failed-files list and the row menu.
    await root.getByRole("button", { name: "3 dosya senkronize edilmedi" }).click();
    await root.getByRole("row").filter({ hasText: "Invoices" }).locator("button").last().click();

    // Engine errors on the rows, translated where they are shown.
    await expect(root).toContainText(TR_SESSION_EXPIRED);
    await expect(root.locator(`[title="${TR_SESSION_EXPIRED}"]`)).toBeVisible();
    await expect(root).not.toContainText(ENGINE_NEEDS_PERMISSION);

    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("an engine error with a path, and the root pair, in Turkish", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    await stageSync(
      page,
      status([
        pair("p_root", "Root"),
        pair("p_named", "Root", { status: "error", errorMessage: ENGINE_NOT_FOUND, localPath: "/Users/test/Mine" }),
      ]),
      [],
      // p_named is a folder the user really named "Root": shown as stored.
      [{ id: "p_root", remoteFolderId: null }, { id: "p_named", remoteFolderId: "fld_root_named" }],
    );
    await switchLanguage(page, "tr");

    const root = page.locator(PAGE);
    const rootRow = root.getByRole("row").filter({ hasText: "/Users/test/Root" });
    await expect(rootRow).toContainText("Kök");
    await expect(root).toContainText(TR_NOT_FOUND);
    await expect(root).not.toContainText(ENGINE_NOT_FOUND);
    await expect(root.getByText("Root", { exact: true })).toHaveCount(1);
    // The user's own "Root" folder is user data that equals a catalog string.
    expect(await leftoverEnglish(page, PAGE, { allow: ["Root"] })).toEqual([]);

    // The Issues tab shows the same error, translated.
    await root.getByRole("button", { name: /^Sorunlar/ }).click();
    await expect(root).toContainText(TR_NOT_FOUND);
    expect(await leftoverEnglish(page, PAGE, { allow: ["Root"] })).toEqual([]);
  });

  test("scanning banner", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    const now = Date.now();
    await stageSync(page, status([
      pair("p_a", "Wedding album", { status: "syncing", phase: "scanning", scannedFiles: 1200, scannedFolders: 3, syncStartedAt: now - 5000 }),
      pair("p_b", "Docs", { status: "syncing", phase: "scanning", syncStartedAt: now - 4000 }),
    ]));
    await switchLanguage(page, "tr");

    await expect(page.locator(PAGE)).toContainText("Geçen süre:");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("issues tab with notices and the conflict list", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    const snap = busySnapshot();
    (snap.pairs[0] as any).notices = [
      // Engine text the catalog does not know (the engine fills in the name): shown as sent.
      { kind: "conflict-copy", message: "\"report.docx\" was changed in two places." },
    ];
    await stageSync(page, snap, Array.from({ length: 60 }, (_, i) => conflict(i)));
    await switchLanguage(page, "tr");

    const root = page.locator(PAGE);
    await root.getByRole("button", { name: /^Sorunlar/ }).click();
    await expect(root.getByRole("button", { name: "Klasörü yeniden seç" })).toBeVisible();
    await expect(root.getByRole("button", { name: "Yerel kopyayı sakla" }).first()).toBeVisible();
    await expect(root).toContainText("60 çakışmanın tümü için aynı çözümü uygulayın.");
    await expect(root).toContainText("Toplam 60 çakışma · 1-50 arası");
    await expect(root).toContainText(TR_SESSION_EXPIRED);
    await expect(root.getByText("Yerel", { exact: true }).first()).toBeVisible();
    await expect(root.getByText("Bulut", { exact: true }).first()).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // The bulk bar's confirmation.
    await root.getByRole("button", { name: "Tüm yerel kopyaları sakla" }).click();
    await expect(root.getByRole("button", { name: "Tümünü çöz" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("activity tab", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    await stageSync(page, status([pair("p_a", "Wedding album", { status: "syncing", syncStartedAt: Date.now() - 3000 })]));
    await switchLanguage(page, "tr");

    const root = page.locator(PAGE);
    await root.getByRole("button", { name: "Etkinlik", exact: true }).click();
    await expect(root).toContainText("Henüz senkronizasyon etkinliği yok");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // A live phase line from the engine, translated where it is shown.
    await stageSync(page, status([pair("p_a", "Wedding album", { status: "syncing", statusText: ENGINE_SCANNING, syncStartedAt: Date.now() - 3000 })]));
    await expect(root).toContainText(TR_SCANNING);
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("settings and snooze", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    await switchLanguage(page, "tr");

    const root = page.locator(PAGE);
    await root.getByRole("button", { name: "Ayarlar", exact: true }).click();
    await expect(root.getByRole("button", { name: "Ayarları kaydet" })).toBeVisible();
    await expect(root).toContainText("Süreli duraklatma");
    await expect(root).toContainText("Masaüstü uygulaması");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await root.getByRole("button", { name: "30 dk." }).click();
    const toast = page.locator("[data-sonner-toast]").first();
    await expect(toast).toBeVisible();
    expect(await leftoverEnglish(page, "[data-sonner-toast]")).toEqual([]);
  });

  test("how sync works", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    await switchLanguage(page, "tr");

    await page.locator(PAGE).getByTitle("Senkronizasyonun işleyişi").click();
    await expect(page.getByRole("heading", { name: "Senkronizasyonun işleyişi" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Anladım" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("add sync folder: folders, mode, exclusions", async ({ appPage: page }) => {
    await navigateTo(page, "/sync");
    await electronAppFor(page).evaluate(({ ipcMain }) => {
      ipcMain.removeHandler("sync:pick-local-folder");
      ipcMain.handle("sync:pick-local-folder", async () => ({ path: "/Users/test/Big project" }));
      ipcMain.removeHandler("sync:estimate-local-folder");
      ipcMain.handle("sync:estimate-local-folder", async () => ({ files: 250_000, folders: 900, truncated: true }));
    });
    await switchLanguage(page, "tr");

    const root = page.locator(PAGE);
    await root.getByRole("button", { name: "Senkronizasyon klasörü ekle" }).first().click();
    await expect(root.getByRole("heading", { name: "Senkronizasyon klasörü ekle" })).toBeVisible();
    await expect(root).toContainText("Bulut klasörü");
    await expect(root).toContainText("Yerel klasör");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    await root.getByRole("button", { name: "Göz at" }).click();
    await expect(root).toContainText("/Users/test/Big project");
    await root.getByRole("button", { name: "Devam et" }).click();

    // Step 2: Full Sync shows the conflict choice.
    await root.getByText("Tam senkronizasyon").click();
    await expect(root).toContainText("Çakışma çözümü");
    await expect(root.getByRole("button", { name: "İki kopyayı da sakla" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await root.getByRole("button", { name: "Devam et" }).click();

    // Step 3: exclusions and the huge-folder warning.
    await expect(root).toContainText("Dışlanan dosya ve klasörler");
    await expect(root).toContainText("Yine de senkronize et");
    await expect(root.getByRole("button", { name: "Varsayılanlara dön" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });
});
