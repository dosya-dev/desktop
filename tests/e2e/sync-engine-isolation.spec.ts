import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import type { Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/**
 * Phase 6 acceptance: the sync engine runs in its own process, and killing it
 * costs a re-fork rather than the whole app.
 *
 * These cannot be unit tests. The claim is specifically about process
 * boundaries and OS-level kills, which is exactly what a unit test abstracts
 * away. Before Phase 6 the engine ran inside the main process, so an engine
 * crash took the window with it - that is the regression these specs exist to
 * catch.
 *
 * Note on what drives the engine here: the fixture's app ends up logged out a
 * few hundred milliseconds after launch (the session cookie is set and then
 * removed), so the engine is not left running on its own. Calling
 * `getSyncConfig()` is what the Sync page itself does on mount, and it forces
 * the supervisor to fork the child - which is the state these specs need.
 */

const ENGINE_SERVICE_NAME = "dosya-sync-engine";

/**
 * The engine's pid, via `app.getAppMetrics()`.
 *
 * Deliberately a public Electron API rather than a test-only hook stashed on
 * globalThis: production code should not grow a backdoor to make a test
 * easier, and the metrics list is how a user would find the process too.
 *
 * Match on `name`, NOT `serviceName`. The `serviceName` passed to
 * `utilityProcess.fork` surfaces in metrics as `name`; every Node utility
 * process reports the same `serviceName` of "node.mojom.NodeService", so
 * matching on that would find the wrong process or none at all.
 */
async function enginePid(page: Page): Promise<number | null> {
  const app = electronAppFor(page);
  return app.evaluate(({ app: electronApp }, name) => {
    const match = electronApp
      .getAppMetrics()
      .find((m) => m.type === "Utility" && (m as { name?: string }).name === name);
    return match?.pid ?? null;
  }, ENGINE_SERVICE_NAME);
}

/** The IPC the Sync page issues on mount. Forces the child to exist. */
async function touchSyncIpc(page: Page): Promise<void> {
  await page.evaluate(async () => {
    await (window as unknown as { electronAPI: { getSyncConfig(): Promise<unknown> } }).electronAPI.getSyncConfig();
  });
}

/** Poll until the engine process exists, without a fixed sleep. */
async function waitForEnginePid(page: Page, opts: { not?: number | null } = {}, timeoutMs = 25_000): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const pid = await enginePid(page);
    if (pid !== null && pid !== opts.not) return pid;
    await touchSyncIpc(page).catch(() => {});
    await page.waitForTimeout(300);
  }
  throw new Error(`No "${ENGINE_SERVICE_NAME}" utility process appeared within ${timeoutMs}ms`);
}


test.describe("Sync engine isolation", () => {
  test("the engine runs in its own utility process", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");
    await touchSyncIpc(appPage);
    const pid = await waitForEnginePid(appPage);

    expect(pid).toBeGreaterThan(0);
    // A pid equal to the main process would mean the engine silently fell back
    // to running in-process, which would pass every other assertion here.
    const mainPid = await electronAppFor(appPage).evaluate(() => process.pid);
    expect(pid).not.toBe(mainPid);
  });

  test("killing the engine leaves the window alive and usable", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");
    await touchSyncIpc(appPage);
    const firstPid = await waitForEnginePid(appPage);

    process.kill(firstPid, "SIGKILL");

    // The window must stay responsive. Navigating and rendering another route
    // is a stronger check than reading the DOM, which would still be there in
    // a hung renderer.
    await navigateTo(appPage, "/dashboard");
    await expect(appPage.locator("body")).toBeVisible();
    await navigateTo(appPage, "/sync");
    await expect(appPage.getByText("Sync").first()).toBeVisible();
    await expect(
      appPage.getByRole("button", { name: /add sync folder/i }).first(),
    ).toBeVisible();
  });

  test("the engine is available again after a kill, on a fresh pid", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");
    await touchSyncIpc(appPage);
    const firstPid = await waitForEnginePid(appPage);

    process.kill(firstPid, "SIGKILL");

    // Deliberately a WEAK claim: some new process serves requests again. It
    // does NOT distinguish the supervisor's restart from a lazy re-fork on the
    // next RPC - the renderer polls sync IPC on its own, and either mechanism
    // satisfies this. Confirmed by mutation: it still passes with autonomous
    // restart removed entirely.
    //
    // The strong claim lives in "resumes syncing on its own" below, which does
    // go red under that mutation. Keep both: this one localises a total
    // failure to fork, that one proves the supervisor actually works.
    const secondPid = await waitForEnginePid(appPage, { not: firstPid });
    expect(secondPid).not.toBe(firstPid);
  });

  test("a killed engine resumes syncing on its own, without being prompted", async ({ appPage }) => {
    // This is the Phase 6 acceptance criterion, and it is deliberately NOT
    // written as "a new pid appears". The renderer polls sync IPC on its own,
    // and any RPC lazily re-forks a dead engine - so a pid check passes even
    // with autonomous restart entirely removed (verified by mutation).
    //
    // What only the supervisor's restart path does is call start() again,
    // which restarts the configured pairs. So the honest signal is work
    // getting done: folders created on the server after the kill, with
    // nothing asking the app to do it.
    // Three sequential phases (sync, kill, sync again) do not fit the suite's
    // 60s default. Under load the first sync alone can take most of it, which
    // showed up as a confusing "Received array: []" rather than an honest
    // timeout - the folders were being created, just later than the budget.
    test.setTimeout(180_000);

    const base = mkdtempSync(join(tmpdir(), "dosya-e2e-restart-"));
    const localRoot = join(base, "photos");
    mkdirSync(join(localRoot, "before"), { recursive: true });

    const readFolderNames = () =>
      appPage.evaluate(async () => {
        const apiBase = await (window as any).electronAPI.getApiBase();
        const res = await fetch(`${apiBase}/__test/folders`);
        const body = await res.json();
        return (body.folders as { name: string }[]).map((f) => f.name);
      });

    try {
      await appPage.evaluate(async (path: string) => {
        await (window as any).electronAPI.addSyncPair({
          workspaceId: "ws_test_1",
          workspaceName: "Test Workspace",
          localPath: path,
          remoteFolderName: "photos",
          region: "eu-west",
        });
      }, localRoot);

      // The pair syncing at all is what puts the engine in the running state,
      // which is the only state autonomous restart applies to.
      await expect.poll(readFolderNames, { timeout: 60_000 }).toContain("before");

      const firstPid = await waitForEnginePid(appPage);
      process.kill(firstPid, "SIGKILL");

      // New local work that only a RESTARTED, RE-STARTED engine will notice.
      mkdirSync(join(localRoot, "after-the-kill"), { recursive: true });

      await expect
        .poll(readFolderNames, { timeout: 60_000 })
        .toContain("after-the-kill");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("sync IPC still answers after the engine was killed", async ({ appPage }) => {
    await navigateTo(appPage, "/sync");
    await touchSyncIpc(appPage);
    const pid = await waitForEnginePid(appPage);

    process.kill(pid, "SIGKILL");

    // The pending-call rejection path matters here: if the host left the
    // in-flight promise unsettled, this invoke would hang until the test timed
    // out rather than returning a config.
    const config = await appPage.evaluate(async () => {
      const api = (window as unknown as { electronAPI: { getSyncConfig(): Promise<unknown> } }).electronAPI;
      return api.getSyncConfig();
    });
    expect(config).toBeTruthy();
  });
});
