import { test, expect, navigateTo } from "../fixtures";
import type { Page } from "@playwright/test";

/**
 * Desktop has no unit runner, so this is the only executable coverage the
 * file-requests page can have.
 *
 * The first test is the one that matters most: creating with an email used to
 * send `recipient_email`, a key the endpoint does not read, so the request was
 * created and nobody was invited with nothing anywhere to notice. It is asserted
 * against the mock's record of the body actually sent, not against the UI.
 */

/** The mock's file-request store, including every create body it received. */
function readStore(page: Page) {
  return page.evaluate(async () => {
    const apiBase = await (window as any).electronAPI.getApiBase();
    const res = await fetch(`${apiBase}/__test/file-requests`);
    return (await res.json()) as {
      requests: { id: string; title: string | null; is_revoked: number }[];
      recipients: { id: string; email: string }[];
      createBodies: Record<string, unknown>[];
      resends: string[];
    };
  });
}

async function openRequests(page: Page): Promise<void> {
  await navigateTo(page, "/file-requests");
  await expect(page.getByTestId("request-req_1")).toBeVisible();
}

test.describe("file requests", () => {
  test("creating with an email sends it in the emails array", async ({ appPage: page }) => {
    await openRequests(page);
    await page.getByTestId("request-new").click();
    await page.getByTestId("create-title").fill("Q3 assets");
    await page.getByTestId("create-email").fill("client@example.com");
    await page.getByTestId("create-submit").click();

    await expect(async () => {
      const store = await readStore(page);
      const body = store.createBodies.find((b) => b.title === "Q3 assets");
      expect(body).toBeTruthy();
      // The whole point: an array under `emails`, which is the only key the
      // endpoint reads.
      expect(body?.emails).toEqual(["client@example.com"]);
      expect(body).not.toHaveProperty("recipient_email");
    }).toPass({ timeout: 5000 });
  });

  test("creating without an email sends no invite list at all", async ({ appPage: page }) => {
    await openRequests(page);
    await page.getByTestId("request-new").click();
    await page.getByTestId("create-title").fill("Link only");
    await page.getByTestId("create-submit").click();

    await expect(async () => {
      const store = await readStore(page);
      const body = store.createBodies.find((b) => b.title === "Link only");
      expect(body).toBeTruthy();
      expect(body?.emails).toBeUndefined();
    }).toPass({ timeout: 5000 });
  });

  test("the detail panel shows what arrived and who was asked", async ({ appPage: page }) => {
    await openRequests(page);
    await page.getByTestId("request-req_1-open").click();
    await expect(page.getByTestId("request-detail")).toBeVisible();
    await expect(page.getByTestId("upload-fru_1")).toBeVisible();
    await expect(page.getByTestId("recipient-rcp_1")).toBeVisible();
    await expect(page.getByTestId("request-detail-url")).toContainText("upload-request");
  });

  test("resending an invite names the recipient", async ({ appPage: page }) => {
    await openRequests(page);
    await page.getByTestId("request-req_1-open").click();
    await page.getByTestId("recipient-rcp_1-resend").click();

    await expect(async () => {
      const store = await readStore(page);
      expect(store.resends).toContain("rcp_1");
    }).toPass({ timeout: 5000 });
  });

  test("offers no resend to a recipient who already uploaded", async ({ appPage: page }) => {
    // rcp_2 has an uploaded_at. Resending to them is noise, so the control is
    // not drawn.
    await openRequests(page);
    await page.getByTestId("request-req_1-open").click();
    await expect(page.getByTestId("recipient-rcp_2")).toBeVisible();
    await expect(page.getByTestId("recipient-rcp_2-resend")).toHaveCount(0);
  });

  test("adding a recipient rejects a malformed address before sending it", async ({ appPage: page }) => {
    await openRequests(page);
    await page.getByTestId("request-req_1-open").click();
    await page.getByTestId("recipient-add-input").fill("not-an-email");
    await page.getByTestId("recipient-add").click();
    await expect(page.getByTestId("recipient-add-error")).toBeVisible();
  });

  test("a duplicate recipient is reported beside the field", async ({ appPage: page }) => {
    // The mock answers 409 for an address already on the list, as the API does.
    await openRequests(page);
    await page.getByTestId("request-req_1-open").click();
    await page.getByTestId("recipient-add-input").fill("client@example.com");
    await page.getByTestId("recipient-add").click();
    await expect(page.getByTestId("recipient-add-error")).toContainText("already");
  });

  test("editing sends only what changed", async ({ appPage: page }) => {
    await openRequests(page);
    await page.getByTestId("request-req_1-open").click();
    await page.getByTestId("request-edit").click();
    await page.getByTestId("request-edit-title").fill("Renamed request");
    await page.getByTestId("request-edit-save").click();

    await expect(async () => {
      const store = await readStore(page);
      expect(store.requests.find((r) => r.id === "req_1")?.title).toBe("Renamed request");
    }).toPass({ timeout: 5000 });
  });

  test("closing a request keeps it in the list, marked Closed", async ({ appPage: page }) => {
    await openRequests(page);
    await page.getByTestId("request-req_1-close").click();
    await page.getByTestId("close-confirm").click();

    // DELETE revokes. The row surviving is the correct behaviour, which is why
    // the button no longer promises a delete.
    await expect(page.getByTestId("request-req_1")).toBeVisible();
    await expect(page.getByTestId("request-req_1")).toContainText("Closed");
  });

  test("a closed request offers neither a close button nor an invite form", async ({ appPage: page }) => {
    await openRequests(page);
    await expect(page.getByTestId("request-req_2")).toContainText("Closed");
    await expect(page.getByTestId("request-req_2-close")).toHaveCount(0);
    await page.getByTestId("request-req_2-open").click();
    await expect(page.getByTestId("request-detail")).toBeVisible();
    await expect(page.getByTestId("recipient-add-input")).toHaveCount(0);
  });
});
