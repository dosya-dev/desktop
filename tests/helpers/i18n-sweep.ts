import { expect, type Page } from "@playwright/test";
import { readFileSync } from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { createTextMatcher, normalizeText, type TextMatcher } from "../../src/i18n/match.ts";
import { LOCALE_LABELS, type Locale } from "../../src/i18n/locales.ts";
import * as mockData from "./mock-data";

/**
 * Shared helpers for the per-screen language specs (tests/e2e/i18n-*.spec.ts).
 *
 * switchLanguage() changes the language the way a user does, through the
 * titlebar language menu. leftoverEnglish() then reads what is on screen and
 * returns every piece the English catalog recognises: text that should have
 * been translated and was not.
 *
 * The English comes from src/i18n/messages/en.json (the vendored catalog,
 * key -> source), not packages/i18n, because the public desktop mirror ships
 * without packages/.
 */

type Lang = Exclude<Locale, "en">;

const MESSAGES = path.join(__dirname, "../../src/i18n/messages");
const readJson = (file: string): Record<string, string> =>
  JSON.parse(readFileSync(path.join(MESSAGES, file), "utf8"));

/** Language names as LanguageMenu lists them (each in its own language). */
const NAMES: Record<Locale, string> = LOCALE_LABELS;

/**
 * Names that stay the same in every language: packages/i18n/glossary/do-not-translate.txt,
 * copied because the mirror has no packages/.
 */
const DO_NOT_TRANSLATE = new Set([
  "dosya", "dosya.dev", "Vault", "S3", "SFTP", "WebDAV", "FTP", "rclone", "Cyberduck",
  "Dropbox", "Google Drive", "OneDrive", "iCloud", "Lightroom", "WordPress", "Zapier",
  "n8n", "MCP", "API", "OAuth", "TOTP", "E2EE", "GB", "TB", "MB", "KB",
]);

/** The English catalog sources, normalized: text the sweep must never excuse on its own. */
const ENGLISH_SOURCES: Set<string> = new Set(Object.values(readJson("en.json")).map(normalizeText));

/**
 * Mock fields that hold user content or server-sent text (people, workspaces,
 * files, folders, notification text). Enum-like fields (kind, status, role,
 * resource_type) are left out: their values are not what the user typed.
 */
const USER_FIELDS = new Set([
  "name", "email", "title", "body", "message", "note", "label", "description",
  "file_name", "folder_name", "resource_name", "uploader_name", "user_name",
  "created_by_name", "actor_name", "icon_initials", "slug", "location",
]);

/**
 * User data from the mock server, minus anything that is also an English
 * catalog source: a mock folder named "Documents" must not hide a sidebar
 * row left reading "Documents". A screen that really shows such a value as
 * user data passes it to leftoverEnglish() in `allow`.
 */
const MOCK_STRINGS: Set<string> = (() => {
  const out = new Set<string>();
  const walk = (v: unknown, field: string | null, depth: number): void => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") {
      const n = normalizeText(v);
      if (n && field !== null && USER_FIELDS.has(field) && !ENGLISH_SOURCES.has(n)) out.add(n);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, field, depth + 1));
    else if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as object)) walk(x, k, depth + 1);
    }
  };
  walk(mockData, null, 0);
  return out;
})();

const matchers = new Map<Lang, TextMatcher>();
function matcherFor(lang: Lang): TextMatcher {
  let m = matchers.get(lang);
  if (!m) {
    const en = readJson("en.json");
    const strings = Object.entries(en).map(([key, source]) => ({ key, source }));
    m = createTextMatcher({ strings }, readJson(`${lang}.json`), lang);
    matchers.set(lang, m);
  }
  return m;
}

/** Picks `lang` in the titlebar language menu and waits for the app to switch. */
export async function switchLanguage(page: Page, lang: Lang | "en"): Promise<void> {
  await page.getByTestId("language-menu-button").first().click();
  await page.getByRole("menuitemradio", { name: NAMES[lang], exact: true }).click();
  await expect.poll(() => page.evaluate(() => document.documentElement.lang)).toBe(lang);
}

