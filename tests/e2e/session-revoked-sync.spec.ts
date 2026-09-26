import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { test, expect, navigateTo } from "../fixtures";

/**
 * The "token issues" flow. When the server invalidates a session, the cookie
 * stays in the Electron jar - no cookie-removed event ever fires - so the
 * sync engine keeps running against the dead session and parks its pairs in
 * "Session expired". The renderer notices the 401 and throws the user to the
 * login screen.
 *
 * Logging back in must bring sync back PROMPTLY. The cookie-set event is
 * wired to an immediate session refresh (drop the client's 60s cookie cache,
 * run a recovery pass now); before that fix the user could sit through the
 * cache TTL plus the 30s recovery tick watching "Session expired. Please log
 * in again." while demonstrably logged in - which reads as data loss.
 */

test("sync recovers promptly after a revoked session and re-login", async ({ appPage: page }) => {
  // Five sequential phases (add pair, revoke+error, reload, login, recover),
  // two of them waiting on engine timers - the default 60s test budget is
  // not enough for the whole journey.
  test.setTimeout(240_000);
  const apiBase: string = await page.evaluate(() =>
    (window as any).electronAPI.getApiBase(),
  );
  const dir = mkdtempSync(join(tmpdir(), "dosya-e2e-revoked-"));

  const setAuth = (revoked: boolean) =>
    page.evaluate(
      ([base, r]) =>
        fetch(`${base}/__test/set-auth`, {
          method: "POST",
          body: JSON.stringify({ revoked: r }),
        }).then((res) => res.ok),
      [apiBase, revoked] as [string, boolean],
    );

  const pairState = async () => {
    // Reading engine state races the sign-out this test deliberately causes:
    // losing the session makes the renderer reload onto onboarding, and an
    // evaluate in flight when that lands dies with "Execution context was
    // destroyed". The pair lives in the MAIN process and is unaffected, so
    // the read is simply retried against the new context rather than failing
    // a poll whose subject is the engine, not the page.
    const status = await page
      .evaluate(() => (window as any).electronAPI.getSyncStatus())
      .catch(async (err: Error) => {
        if (!/Execution context was destroyed|Target closed/.test(err.message)) throw err;
        await page.waitForLoadState("domcontentloaded");
        return page.evaluate(() => (window as any).electronAPI.getSyncStatus());
      });
    const pair = status?.pairs?.find(
      (p: any) => p.remoteFolderName === "revoked-session",
    );
    return pair
      ? { status: pair.status, error: pair.errorMessage, syncedAt: pair.lastSyncedAt }
      : null;
  };

  try {
    const pairId: string = await page.evaluate(async (path: string) => {
      const pair = await (window as any).electronAPI.addSyncPair({
        workspaceId: "ws_test",
        workspaceName: "Test Workspace",
        localPath: path,
        remoteFolderName: "revoked-session",
        region: "eu-west",
      });
      return pair.id;
    }, dir);
    // Wait for the initial sync to finish before revoking, nudging with
    // syncNow: the engine's boot start races the fixture (it starts on the
    // cookie-set event), and a file dropped while the watcher is still
    // starting is invisible to it (ignoreInitial) - the pair would then sit
    // silently instead of erroring and the test would wait forever.
    await page.evaluate((id: string) => (window as any).electronAPI.syncNow(id), pairId);
    await expect
      .poll(async () => (await pairState())?.syncedAt ?? null, { timeout: 30_000 })
      .not.toBeNull();
    const syncedBefore = (await pairState())!.syncedAt as number;

    // Revoke the session server-side (the cookie stays in the jar), then
    // force the engine to talk to the API: a dropped file for realism, a
    // syncNow so the API round-trip happens deterministically.
    expect(await setAuth(true)).toBe(true);
    writeFileSync(join(dir, "poke.txt"), "hello");
    await page.evaluate((id: string) => (window as any).electronAPI.syncNow(id), pairId);

    // The app signs ITSELF out: a confirmed 401 tears the session down,
    // clears the cookie (which stops the engine through the main process's
    // cookie listener) and reloads onto onboarding. No manual reload here -
    // driving it by hand would hide a regression in that teardown.
    //
    // This used to assert the pair parked in "Session expired" first. It
    // cannot: the sign-out stops the engine, so the pair goes quiet at idle
    // rather than erroring. That assertion only ever passed because the mock
    // answered a cookie-less /api/me with 200 and a fresh Set-Cookie, so the
    // reload silently signed back in and left the engine running to find its
    // own 401 - an endless sign-out/re-auth loop no server can produce (see
    // the deadSessions gate in tests/helpers/mock-api.ts).
    await page.waitForFunction(
      () => window.location.hash.includes("/onboarding"),
      { timeout: 90_000 },
    );
    await navigateTo(page, "/login");
    await expect(page.getByPlaceholder("you@example.com")).toBeVisible({
      timeout: 15_000,
    });

    // Log back in through the real form. The mock mints a fresh session
    // cookie (new value), exactly like production.
    await page.getByPlaceholder("you@example.com").fill("test@dosya.dev");
    await page.getByPlaceholder("Enter your password").fill("SecurePass1!");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.waitForFunction(
      () => window.location.hash.includes("/dashboard"),
      { timeout: 15_000 },
    );

    // Sync must come back on its own, promptly, and actually RUN - a pair
    // sitting at idle with no error would satisfy "no error" while syncing
    // nothing, so the assertion is that it completes a fresh pass (a newer
    // lastSyncedAt than the one before the revocation) without anyone
    // touching it. The bound is the point: the old behaviour waited for the
    // next 30s recovery tick, phase-random relative to the login; the fixed
    // path refreshes on the cookie-set event itself.
    await expect
      .poll(async () => (await pairState())?.syncedAt ?? 0, { timeout: 20_000 })
      .toBeGreaterThan(syncedBefore);
    expect((await pairState())?.error ?? null).toBeNull();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
