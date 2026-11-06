/**
 * The translator runtime: t() over the vendored catalogs, plus the locale
 * aware formatters for dates, numbers, sizes and relative times.
 *
 * Pure: no React, no Electron, no catalog import. The caller passes the
 * messages (src/i18n/messages/<locale>.json), so the renderer and the main
 * process each load only what they need.
 *
 * English stays byte-identical to the app before i18n: for locale "en" every
 * Intl / toLocale* call gets `undefined` (the OS locale), exactly as
 * src/renderer/lib/format.ts does, and sizes keep packages/shared's toFixed
 * output.
 */

import { parseIcu, renderIcu, type IcuNode } from "./icu.ts";
import type { MessageKey } from "./keys.ts";
import type { Locale } from "./locales.ts";

export type Messages = Record<string, string>;
export type T = (key: MessageKey, values?: Record<string, string | number>) => string;

/** The locale handed to Intl: "en" means the OS locale, as before i18n. */
const INTL_TAGS: Record<string, string> = { ar: "ar-u-nu-latn" };
const intlLocale = (locale: Locale): string | undefined => (locale === "en" ? undefined : (INTL_TAGS[locale] ?? locale));

const numberFormats = new Map<Locale, Intl.NumberFormat>();
const numberFormat = (locale: Locale): Intl.NumberFormat => {
  let nf = numberFormats.get(locale);
  if (!nf) {
    nf = new Intl.NumberFormat(intlLocale(locale));
    numberFormats.set(locale, nf);
  }
  return nf;
};

/**
 * Builds t() for one locale. A key missing from `messages` (or one whose
 * message does not parse) falls back to `english`; a key missing from both
 * returns the key itself. Values are substituted as plain text, never parsed
 * as ICU. Each message is parsed once, on first use.
 */
export function makeT(locale: Locale, messages: Messages, english: Messages): T {
  // Plural categories follow the message's language. English messages keep
  // English rules even when the OS locale is something else.
  const rules = new Intl.PluralRules(locale);
  const enRules = locale === "en" ? rules : new Intl.PluralRules("en");
  const nf = numberFormat(locale);
  const cache = new Map<string, { nodes: IcuNode[]; rules: Intl.PluralRules } | string>();

  const compile = (key: string): { nodes: IcuNode[]; rules: Intl.PluralRules } | string => {
    const own = messages[key];
    if (own !== undefined) {
      try {
        return { nodes: parseIcu(own), rules };
      } catch {
        /* a broken translation falls back to English */
      }
    }
    const en = english[key];
    if (en === undefined) return key;
    try {
      return { nodes: parseIcu(en), rules: enRules };
    } catch {
      return en;
    }
  };

  return (key, values) => {
    let entry = cache.get(key);
    if (entry === undefined) {
      entry = compile(key);
      cache.set(key, entry);
    }
    if (typeof entry === "string") return entry;
    return renderIcu(entry.nodes, values ?? {}, entry.rules, nf);
  };
}

/** Numbers are Unix seconds (as the API sends them), strings are ISO dates. */
type DateInput = number | string | Date;

const toDate = (value: DateInput): Date =>
  value instanceof Date ? value : typeof value === "number" ? new Date(value * 1000) : new Date(value);

const DATE_STYLES: Record<"short" | "medium" | "long", Intl.DateTimeFormatOptions> = {
  short: { year: "numeric", month: "numeric", day: "numeric" },
  // "medium" is today's formatDate in src/renderer/lib/format.ts.
  medium: { month: "short", day: "numeric", year: "numeric" },
  long: { month: "long", day: "numeric", year: "numeric" },
};

export function formatDate(locale: Locale, value: DateInput, style: "short" | "medium" | "long"): string {
  return toDate(value).toLocaleDateString(intlLocale(locale), DATE_STYLES[style]);
}

export function formatNumber(locale: Locale, n: number): string {
  return numberFormat(locale).format(n);
}

const KB = 1024;
const MB = 1_048_576;
const GB = 1_073_741_824;
const TB = 1_099_511_627_776;

/** French writes octets: Ko, Mo, Go, To. Every other language keeps B, KB, MB, GB, TB. */
const FR_UNITS = { B: "o", KB: "Ko", MB: "Mo", GB: "Go", TB: "To" };
const EN_UNITS = { B: "B", KB: "KB", MB: "MB", GB: "GB", TB: "TB" };

/** One formatter per (locale, fraction digits), like numberFormat above. */
const fixedFormats = new Map<string, Intl.NumberFormat>();
const fixedFormat = (locale: Locale, digits: number): Intl.NumberFormat => {
  const key = `${locale}:${digits}`;
  let nf = fixedFormats.get(key);
  if (!nf) {
    nf = new Intl.NumberFormat(intlLocale(locale), { minimumFractionDigits: digits, maximumFractionDigits: digits });
    fixedFormats.set(key, nf);
  }
  return nf;
};

/** packages/shared formatBytes, with the locale's decimal separator and unit names. */
export function formatBytes(locale: Locale, bytes: number): string {
  const u = locale === "fr" ? FR_UNITS : EN_UNITS;
  const fixed = (n: number, digits: number): string =>
    locale === "en" ? n.toFixed(digits) : fixedFormat(locale, digits).format(n);
  if (bytes < KB) return `${locale === "en" ? bytes : formatNumber(locale, bytes)} ${u.B}`;
  if (bytes < MB) return `${fixed(bytes / KB, 1)} ${u.KB}`;
  if (bytes < GB) return `${fixed(bytes / MB, 1)} ${u.MB}`;
  if (bytes < TB) return `${fixed(bytes / GB, 1)} ${u.GB}`;
  return `${fixed(bytes / TB, 2)} ${u.TB}`;
}

/**
 * Relative time: "just now", "5m ago", "3h ago", "2d ago", then a medium date.
 * The words come from the common.label.* catalog keys through `t`. `now` is in
 * milliseconds, like Date.now().
 */
export function formatRelative(locale: Locale, value: DateInput, t: T, now: number = Date.now()): string {
  const diff = now - toDate(value).getTime();
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return t("common.label.justNow");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("common.label.minutesMAgo", { minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("common.label.hoursHAgo", { hours });
  const days = Math.floor(hours / 24);
  if (days < 7) return t("common.label.daysDAgo", { days });
  return formatDate(locale, value, "medium");
}
