import { test, expect } from "../fixtures";

// The sidebar renders a Cmd K / Ctrl+K chip next to Search and the Search page
// says "Press it anywhere". This spec pins the promise: the shortcut must
// navigate to /search from any authenticated screen.
test("Cmd/Ctrl+K jumps to search from the dashboard", async ({ appPage }) => {
  const combo = process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK";
  await appPage.keyboard.press(combo);
  await appPage.waitForFunction(
    () => window.location.hash.includes("/search"),
    { timeout: 5_000 },
  );
  expect(await appPage.evaluate(() => window.location.hash)).toContain("/search");
});

test("the shortcut also fires from a deep page", async ({ appPage }) => {
  await appPage.evaluate(() => {
    window.location.hash = "#/activity";
  });
  await appPage.waitForTimeout(500);
  const combo = process.platform === "darwin" ? "Meta+KeyK" : "Control+KeyK";
  await appPage.keyboard.press(combo);
  await appPage.waitForFunction(
    () => window.location.hash.includes("/search"),
    { timeout: 5_000 },
  );
});