/**
 * English still on screen while the app is in `lang`.
 *
 * Reads every visible text node, the text of every visible text-bearing
 * element (so a sentence split across <strong> or a link is seen whole), and
 * the title, aria-label and placeholder of every visible element under
 * `root` (a CSS selector; every match is swept; default the whole page).
 * Skips anything inside translate="no" (keycaps, code), mock user data and
 * do-not-translate names, and text whose translation reads the same.
 * Returns what is left that the English catalog recognises, sorted and
 * de-duplicated; an empty array means nothing was missed. Mock user data
 * that equals an English catalog source is NOT skipped unless listed in
 * `opts.allow`.
 */
export interface SweepOptions {
  /** The language the app is in. Default "tr". */
  lang?: Lang;
  /**
   * Text this screen shows as user data although it equals an English
   * catalog source (a mock file named "Documents"). Exact, normalized match.
   */
  allow?: string[];
}

export async function leftoverEnglish(page: Page, root = "body", opts: SweepOptions = {}): Promise<string[]> {
  const seen: string[] = await page.evaluate((sel) => {
    const out: string[] = [];
    const visible = (el: Element): boolean => {
      const h = el as HTMLElement & { checkVisibility?: (o?: object) => boolean };
      if (h.checkVisibility && !h.checkVisibility({ visibilityProperty: true, opacityProperty: false })) return false;
      return el.getClientRects().length > 0;
    };
    const skipped = (el: Element): boolean => el.closest('[translate="no"]') !== null;
    const TEXT_TAGS = new Set(["P", "H1", "H2", "H3", "H4", "H5", "H6", "BUTTON", "LABEL", "DT", "DD", "LI", "A", "SPAN", "TD", "TH", "OPTION"]);
    for (const r of Array.from(document.querySelectorAll(sel))) {
      const walker = document.createTreeWalker(r, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const parent = n.parentElement;
        if (!parent || !n.textContent?.trim()) continue;
        if (parent.tagName === "SCRIPT" || parent.tagName === "STYLE") continue;
        if (skipped(parent) || !visible(parent)) continue;
        out.push(n.textContent);
      }
      for (const el of [r, ...Array.from(r.querySelectorAll("*"))]) {
        if (skipped(el) || !visible(el)) continue;
        if (TEXT_TAGS.has(el.tagName) && el.children.length > 0) {
          const text = (el as HTMLElement).innerText;
          if (text && text.length < 400) out.push(text);
        }
        for (const attr of ["title", "aria-label", "placeholder"]) {
          const v = el.getAttribute(attr);
          if (v) out.push(v);
        }
      }
    }
    return out;
  }, root);

  return filterLeftover(seen, opts);
}

/**
 * The decision half of leftoverEnglish(), with no page: which of `texts` are
 * English the catalog knows, after the user-data, do-not-translate and
 * `allow` exclusions.
 */
export function filterLeftover(texts: string[], { lang = "tr", allow = [] }: SweepOptions = {}): string[] {
  const matcher = matcherFor(lang);
  const allowed = new Set(allow.map(normalizeText));
  const left = new Set<string>();
  for (const raw of texts) {
    const text = normalizeText(raw);
    if (!text || allowed.has(text) || MOCK_STRINGS.has(text) || DO_NOT_TRANSLATE.has(text)) continue;
    const translated = matcher.translate(text);
    if (translated !== null && normalizeText(translated) !== text) left.add(text);
  }
  return [...left].sort();
}

/** Icon classes (lucide renders `lucide-<name>`) that point somewhere. A trailing `*` is a prefix. */
export const DIRECTIONAL_ICONS: readonly string[] = [
  "lucide-chevron-left",
  "lucide-chevron-right",
  "lucide-chevrons-left",
  "lucide-chevrons-right",
  "lucide-arrow-left",
  "lucide-arrow-right",
  "lucide-arrow-up-right",
  "lucide-corner-down-right",
  "lucide-reply",
  "lucide-send",
  "lucide-log-out",
  "lucide-log-in",
  "lucide-panel-left*",
  "lucide-panel-right*",
  "lucide-undo*",
  "lucide-redo*",
];

