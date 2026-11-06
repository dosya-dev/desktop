import type { Page } from "@playwright/test";
import { test, expect, navigateTo } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";

/**
 * The Vault in Turkish: the setup card (choose a passphrase, mismatch), the
 * one-time recovery key, the unlocked browser (Spaces menu, New Space,
 * entries, upload), members (list, revoke dialog, a refused invite), the
 * unlock card (passphrase, wrong passphrase, recovery key), the destroy
 * dialog and the could-not-check state. Each surface is spot-checked for a
 * few Turkish strings (src/i18n/messages/tr.json), then swept for English
 * the catalog knows, scoped to the Vault page (its dialogs render inside it)
 * and the toasts.
 *
 * The real crypto needs a VOPRF server the mock API does not have (vault.spec
 * covers the locked gate against the mock; packages/e2ee-* cover the crypto).
 * To reach the unlocked screens this spec puts a fake engine behind the
 * store through its own test seam, `__setEngine`. The store is not on
 * window, so the seam is reached the way React reaches it: the page's
 * useVault() subscription is read off the VaultPage fiber, and a listener
 * on it receives the store state, actions included, on the next change.
 */

const PAGE = "[data-testid=vault-page]";
const TOASTS = "[data-sonner-toaster]";

interface FakeOptions {
  hasIdentity: "yes" | "no" | "fail";
}

/**
 * Captures the Vault store and installs a fake engine. Leaves the app on
 * /vault with the gate re-checked against the fake.
 */
async function fakeVault(page: Page, opts: FakeOptions): Promise<void> {
  await navigateTo(page, "/vault");
  await expect(page.locator(PAGE)).toBeVisible();
  await page.evaluate(() => {
    const w = window as unknown as Record<string, unknown>;
    const el = document.querySelector("[data-testid=vault-page]") as unknown as Record<string, unknown>;
    const fiberKey = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
    if (!fiberKey) throw new Error("no React fiber on the Vault page");
    type Hook = { memoizedState?: { deps?: unknown[] } | unknown; next?: Hook | null };
    type Fiber = { return?: Fiber | null; memoizedState?: Hook | null; type?: unknown };
    let f = el[fiberKey] as Fiber | null | undefined;
    // Up to VaultPage, the function component that calls useVault().
    while (f && typeof f.type !== "function") f = f.return;
    if (!f) throw new Error("no VaultPage fiber");
    for (let h = f.memoizedState ?? null; h; h = h.next ?? null) {
      const deps = (h.memoizedState as { deps?: unknown[] } | null)?.deps;
      // useSyncExternalStore's subscribe effect: deps = [store.subscribe].
      if (Array.isArray(deps) && deps.length === 1 && typeof deps[0] === "function") {
        try {
          (deps[0] as (l: (s: unknown) => void) => void)((s: unknown) => {
            if (s && typeof (s as { __setEngine?: unknown }).__setEngine === "function") w.__vault = s;
          });
        } catch {
          // Not a store subscription.
        }
      }
    }
  });
  // Any store change hands the listener the state: the gate re-checks on mount.
  await navigateTo(page, "/dashboard");
  await navigateTo(page, "/vault");
  await expect.poll(() => page.evaluate(() => "__vault" in window)).toBe(true);

  await page.evaluate(({ hasIdentity }) => {
    type Vault = { __setEngine(e: unknown): void };
    const vault = (window as unknown as { __vault: Vault }).__vault;
    vault.__setEngine({
      async hasIdentity() {
        if (hasIdentity === "fail") throw new Error("");
        return hasIdentity === "yes";
      },
      async setup() { return { recoveryKeyHex: "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90" }; }, // gitleaks:allow - fake key, counting hex
      async unlock(pass: string) { if (pass !== "right passphrase") throw new Error("e2ee: unlock failed"); },
      async unlockWithRecoveryKey() { throw new Error("e2ee: unlock failed"); },
      async destroyIdentity() { throw new Error("Incorrect password"); },
      lock() {},
      async createWorkspace() {},
      async readWorkspaceName() { return null; },
      async readWorkspaceNameById() { return null; },
      async renameWorkspace() {},
      async setWorkspaceScope() {},
      async openWorkspace() {},
      async listFolder(folderId: string) {
        return folderId === ""
          ? [{ id: "d1", name: "Faturalar", kind: "folder" }, { id: "f1", name: "vergi-2025.pdf", kind: "file" }]
          : [];
      },
      async uploadFile() {},
      async downloadFileToSink() {},
      async listMembers() {
        return [
          { userId: "user_test_1", email: "test@dosya.dev", ed25519Pub: "a", x25519Pub: "a" },
          { userId: "user_ada", email: "ada@ornek.test", ed25519Pub: "b", x25519Pub: "b" },
        ];
      },
      async inviteMember() { throw new Error("e2ee: grantAccess: that user has no E2EE identity"); },
      async revokeMember() {},
      async listMyWorkspaces() { return [{ workspaceId: "shared_1", globalWorkspaceId: null, createdByMe: false }]; },
    });
  }, opts);
  await navigateTo(page, "/dashboard");
  await navigateTo(page, "/vault");
}

