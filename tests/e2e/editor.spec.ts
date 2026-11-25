import { test, expect, navigateTo } from "../fixtures";

/**
 * The ONLYOFFICE editor, in-app.
 *
 * Desktop already had an "Open in editor" menu entry, but it called
 * window.open on app.dosya.dev - throwing the user into a browser, and a second
 * login, for a document already open in front of them. This drives the real
 * in-app route.
 *
 * The mock stands in for the document server and serves a DocsAPI that mounts a
 * marker element. What is under test is that this app fetches the config, loads
 * api.js and mounts the editor - not ONLYOFFICE's own behaviour. Because the
 * fixture points ONLYOFFICE_SERVER_URL at the mock, the renderer's CSP names
 * that same origin, so a script-src that forbade it would fail here rather than
 * pass for the wrong reason.
 */
test.describe("office editor", () => {
  test("mounts the editor for an office file", async ({ appPage: page }) => {
    await navigateTo(page, "/editor/file_5");
    await expect(page.getByTestId("oo-editor-mounted")).toBeVisible({ timeout: 20_000 });
  });

  test("shows the document's title from the signed config", async ({ appPage: page }) => {
    // Proof the config was actually read rather than the page just rendering
    // a shell: this string only comes from the editor-config response.
    await navigateTo(page, "/editor/file_5");
    await expect(page.getByTestId("oo-editor-mounted")).toContainText("Budget.docx", { timeout: 20_000 });
  });

  test("offers a way back out of the editor", async ({ appPage: page }) => {
    // A full-viewport route with no app chrome needs its own exit, or the only
    // way out is the window controls.
    await navigateTo(page, "/editor/file_5");
    await expect(page.getByTestId("oo-editor-mounted")).toBeVisible({ timeout: 20_000 });
    await expect(page.getByRole("link", { name: /Files/ })).toBeVisible();
  });

  // Bounty: api.js runs beside window.electronAPI, so it is pinned with the
  // SRI value the API hands out. Without one the editor must not load api.js
  // at all; with a wrong one Chromium must refuse the bytes.
  for (const [label, sri] of [
    ["no integrity value", undefined],
    ["an integrity value that does not match", "sha384-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ] as const) {
    test(`refuses to run api.js with ${label}`, async ({ appPage: page }) => {
      await page.route("**/api/files/file_sri/editor-config", async (route) => {
        const res = await route.fetch({ url: route.request().url().replace("file_sri", "file_5") });
        const body = await res.json();
        if (sri === undefined) delete body.documentServerApiIntegrity;
        else body.documentServerApiIntegrity = sri;
        return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
      });
      await navigateTo(page, "/editor/file_sri");
      await expect(page.getByRole("button", { name: /Try again/ })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByTestId("oo-editor-mounted")).toHaveCount(0);
      expect(await page.evaluate(() => typeof (window as { DocsAPI?: unknown }).DocsAPI)).toBe("undefined");
    });
  }

  test("reports a failure instead of showing an empty frame", async ({ appPage: page }) => {
    // No such file: editor-config is served only for /api/files/<id>/editor-config,
    // and the catch-all answers {ok:true} with no config, so the page must treat
    // that as a failure rather than mounting nothing and looking ready.
    await navigateTo(page, "/editor/");
    await expect(page.getByTestId("oo-editor-mounted")).toHaveCount(0);
  });
});
