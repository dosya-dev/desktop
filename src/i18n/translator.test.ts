import { test } from "node:test";
import assert from "node:assert/strict";

import { formatBytes, formatDate, formatNumber, formatRelative, makeT } from "./translator.ts";
import { isLocale, LOCALE_LABELS, LOCALES } from "./locales.ts";
import type { MessageKey } from "./keys.ts";
import { readFileSync } from "node:fs";

const readMessages = (name: string) =>
  JSON.parse(readFileSync(new URL(`./messages/${name}.json`, import.meta.url), "utf8")) as Record<string, string>;
const enMessages = readMessages("en");
const tEn = makeT("en", enMessages, enMessages);
const tTr = makeT("tr", readMessages("tr"), enMessages);

// Test keys that are not in the catalog are cast: makeT's lookup is by string.
const k = (s: string) => s as MessageKey;

test("a translated key returns the target message", () => {
  const t = makeT("tr", { "common.cancel": "İptal" }, { "common.cancel": "Cancel" });
  assert.equal(t("common.cancel"), "İptal");
});

test("a key missing in the target falls back to English", () => {
  const t = makeT("tr", {}, { "common.cancel": "Cancel" });
  assert.equal(t("common.cancel"), "Cancel");
});

test("a key missing everywhere returns the key and does not throw", () => {
  const t = makeT("tr", {}, {});
  assert.equal(t(k("nowhere.at.all")), "nowhere.at.all");
});

test("a broken target message falls back to English", () => {
  const t = makeT("tr", { x: "{oops" }, { x: "Fine" });
  assert.equal(t(k("x")), "Fine");
});

test("values are substituted literally, never parsed", () => {
  const t = makeT("en", { del: "Delete {name}?" }, { del: "Delete {name}?" });
  assert.equal(t(k("del"), { name: "{a} it's #1" }), "Delete {a} it's #1?");
});

test("a missing value leaves the placeholder text visible instead of throwing", () => {
  const t = makeT("en", {}, { del: "Delete {name}?" });
  assert.equal(t(k("del")), "Delete {name}?");
});

test("plurals pick the locale's category and format # for the locale", () => {
  const en = { files: "{count, plural, one {# file} other {# files}}" };
  const te = makeT("en", en, en);
  assert.equal(te(k("files"), { count: 0 }), "0 files");
  assert.equal(te(k("files"), { count: 1 }), "1 file");
  assert.equal(te(k("files"), { count: 2 }), "2 files");

  const tt = makeT("tr", { files: "{count, plural, other {# dosya}}" }, en);
  assert.equal(tt(k("files"), { count: 0 }), "0 dosya");
  assert.equal(tt(k("files"), { count: 1 }), "1 dosya");

  const td = makeT("de", { files: "{count, plural, one {# Datei} other {# Dateien}}" }, en);
  assert.equal(td(k("files"), { count: 1234 }), "1.234 Dateien");
});

test("=N branches and nested select inside plural", () => {
  const msg = { m: "{n, plural, =0 {Nothing} other {{kind, select, video {# videos} other {# items}}}}" };
  const t = makeT("en", msg, msg);
  assert.equal(t(k("m"), { n: 0, kind: "video" }), "Nothing");
  assert.equal(t(k("m"), { n: 3, kind: "video" }), "3 videos");
  assert.equal(t(k("m"), { n: 3, kind: "doc" }), "3 items");
});

test("formatBytes uses the locale's decimal separator and keeps English byte-identical", () => {
  assert.equal(formatBytes("de", 1536), "1,5 KB");
  assert.equal(formatBytes("en", 1536), "1.5 KB");
  assert.equal(formatBytes("en", 512), "512 B");
  assert.equal(formatBytes("en", 5 * 1_099_511_627_776), "5.00 TB");
  assert.equal(formatBytes("tr", 3 * 1_048_576 + 524_288), "3,5 MB");
});