type Classify = (token: string) => { kind: string; centeringKey: string | null } | null;

/**
 * The codemod's token classifier, loaded natively: Playwright compiles specs
 * and helpers to CommonJS, which cannot import the ESM script statically, and
 * `new Function` keeps the import() from being rewritten to require().
 */
let classifyPromise: Promise<Classify> | null = null;
function loadClassify(): Promise<Classify> {
  classifyPromise ??= (
    new Function("url", "return import(url)") as (url: string) => Promise<{ classify: Classify }>
  )(pathToFileURL(path.join(__dirname, "../../scripts/rtl-codemod.mjs")).href).then((m) => m.classify);
  return classifyPromise;
}

/**
 * Physical-direction classes (ml-2, text-left, left-0 ...) on elements under
 * `root` (a CSS selector, every match; default the whole page) in the live
 * DOM. Subtrees under `[dir="ltr"]` are ignored, and so is a left-1/2 or
 * right-1/2 that sits with -translate-x-1/2 (a centering pair). Only classes
 * with a logical form are returned; translate-x and origin are not.
 */
export async function physicalClassesIn(page: Page, root = "body"): Promise<string[]> {
  const lists: string[][] = await page.evaluate((sel) => {
    const out: string[][] = [];
    for (const r of Array.from(document.querySelectorAll(sel))) {
      for (const el of [r, ...Array.from(r.querySelectorAll("*"))]) {
        if (el.closest('[dir="ltr"]')) continue;
        const classes = (el.getAttribute("class") ?? "").split(/\s+/).filter(Boolean);
        if (classes.length) out.push(classes);
      }
    }
    return out;
  }, root);
  const classify = await loadClassify();
  const out: string[] = [];
  for (const classes of lists) {
    const centered = classes.some((c) => classify(c)?.centeringKey === "translate");
    for (const c of classes) {
      const info = classify(c);
      if (!info || info.kind !== "convertible") continue;
      if (centered && info.centeringKey === "inset") continue;
      out.push(c);
    }
  }
  return out;
}

/**
 * Directional icons under `root` that do not flip in RTL: an SVG with a class
 * in DIRECTIONAL_ICONS and neither `rtl:-scale-x-100` nor `rtl:rotate-180`
 * (nor `rotate-90`, a disclosure chevron that points down), outside any
 * `[dir="ltr"]`. Returns the icon class of each offender.
 */
export async function unflippedIcons(page: Page, root = "body"): Promise<string[]> {
  const lists: string[][] = await page.evaluate((sel) => {
    const out: string[][] = [];
    for (const r of Array.from(document.querySelectorAll(sel))) {
      for (const svg of Array.from(r.querySelectorAll("svg"))) {
        if (svg.closest('[dir="ltr"]')) continue;
        out.push((svg.getAttribute("class") ?? "").split(/\s+/).filter(Boolean));
      }
    }
    return out;
  }, root);
  const directional = (cls: string): boolean =>
    DIRECTIONAL_ICONS.some((d) => (d.endsWith("*") ? cls.startsWith(d.slice(0, -1)) : cls === d));
  const out: string[] = [];
  for (const classes of lists) {
    const icon = classes.find(directional);
    if (!icon) continue;
    if (classes.includes("rtl:-scale-x-100") || classes.includes("rtl:rotate-180") || classes.includes("rotate-90")) continue;
    out.push(icon);
  }
  return out;
}

/** The bounding box of the first element matching `selector`, in viewport pixels. */
export async function boxOf(page: Page, selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`boxOf: no visible element matches ${selector}`);
  return box;
}

/** How far the page scrolls sideways past its viewport, in px (0 means no horizontal overflow). */
export async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(() => {
    const el = document.documentElement;
    return Math.max(0, el.scrollWidth - el.clientWidth);
  });
}
