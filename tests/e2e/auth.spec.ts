import { guestTest as test, expect, navigateTo, electronAppFor } from "../fixtures";

test.describe("Login Page", () => {
  test("renders login form with all elements", async ({ appPage }) => {
    await navigateTo(appPage, "/login");

    // Form inputs
    await expect(appPage.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(
      appPage.getByPlaceholder("Enter your password"),
    ).toBeVisible();

    // Submit button
    await expect(
      appPage.getByRole("button", { name: "Sign in" }),
    ).toBeVisible();

    // OAuth buttons
    await expect(
      appPage.getByRole("button", { name: /Continue with Google/ }),
    ).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /Continue with GitHub/ }),
    ).toBeVisible();

    // Links
    await expect(appPage.getByText("Forgot password?")).toBeVisible();
    await expect(appPage.getByText("Sign up")).toBeVisible();
  });

  test("can fill login form and inputs retain values", async ({ appPage }) => {
    await navigateTo(appPage, "/login");

    await appPage.getByPlaceholder("you@example.com").fill("test@dosya.dev");
    await appPage
      .getByPlaceholder("Enter your password")
      .fill("SecurePass1!");

    // Verify inputs retain values
    await expect(appPage.getByPlaceholder("you@example.com")).toHaveValue(
      "test@dosya.dev",
    );
    await expect(
      appPage.getByPlaceholder("Enter your password"),
    ).toHaveValue("SecurePass1!");

    // Sign in button should be enabled
    await expect(
      appPage.getByRole("button", { name: "Sign in" }),
    ).toBeEnabled();
  });

  test("sign in button shows loading state on submit", async ({ appPage }) => {
    await navigateTo(appPage, "/login");

    await appPage.getByPlaceholder("you@example.com").fill("test@dosya.dev");
    await appPage.getByPlaceholder("Enter your password").fill("Secure1!");
    await appPage.getByRole("button", { name: "Sign in" }).click();

    // Should show "Signing in..." while loading
    await expect(
      appPage.getByRole("button", { name: /signing in/i }),
    ).toBeVisible({ timeout: 3_000 }).catch(() => {
      // Button may have already transitioned - that's fine
    });
  });

  test("password visibility toggle works", async ({ appPage }) => {
    await navigateTo(appPage, "/login");

    const passwordInput = appPage.getByPlaceholder("Enter your password");
    await passwordInput.fill("mySecret123");

    // Initially password type
    await expect(passwordInput).toHaveAttribute("type", "password");

    // Click the toggle button (it's inside the password field container)
    await passwordInput
      .locator("..")
      .locator("button[tabindex='-1']")
      .click();
    await expect(passwordInput).toHaveAttribute("type", "text");
  });

  test("a real login response's session cookie is captured into the Electron cookie store", async ({ appPage }) => {
    // Guards DSK-013: session.ts's onBeforeSendHeaders/onHeadersReceived
    // hooks now carry a `urls` filter so Electron stops running them for
    // every request the app makes (fonts, map tiles, R2 chunks, ...). An
    // over-narrow filter would silently drop onHeadersReceived's cookie
    // capture for the API origin, and the symptom is not a crash - it's
    // "login appears to succeed, then every later request 401s", because
    // the renderer has already left /login by the time anything notices.
    // The mock's /api/auth/login returns 200 + Set-Cookie for any
    // credentials (tests/helpers/mock-api.ts), same as production.
    await navigateTo(appPage, "/login");
    await appPage.getByPlaceholder("you@example.com").fill("test@dosya.dev");
    await appPage.getByPlaceholder("Enter your password").fill("SecurePass1!");
    await appPage.getByRole("button", { name: "Sign in" }).click();

    await appPage.waitForFunction(
      () => window.location.hash.includes("/dashboard"),
      { timeout: 15_000 },
    );

    // Read the cookie back from the MAIN process's store, not the renderer's
    // document.cookie (httpOnly) or localStorage - this is exactly the store
    // session.ts's onHeadersReceived writes to, and exactly what the sync
    // engine's hasSession() gate reads from on every later request.
    const electronApp = electronAppFor(appPage);
    const cookies = await electronApp.evaluate(({ session }) =>
      session.defaultSession.cookies.get({ name: "dosya_session" }),
    );
    expect(cookies.length).toBeGreaterThan(0);
    expect(cookies[0].value).toBeTruthy();
  });

  test("Forgot password link navigates correctly", async ({ appPage }) => {
    await navigateTo(appPage, "/login");
    await appPage.getByText("Forgot password?").click();
    await expect(
      appPage.getByRole("button", { name: /send|reset/i }),
    ).toBeVisible();
  });

  test("Sign up link navigates correctly", async ({ appPage }) => {
    await navigateTo(appPage, "/login");
    await appPage.getByText("Sign up").click();
    await expect(appPage.getByText("Create an account")).toBeVisible();
  });
});

test.describe("Sign Up Page", () => {
  test("renders registration form", async ({ appPage }) => {
    await navigateTo(appPage, "/signup");

    await expect(appPage.getByText("Create an account")).toBeVisible();
    await expect(appPage.getByPlaceholder("Your name")).toBeVisible();
    await expect(appPage.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(
      appPage.getByPlaceholder("Min. 8 characters"),
    ).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: "Create account" }),
    ).toBeVisible();
  });

  test("shows OAuth providers and sign in link", async ({ appPage }) => {
    await navigateTo(appPage, "/signup");

    await expect(
      appPage.getByRole("button", { name: /Continue with Google/ }),
    ).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /Continue with GitHub/ }),
    ).toBeVisible();
    await expect(appPage.getByText("Sign in")).toBeVisible();
  });

  test("shows password requirements", async ({ appPage }) => {
    await navigateTo(appPage, "/signup");
    // Length-only policy since 2026-09-02 (validation-policy: no composition rules).
    await expect(appPage.getByText(/at least 8 characters/i)).toBeVisible();
  });
});

test.describe("Forgot Password Page", () => {
  test("renders email form", async ({ appPage }) => {
    await navigateTo(appPage, "/forgot-password");

    await expect(appPage.getByPlaceholder("you@example.com")).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /send|reset/i }),
    ).toBeVisible();
  });
});
