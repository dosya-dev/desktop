import { test } from "node:test";
import assert from "node:assert/strict";
import { osDirection } from "./os-direction.ts";

/** Run with `npm run test:unit`. The OS UI direction from app.getLocale(). */

test("the locales Electron reports for a right-to-left Mac or Windows are rtl", () => {
  for (const l of ["ar", "he", "fa", "ur", "ar-SA", "he-IL", "fa_IR", "ps", "ckb", "yi", "iw"]) {
    assert.equal(osDirection(l), "rtl", l);
  }
});

test("left-to-right locales stay ltr", () => {
  for (const l of ["en", "en-GB", "en-US", "tr", "de", "zh-CN", "ja", "pt_BR", "es-419", "ru", "uk", "ku"]) {
    assert.equal(osDirection(l), "ltr", l);
  }
});

test("an explicit script decides", () => {
  assert.equal(osDirection("pa-Arab"), "rtl");
  assert.equal(osDirection("uz-Arab-AF"), "rtl");
  assert.equal(osDirection("ku-Latn"), "ltr");
  assert.equal(osDirection("az-Latn"), "ltr");
  assert.equal(osDirection("ar-Latn"), "ltr");
});

test("nothing usable is ltr", () => {
  for (const l of ["", "   ", undefined, null]) assert.equal(osDirection(l), "ltr", String(l));
});
