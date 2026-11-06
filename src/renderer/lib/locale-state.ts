import { intlTag, localeDir, type Locale } from "../../i18n/locales.ts";
import type { T } from "../../i18n/translator";

/**
 * The active UI language as a plain value, kept apart from lib/i18n.tsx (React,
 * catalogs) so modules that run under node:test can read it too. i18n.tsx
 * writes it on every switch.
 */
let active: Locale = "en";

export const setActiveLocale = (locale: Locale): void => {
  active = locale;
  activeDir = localeDir(locale);
};

let activeDir: "ltr" | "rtl" = "ltr";

/** The layout direction of the active language. */
export const getActiveDir = (): "ltr" | "rtl" => activeDir;

export const getActiveLocale = (): Locale => active;

/**
 * The locale to hand to Intl / toLocale*: English keeps the OS locale
 * (undefined), as before i18n, or `en` when a site pinned a fixed English
 * format such as "en-US"; every other language passes its code.
 */
export function intlLocale(en?: string): string | undefined {
  return active === "en" ? en : intlTag(active);
}

/**
 * The Intl tag for toLocale* calls that must change only in right-to-left
 * languages (so every LTR language keeps the OS-locale output it has today):
 * the language's tag when it is RTL, undefined otherwise.
 */
export function rtlIntlLocale(): string | undefined {
  return activeDir === "rtl" ? intlTag(active) : undefined;
}

/**
 * t() for plain modules that node:test loads (file-type, library-request,
 * folder-purge, file-columns): they cannot import i18n.tsx, which pulls in
 * React and the JSON catalogs. i18n.tsx registers its own `t` here when it
 * loads; a node:test file registers an English translator itself. Until one
 * is registered every key reads as itself, never as a crash.
 */
let translator: T = (key) => key;

export const setTranslator = (t: T): void => {
  translator = t;
};

/** Translates with whatever translator and locale are current at call time. */
export const tl: T = (key, values) => translator(key, values);