test("formatNumber groups by locale", () => {
  assert.equal(formatNumber("de", 1234567), "1.234.567");
  assert.equal(formatNumber("en", 1234), (1234).toLocaleString(undefined));
});

// Today's English, copied from src/renderer/lib/format.ts so drift is caught.
function todayFormatDate(ts: number | string): string {
  const d = typeof ts === "number" ? new Date(ts * 1000) : new Date(ts);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

test("formatDate medium: Turkish month names, English byte-identical", () => {
  const iso = "2026-10-16T12:00:00Z";
  assert.match(formatDate("tr", iso, "medium"), /Eki/);
  assert.equal(formatDate("en", iso, "medium"), todayFormatDate(iso));
  const unix = 1_792_152_000; // seconds, as the API sends them
  assert.equal(formatDate("en", unix, "medium"), todayFormatDate(unix));
  assert.equal(formatDate("en", new Date(iso), "medium"), todayFormatDate(iso));
});

test("formatDate short and long are distinct presets", () => {
  const iso = "2026-10-16T12:00:00Z";
  assert.match(formatDate("de", iso, "long"), /Oktober/);
  assert.notEqual(formatDate("de", iso, "short"), formatDate("de", iso, "long"));
});

test("formatRelative English buckets match today's format.ts", () => {
  const nowMs = Date.UTC(2026, 9, 16, 12, 0, 0);
  const nowSec = nowMs / 1000;
  assert.equal(formatRelative("en", nowSec - 30, tEn, nowMs), "just now");
  assert.equal(formatRelative("en", nowSec - 5 * 60, tEn, nowMs), "5m ago");
  assert.equal(formatRelative("en", nowSec - 3 * 3600, tEn, nowMs), "3h ago");
  assert.equal(formatRelative("en", nowSec - 2 * 86400, tEn, nowMs), "2d ago");
  const old = nowSec - 30 * 86400;
  assert.equal(formatRelative("en", old, tEn, nowMs), todayFormatDate(old));
  assert.equal(formatRelative("en", new Date(nowMs - 30_000).toISOString(), tEn, nowMs), "just now");
});

test("formatRelative takes its words from the catalog keys", () => {
  const nowMs = Date.UTC(2026, 9, 16, 12, 0, 0);
  const nowSec = nowMs / 1000;
  assert.equal(formatRelative("tr", nowSec - 30, tTr, nowMs), "az önce");
  assert.equal(formatRelative("tr", nowSec - 5 * 60, tTr, nowMs), "5\u00a0dakika önce");
  assert.match(formatRelative("tr", nowSec - 30 * 86400, tTr, nowMs), /Eyl/);
});

test("formatBytes: French writes Ko/Mo/Go/To, others keep KB/MB/GB/TB", () => {
  assert.match(formatBytes("fr", 1536), /^1,5\s?Ko$/);
  assert.match(formatBytes("fr", 3 * 1_048_576), /Mo$/);
  assert.match(formatBytes("fr", 5 * 1_073_741_824), /Go$/);
  assert.match(formatBytes("fr", 2 * 1_099_511_627_776), /To$/);
  assert.match(formatBytes("fr", 512), /^512\so$/);
  assert.match(formatBytes("es", 1536), /KB$/);
});

test("locales", async () => {
  const { readFileSync } = await import("node:fs");
  const shipped = JSON.parse(readFileSync(new URL("./shipped.json", import.meta.url), "utf8")) as string[];
  // The list is computed by scripts/vendor-i18n.mjs; the 18 languages shipped before it stay, in order
  // (regional variants such as fr-CA sit right after the language they vary).
  const original = ["tr", "de", "fr", "es", "it", "pl", "pt-BR", "nl", "sv", "da", "nb", "fi", "cs", "ro", "hu", "el", "id", "vi"];
  assert.deepEqual([...LOCALES], ["en", ...shipped]);
  assert.deepEqual([...LOCALES].slice(0, 1 + original.length + 3).filter((l) => l === "en" || original.includes(l)), ["en", ...original]);
  for (const [variant, base] of [["fr-CA", "fr"], ["es-419", "es"], ["pt-PT", "pt-BR"]]) assert.equal(LOCALES.indexOf(variant as never), LOCALES.indexOf(base as never) + 1, variant);
  for (const rtl of ["ar", "he", "fa"]) assert.equal(isLocale(rtl), true);
  assert.equal(isLocale("ur"), false);
  assert.equal(isLocale("de"), true);
  assert.equal(isLocale("pt"), false);
  assert.equal(isLocale(undefined), false);
  assert.deepEqual(Object.keys(LOCALE_LABELS), [...LOCALES]);
  const own: Record<string, string> = { en: "English", tr: "Türkçe", de: "Deutsch", fr: "Français", es: "Español", it: "Italiano", pl: "Polski", "pt-BR": "Português (Brasil)", nl: "Nederlands",
    sv: "Svenska", da: "Dansk", nb: "Norsk bokmål", fi: "Suomi", cs: "Čeština", ro: "Română", hu: "Magyar",
    el: "Ελληνικά", id: "Bahasa Indonesia", vi: "Tiếng Việt", bg: "Български", sk: "Slovenčina", et: "Eesti", "zh-Hans": "简体中文", "zh-Hant": "繁體中文",
    sl: "Slovenščina", th: "ไทย", hr: "Hrvatski", lv: "Latviešu", lt: "Lietuvių", ja: "日本語", ko: "한국어", ar: "العربية", he: "עברית", fa: "فارسی",
    "pt-PT": "Português (Portugal)", uk: "Українська", sr: "Српски", ru: "Русский", "es-419": "Español (Latinoamérica)", "fr-CA": "Français (Canada)" };
  for (const l of LOCALES) assert.equal(LOCALE_LABELS[l], own[l]);
});

test("every vendored message parses and every key is in MessageKey", async () => {
  const { readFileSync } = await import("node:fs");
  const { parseIcu } = await import("./icu.ts");
  const read = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8")) as Record<string, string>;
  const keysSrc = readFileSync(new URL("./keys.ts", import.meta.url), "utf8");
  const declared = new Set([...keysSrc.matchAll(/^ {2}\| "([^"]+)";?$/gm)].map((m) => m[1]));
  const en = read("./messages/en.json");
  assert.deepEqual(new Set(Object.keys(en)), declared);
  for (const locale of LOCALES) {
    const messages = locale === "en" ? en : read(`./messages/${locale}.json`);
    for (const [key, message] of Object.entries(messages)) {
      assert.ok(declared.has(key), `${locale}: ${key} is not a MessageKey`);
      assert.doesNotThrow(() => parseIcu(message), `${locale}: ${key} does not parse`);
    }
  }
});

test("plurals for the added languages come from Intl.PluralRules", () => {
  const en = { files: "{count, plural, one {# file} other {# files}}" };
  const lt = makeT("lt", { files: "{count, plural, one {# failas} few {# failai} many {# failo} other {# failų}}" }, en);
  assert.equal(lt(k("files"), { count: 1 }), "1 failas");
  assert.equal(lt(k("files"), { count: 3 }), "3 failai");
  assert.equal(lt(k("files"), { count: 11 }), "11 failų");
  assert.equal(lt(k("files"), { count: 21 }), "21 failas");
  for (const locale of ["zh-Hans", "zh-Hant", "ko", "th", "ja"] as const) {
    const t = makeT(locale, { files: "{count, plural, other {# X}}" }, en);
    assert.equal(t(k("files"), { count: 1 }), "1 X");
    assert.equal(t(k("files"), { count: 5 }), "5 X");
  }
  assert.equal(formatNumber("zh-Hans", 1234567), "1,234,567");
  assert.equal(formatNumber("lt", 1234567).replace(/\s/g, " "), "1 234 567");
  assert.doesNotThrow(() => new Intl.DateTimeFormat("zh-Hant").format(new Date()));
});
