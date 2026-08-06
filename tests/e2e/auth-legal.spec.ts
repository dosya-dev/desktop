import { guestTest as test, expect, navigateTo } from "../fixtures";

const TERMS_URL = "https://dosya.dev/terms-of-service";
const PRIVACY_URL = "https://dosya.dev/privacy-policy";

/**
 * Every entry point into an account has to name both documents: the Terms are
 * the contract, and the Privacy Policy is the notice owed at the point personal
 * data is collected - which a sign-up form is.
 *
 * The desktop app opens external URLs through `window.open(url, "_blank")`,
 * which the main process intercepts (setWindowOpenHandler) and hands to
 * shell.openExternal. A plain <a href> would try to navigate the app window
 * itself, so these are buttons and the assertions check the call, not an href.
 */
test.describe("Auth pages - legal notices", () => {
  for (const route of ["/login", "/signup"]) {
    test(`${route} names the Terms of Service and the Privacy Policy`, async ({
      appPage,
    }) => {
      await navigateTo(appPage, route);

      // /signup carries two of each on purpose: one inside the consent
      // checkbox (the password path) and one in the notice below the OAuth
      // buttons (the OAuth path). Assert at least one and that all are visible.
      const terms = appPage.getByRole("button", { name: "Terms of Service" });
      const privacy = appPage.getByRole("button", { name: "Privacy Policy" });
      expect(await terms.count()).toBeGreaterThan(0);
      expect(await privacy.count()).toBeGreaterThan(0);
      for (const link of [...(await terms.all()), ...(await privacy.all())]) {
        await expect(link).toBeVisible();
      }
    });

    test(`${route} opens the legal documents in the system browser`, async ({
      appPage,
    }) => {
      await navigateTo(appPage, route);

      // Record what the renderer asks to open. The real handler denies the
      // window and defers to shell.openExternal, so nothing opens in-app.
      await appPage.evaluate(() => {
        (window as unknown as { __opened: string[] }).__opened = [];
        window.open = (url?: string | URL) => {
          (window as unknown as { __opened: string[] }).__opened.push(String(url));
          return null;
        };
      });

      // EVERY instance, not just the first: /signup has one in the consent
      // checkbox and one in the OAuth notice, and a page where only one of
      // them reaches the system browser is still broken.
      for (const link of [
        ...(await appPage.getByRole("button", { name: "Terms of Service" }).all()),
        ...(await appPage.getByRole("button", { name: "Privacy Policy" }).all()),
      ]) {
        await link.click();
      }

      const opened = await appPage.evaluate(
        () => (window as unknown as { __opened: string[] }).__opened,
      );
      expect(opened).toContain(TERMS_URL);
      expect(opened).toContain(PRIVACY_URL);
    });
  }

  test("sign-up carries a notice covering the OAuth buttons, not just the checkbox", async ({
    appPage,
  }) => {
    await navigateTo(appPage, "/signup");
    // "Continue with Google" creates a real account without touching the
    // consent checkbox. The API stamps those accounts as having accepted, so
    // the passive notice is what that stamp rests on.
    await expect(
      appPage.getByText(/By continuing, you agree to our/i),
    ).toBeVisible();
  });

  test("sign-up blocks submission until the terms are accepted", async ({
    appPage,
  }) => {
    await navigateTo(appPage, "/signup");

    await appPage.getByPlaceholder("Your name").fill("Ada Lovelace");
    await appPage.getByPlaceholder("you@example.com").fill("ada@example.com");
    await appPage.getByPlaceholder("Min. 8 characters").fill("Correct-Horse-99");

    // Consent box left unticked.
    await appPage.getByRole("button", { name: "Create account" }).click();
    await expect(appPage.getByText(/accept the Terms of Service/i)).toBeVisible();
  });

  test("sign-up tells the API the terms were accepted", async ({ appPage }) => {
    await navigateTo(appPage, "/signup");

    const bodies: string[] = [];
    await appPage.route("**/api/auth/signup", async (route) => {
      bodies.push(route.request().postData() ?? "");
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ ok: true }),
      });
    });

    await appPage.getByPlaceholder("Your name").fill("Ada Lovelace");
    await appPage.getByPlaceholder("you@example.com").fill("ada@example.com");
    await appPage.getByPlaceholder("Min. 8 characters").fill("Correct-Horse-99");
    await appPage.getByRole("checkbox").check();
    await appPage.getByRole("button", { name: "Create account" }).click();

    await expect.poll(() => bodies.length).toBeGreaterThan(0);
    // The endpoint rejects a signup without this field, so a client that never
    // sends it cannot create an account at all.
    expect(JSON.parse(bodies[0])).toMatchObject({ terms: true });
  });
});
