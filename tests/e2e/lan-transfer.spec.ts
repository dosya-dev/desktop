import { test, expect, navigateTo } from "../fixtures";

/**
 * LAN Transfer's entry points.
 *
 * The room card used to render an EMPTY 6-digit code: the page read
 * `room_code` off a response that says `roomCode`, so the span that should
 * hold it had no text child and no other device could ever join. Nothing
 * failed - no console error, no failed request - which is why it survived.
 * The first test is that regression, and it asserts on the code's actual
 * text rather than on the card being present.
 *
 * What these CANNOT cover: the peer connection itself. Two Electron windows
 * in one Playwright worker share a network namespace but still need real ICE
 * to pair, and the handshake, framing and routing are covered without a
 * browser in src/renderer/lib/lan-peer.test.ts. A genuine transfer needs two
 * machines on one LAN.
 */

test.describe("LAN Transfer", () => {
  test("creating a room renders the code the API returned", async ({ appPage }) => {
    await navigateTo(appPage, "/lan-transfer");

    await appPage.getByText("Create a room").click();

    const code = appPage.locator(".font-mono.text-4xl");
    await expect(code).toHaveText("482917", { timeout: 10_000 });
  });

  test("the room card offers the code for copying, and waits for the peer", async ({ appPage }) => {
    await navigateTo(appPage, "/lan-transfer");
    await appPage.getByText("Create a room").click();

    await expect(appPage.getByText("Share this code with the other device")).toBeVisible();
    await expect(appPage.getByRole("button", { name: "Copy code" })).toBeVisible();
    // Until a peer actually connects the card must say so - it used to claim
    // "Device connected! Ready to transfer." off a local flag that nothing
    // but the join request had set.
    await expect(appPage.getByText(/Waiting for the other device/)).toBeVisible();
    await expect(appPage.getByText("Drop files to send")).toBeHidden();
  });

  test("the join button stays disabled until six digits are entered", async ({ appPage }) => {
    await navigateTo(appPage, "/lan-transfer");

    const join = appPage.getByRole("button", { name: "Join" });
    await expect(join).toBeDisabled();

    await appPage.getByPlaceholder("6-digit code").fill("4829");
    await expect(join).toBeDisabled();

    await appPage.getByPlaceholder("6-digit code").fill("482917");
    await expect(join).toBeEnabled();
  });
});