test.describe("Vault in Turkish", () => {
  test("setup card, recovery key, Spaces, browser and members", async ({ appPage: page }) => {
    await fakeVault(page, { hasIdentity: "no" });
    await switchLanguage(page, "tr");
    const root = page.locator(PAGE);

    // Setup card.
    await expect(page.getByTestId("vault-setup")).toBeVisible();
    await expect(root.getByRole("heading", { name: "Şifreleme kurulumu" })).toBeVisible();
    await expect(root).toContainText("Vault'unuzu korumak için bir Vault parolası belirleyin.");
    await expect(root.getByRole("link", { name: "Vault nedir? Daha fazla bilgi" })).toBeVisible();
    await expect(page.locator("#vault-setup-pass")).toHaveAttribute("placeholder", "Güçlü bir Vault parolası girin");
    await page.locator("#vault-setup-pass").fill("right passphrase");
    await page.locator("#vault-setup-confirm").fill("wrong passphrase");
    await page.locator("#vault-setup-confirm").blur();
    await expect(root).toContainText("Vault parolaları eşleşmiyor.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // Recovery key, shown once.
    await page.locator("#vault-setup-confirm").fill("right passphrase");
    await page.getByTestId("vault-setup-submit").click();
    const key = page.getByTestId("vault-recovery-key");
    await expect(key).toBeVisible();
    await expect(key.getByRole("heading", { name: "Kurtarma anahtarınızı kaydedin" })).toBeVisible();
    await expect(key).toContainText("Bu anahtar bir daha gösterilmeyecek.");
    await expect(key.getByTitle("Kurtarma anahtarını kopyala")).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await key.getByRole("button", { name: "Kaydettim" }).click();
    await expect(key).toHaveCount(0);

    // Unlocked, no Space picked: the Spaces menu with a shared placeholder.
    await expect(page.getByTestId("vault-browser")).toBeVisible();
    await expect(root).toContainText("Uçtan uca şifrelenmiş");
    await expect(root).toContainText("Alanlarım");
    await expect(root).toContainText("Henüz alan yok");
    await expect(root).toContainText("Benimle paylaşılanlar");
    await expect(page.getByTestId("vault-space-shared_1")).toHaveText("Paylaşılan alan");
    await expect(root).toContainText("Başlamak için bir alan seçin veya oluşturun.");
    await expect(root.getByRole("button", { name: "Kilitle" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // New Space dialog.
    await page.getByTestId("vault-new-space").click();
    const create = page.getByTestId("vault-new-space-modal");
    await expect(create.getByRole("heading", { name: "Yeni alan" })).toBeVisible();
    await expect(page.locator("#vault-new-space-name")).toHaveAttribute("placeholder", "Örn. Kişisel belgeler");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await page.locator("#vault-new-space-name").fill("Belgeler");
    await create.getByRole("button", { name: "Oluştur" }).click();
    await expect(create).toHaveCount(0);

    // The Space's contents.
    await expect(page.getByTestId("vault-entry-d1")).toContainText("Şifrelenmiş klasör");
    await expect(page.getByTestId("vault-download-f1")).toHaveAttribute("title", "İndir");
    await expect(root.getByRole("button", { name: "Üyeler" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // Upload toast.
    await page.getByTestId("vault-upload-input").setInputFiles({ name: "not.txt", mimeType: "text/plain", buffer: Buffer.from("x") });
    await expect(page.locator(TOASTS)).toContainText("Yüklendi");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);

    // Members: picking the Space from the menu loads them.
    await page.locator("[data-testid^=vault-space-]", { hasText: "Belgeler" }).click();
    await expect(page.getByTestId("vault-entry-f1")).toBeVisible();
    await page.getByTestId("vault-members").click();
    const members = page.getByTestId("vault-members-modal");
    await expect(members.getByRole("heading", { name: "Üyeler: Belgeler" })).toBeVisible();
    await expect(page.getByTestId("vault-member-user_test_1")).toContainText("Siz");
    await expect(page.getByTestId("vault-revoke-user_ada")).toHaveAttribute("title", "Erişim iznini geçersiz kıl");
    await expect(members).toContainText("Erişim, ilk kullanımda güven ilkesine göre verilir.");
    await expect(page.getByTestId("vault-invite-email")).toHaveAttribute("placeholder", "ekip@example.com");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // Revoke dialog: the email sits inside the translated sentence.
    await page.getByTestId("vault-revoke-user_ada").click();
    const revoke = page.getByTestId("vault-revoke-modal");
    await expect(revoke.getByRole("heading", { name: "Erişim izni geçersiz kılınsın mı?" })).toBeVisible();
    await expect(revoke).toContainText("“Belgeler” adlı alana erişim izni geçersiz kılınsın mı? Hesap: ada@ornek.test");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await revoke.getByRole("button", { name: "İptal" }).click();
    await expect(revoke).toHaveCount(0);

    // A refused invite: the store's own sentence, in Turkish.
    await page.getByTestId("vault-invite-email").fill("nobody@ornek.test");
    await page.getByTestId("vault-invite").click();
    await expect(page.locator(TOASTS)).toContainText("Davet edilemedi.");
    await expect(page.locator(TOASTS)).toContainText("Bu kişi henüz şifrelemeyi ayarlamadı.");
    expect(await leftoverEnglish(page, TOASTS)).toEqual([]);
  });

  test("unlock card, wrong passphrase, recovery key and destroy dialog", async ({ appPage: page }) => {
    await fakeVault(page, { hasIdentity: "yes" });
    const root = page.locator(PAGE);
    await expect(page.getByTestId("vault-unlock")).toBeVisible();

    // Wrong passphrase while in English, then a switch: the error follows.
    await page.locator("#vault-unlock-pass").fill("not it");
    await page.getByTestId("vault-unlock-submit").click();
    await expect(root).toContainText("Incorrect passphrase or no identity found.");
    await switchLanguage(page, "tr");
    await expect(root).toContainText("Vault parolası yanlış veya Vault kimliği bulunamadı.");
    await expect(root.getByRole("heading", { name: "Vault kilidini aç" })).toBeVisible();
    await expect(page.locator("#vault-unlock-pass")).toHaveAttribute("placeholder", "Vault parolanız");
    await expect(page.getByTestId("vault-unlock-submit")).toHaveText("Kilidi aç");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // Recovery key path.
    await page.getByTestId("vault-recovery-toggle").click();
    await expect(root.getByRole("heading", { name: "Kurtarma anahtarıyla kilidi aç" })).toBeVisible();
    await expect(page.locator("#vault-recovery-key")).toHaveAttribute("placeholder", "Kurtarma anahtarınız");
    await expect(page.getByTestId("vault-recovery-toggle")).toHaveText("Vault parolasını kullan");
    await page.locator("#vault-recovery-key").fill("00".repeat(32));
    await page.getByTestId("vault-unlock-submit").click();
    await expect(root).toContainText("Bu kurtarma anahtarıyla Vault'un kilidi açılamadı.");
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);

    // Destroy dialog.
    await page.getByTestId("vault-destroy").click();
    const destroy = page.getByTestId("vault-destroy-modal");
    await expect(destroy.getByRole("heading", { name: "Vault'u yok edip baştan başlamak istiyor musunuz?" })).toBeVisible();
    await expect(destroy).toContainText("Bu işlem Vault kimliğinizi siler.");
    await expect(page.locator("#vault-destroy-password")).toHaveAttribute("placeholder", "dosya.dev hesabınızın parolası");
    await expect(destroy.getByRole("button", { name: "Vault'umu yok et" })).toBeDisabled();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
    await destroy.getByRole("button", { name: "İptal" }).click();

    // The right passphrase opens the browser; Lock returns to the card.
    await page.getByTestId("vault-recovery-toggle").click();
    await page.locator("#vault-unlock-pass").fill("right passphrase");
    await page.getByTestId("vault-unlock-submit").click();
    await expect(page.getByTestId("vault-browser")).toBeVisible();
    await page.getByTestId("vault-lock").click();
    await expect(page.getByTestId("vault-unlock")).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });

  test("could not check encryption status", async ({ appPage: page }) => {
    await fakeVault(page, { hasIdentity: "fail" });
    await switchLanguage(page, "tr");
    const retry = page.getByTestId("vault-retry");
    await expect(retry.getByRole("heading", { name: "Şifreleme durumu denetlenemedi." })).toBeVisible();
    await expect(retry).toContainText("Şifreleme durumu denetlenemedi.");
    await expect(retry.getByRole("button", { name: "Yeniden dene" })).toBeVisible();
    expect(await leftoverEnglish(page, PAGE)).toEqual([]);
  });
});
