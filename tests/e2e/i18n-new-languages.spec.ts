import { readFileSync } from "fs";
import path from "path";
import { test, expect, navigateTo, electronAppFor } from "../fixtures";
import { switchLanguage, leftoverEnglish } from "../helpers/i18n-sweep";
import { LOCALES, LOCALE_LABELS } from "../../src/i18n/locales";

/**
 * Every language added after Turkish. The per-screen specs prove
 * the wiring in Turkish; this one proves each of these languages is picked
 * up end to end: chosen in the titlebar menu, its catalog loads, the shell,
 * the Appearance tab and the native menu bar switch, and nothing the
 * catalog knows is left in English. Expected text is read from the vendored
 * catalogs so a later wording change does not break the test.
 */

const MESSAGES = path.join(__dirname, "../../src/i18n/messages");
const PAGE = "[data-testid=profile-page]";

const LANGS = ["it", "pl", "pt-BR", "nl", "sv", "da", "nb", "fi", "cs", "ro", "hu", "el", "id", "vi"] as const;

for (const lang of LANGS) {
  const m: Record<string, string> = JSON.parse(readFileSync(path.join(MESSAGES, `${lang}.json`), "utf8"));

  test.describe(`app in ${lang}`, () => {
    test("shell and native menu bar", async ({ appPage: page }) => {
      await switchLanguage(page, lang);

      await expect(page.getByTestId("nav-dashboard")).toHaveText(m["common.label.dashboard"]);
      expect(await leftoverEnglish(page, "aside", { lang })).toEqual([]);
      expect(await leftoverEnglish(page, "[data-testid=titlebar]", { lang })).toEqual([]);

      const labels = await electronAppFor(page).evaluate(({ Menu }) =>
        (Menu.getApplicationMenu()?.items ?? []).map((i) => i.label),
      );
      expect(labels).toContain(m["menus.label.file.menu"]);
      expect(labels).toContain(m["menus.heading.edit.menu"]);
    });

    test("Appearance tab and its language field", async ({ appPage: page }) => {
      await navigateTo(page, "/profile");
      await switchLanguage(page, lang);
      await page.locator(PAGE).getByRole("button", { name: m["common.label.appearance"], exact: true }).click();

      const root = page.locator(PAGE);
      await expect(root.getByRole("heading", { name: m["common.label.appearance"] })).toBeVisible();
      await expect(page.getByTestId("language-field-button")).toContainText(LOCALE_LABELS[lang]);
      expect(await leftoverEnglish(page, PAGE, { lang })).toEqual([]);
      await page.getByTestId("language-field-button").click();
      await expect(root.getByRole("menuitemradio")).toHaveCount(LOCALES.length);
      await expect(root.getByRole("menuitemradio", { name: LOCALE_LABELS[lang] })).toHaveAttribute("aria-checked", "true");
    });
  });
}
