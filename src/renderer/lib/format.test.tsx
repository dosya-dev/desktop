// The format helpers keep their signatures and follow the chosen language.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider, currentLocale } from "./i18n";
import { formatBytes, formatDate, formatRelative, intlLocale } from "./format";
import { rtlIntlLocale } from "./locale-state";
import { formatters, t } from "./i18n";
import { humanSize, timeAgo } from "./file-type";
import type { Locale } from "../../i18n/locales";
import { createRoot } from "react-dom/client";
import { act, createElement } from "react";
import tr from "../../i18n/messages/tr.json";
import de from "../../i18n/messages/de.json";
import fr from "../../i18n/messages/fr.json";
import ar from "../../i18n/messages/ar.json";
import fa from "../../i18n/messages/fa.json";
import ja from "../../i18n/messages/ja.json";
import th from "../../i18n/messages/th.json";
import he from "../../i18n/messages/he.json";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function use(locale: Locale, messages?: Record<string, string>) {
  const el = document.createElement("div");
  const root = createRoot(el);
  act(() => root.render(createElement(I18nProvider, { initial: locale, initialMessages: messages, children: null })));
  expect(currentLocale()).toBe(locale);
  return () => act(() => root.unmount());
}

const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const sec = (agoSeconds: number) => NOW / 1000 - agoSeconds;

describe("under en", () => {
  let off: () => void;
  beforeEach(() => {
    off = use("en");
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
    off();
  });

  it("returns today's exact strings", () => {
    expect(intlLocale()).toBeUndefined();
    expect(humanSize(1536)).toBe("1.5 KB");
    expect(humanSize(null)).toBe("-");
    expect(formatBytes(5 * 1_099_511_627_776)).toBe("5.00 TB");
    const ts = 1_792_152_000;
    expect(formatDate(ts)).toBe(new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }));
    expect(formatRelative(sec(30))).toBe("just now");
    expect(formatRelative(sec(300))).toBe("5m ago");
    expect(formatRelative(sec(3 * 3600))).toBe("3h ago");
    expect(timeAgo(sec(2 * 86400))).toBe("2d ago");
    expect(timeAgo(null)).toBe("-");
  });
});

describe("under other languages", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("de: decimal comma and German month names", () => {
    const off = use("de", de);
    expect(intlLocale()).toBe("de");
    expect(humanSize(1536)).toBe("1,5 KB");
    expect(formatDate("2026-10-16T12:00:00Z")).toMatch(/Okt/);
    expect(timeAgo(sec(300))).toBe(de["common.label.minutesMAgo"].replace("{minutes}", "5"));
    off();
  });

  it("tr: timeAgo returns the catalog's Turkish words", () => {
    const off = use("tr", tr);
    expect(timeAgo(sec(30))).toBe("az önce");
    expect(timeAgo(sec(3 * 3600))).toBe("3\u00a0saat önce");
    expect(timeAgo(sec(2 * 86400))).toBe("2\u00a0gün önce");
    off();
  });

  it("fr: octets", () => {
    const off = use("fr", fr);
    expect(humanSize(1536)).toMatch(/^1,5\s?Ko$/);
    off();
  });
});

describe("right-to-left languages", () => {
  const WESTERN = /^[^\u0660-\u0669\u06F0-\u06F9]*$/;

  it("ar pins Western digits everywhere the app passes a locale", () => {
    const off = use("ar", ar);
    expect(intlLocale()).toBe("ar-u-nu-latn");
    expect(intlLocale("en-US")).toBe("ar-u-nu-latn");
    expect(formatDate("2026-10-16T12:00:00Z")).toMatch(/2026/);
    expect(formatDate("2026-10-16T12:00:00Z")).toMatch(WESTERN);
    expect(formatBytes(1536)).toMatch(WESTERN);
    expect(formatBytes(1536)).toMatch(/1[.,]5/);
    expect(formatters().formatNumber(1234567)).toMatch(WESTERN);
    // The ICU # inside a translated plural.
    expect(t("editor.label.copyName", { name: "n", count: 12 })).toContain("12");
    expect(t("editor.label.copyName", { name: "n", count: 12 })).toMatch(WESTERN);
    off();
  });

  it("fa keeps Intl defaults: Persian digits and the Solar Hijri year", () => {
    const off = use("fa", fa);
    expect(intlLocale()).toBe("fa");
    expect(formatDate("2026-10-16T12:00:00Z")).toMatch(/\u06F1\u06F4\u06F0\u06F5/);
    off();
  });

  it("he keeps Intl defaults", () => {
    const off = use("he", he);
    expect(intlLocale()).toBe("he");
    off();
  });

  it("rtlIntlLocale is undefined in every LTR language and the tag in ar, he and fa", () => {
    for (const [loc, msgs] of [["en", undefined], ["de", de], ["tr", tr], ["ja", ja], ["th", th]] as const) {
      const off = use(loc as Locale, msgs as Record<string, string> | undefined);
      expect(rtlIntlLocale()).toBeUndefined();
      off();
    }
    for (const [loc, msgs, tag] of [["ar", ar, "ar-u-nu-latn"], ["he", he, "he"], ["fa", fa, "fa"]] as const) {
      const off = use(loc as Locale, msgs as Record<string, string>);
      expect(rtlIntlLocale()).toBe(tag);
      off();
    }
  });
});
