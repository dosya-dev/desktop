import { test, expect } from "../fixtures";

// Search is the highest-intent path to a file. These pin the two contracts
// the page used to break: typing must search without a secret Enter press,
// and a result must be a real, keyboard-reachable control that goes somewhere.
test("typing searches without Enter, and a file result navigates", async ({ appPage }) => {
  await appPage.evaluate(() => {
    window.location.hash = "#/search";
  });
  await appPage.waitForTimeout(400);

  await appPage.locator('input[placeholder*="Search"]').fill("report");
  // Debounced live search: results must arrive with no Enter press.
  await appPage.waitForSelector("text=/result/", { timeout: 5_000 });

  const row = appPage.getByRole("button", { name: /Project Report/ }).first();
  await expect(row).toBeVisible();
  await row.click();
  await appPage.waitForFunction(
    () => window.location.hash.includes("/files"),
    { timeout: 5_000 },
  );
});

test("search results are reachable by keyboard", async ({ appPage }) => {
  await appPage.evaluate(() => {
    window.location.hash = "#/search?q=report";
  });
  await appPage.waitForSelector("text=/result/", { timeout: 5_000 });

  // Tab from the input must land on result buttons, not skip past divs.
  await appPage.locator('input[placeholder*="Search"]').focus();
  let reachedResult = false;
  for (let i = 0; i < 15; i++) {
    await appPage.keyboard.press("Tab");
    const name = await appPage.evaluate(
      () => document.activeElement?.textContent ?? "",
    );
    if (/Project Report/.test(name)) {
      reachedResult = true;
      break;
    }
  }
  expect(reachedResult).toBe(true);
});
