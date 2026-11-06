/**
 * The main process's view of the UI language: the current locale, a t() for
 * native menus and the tray, and the two IPC channels the renderer uses to
 * read and change it.
 */

import { isLocale, localeDir, type Locale } from "../i18n/locales";
import { isolate, makeDirectionalT } from "../i18n/bidi";
import { makeT, type Messages, type T } from "../i18n/translator";
import { createExternalTranslator, type RoleHint } from "../i18n/match";
import { readLocale, writeLocale } from "./locale-store";
import en from "../i18n/messages/en.json";
import { LOADERS } from "../i18n/loaders";

// English is bundled; every other language is its own chunk, loaded when
// chosen, so main holds English and the languages picked this session.
const loaded = new Map<Locale, Messages>([["en", en]]);

async function load(next: Locale): Promise<Messages> {
  const hit = loaded.get(next);
  if (hit) return hit;
  const messages = (await LOADERS[next as Exclude<Locale, "en">]()).default;
  loaded.set(next, messages);
  return messages;
}

let dir = "";
let locale: Locale = "en";
let messages: Messages = en;
let translate: T = makeT("en", en, en);
let plain: T = translate;
let direction: "ltr" | "rtl" = "ltr";
const listeners = new Set<(l: Locale) => void>();

const select = (next: Locale, catalog: Messages): void => {
  locale = next;
  messages = catalog;
  translate = makeDirectionalT(next, catalog, en);
  plain = makeT(next, catalog, en);
  direction = localeDir(next);
};

/** Loads the stored locale. Await before the first createMenu(). */
export async function initMainI18n(userDataDir: string): Promise<void> {
  dir = userDataDir;
  const stored = await readLocale(dir);
  try {
    select(stored, await load(stored));
  } catch (err) {
    // A chunk that will not load means a broken install; English still works.
    console.error(`[i18n] could not load ${stored}, using English:`, err);
    select("en", en);
  }
}

export const currentLocale = (): Locale => locale;

/** The layout direction of the current language. */
export const currentDir = (): "ltr" | "rtl" => direction;

/** Always formats with the current locale, so a held reference never goes stale. */
export const tMain: T = (key, values) => translate(key, values);

/**
 * tMain without isolates: for text that becomes data (file names, paths,
 * clipboard). No main-process sink needs it today (defaultPath, LAN and vault
 * save names come from sanitised names, never from a translation with
 * arguments); kept, and pinned isolate-free by i18n.test.ts, so the first
 * such sink has the right translator at hand instead of reaching for tMain.
 */
export const tMainPlain: T = (key, values) => plain(key, values);

const external = createExternalTranslator(en, undefined, {
  wrapPlainArg: (l) => (isLocale(l) && localeDir(l) === "rtl" ? isolate : undefined),
});

/**
 * Text main shows but does not author (the sync engine's messages) in the
 * current language: the translation when the English is a catalog message,
 * the text unchanged otherwise. Call it when building the native text, so it
 * follows a switch. Never for user content or server text.
 */
export const translateExternal = (text: string, hint?: RoleHint): string =>
  external(locale, messages, text, hint);

export function onMainLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let queue: Promise<void> = Promise.resolve();

/**
 * Validates, persists, switches and notifies. Calls run one at a time, so a
 * quick double click ends with the last choice in both memory and file. An
 * invalid value rejects before anything changes.
 */
export function setMainLocale(next: unknown): Promise<void> {
  if (!isLocale(next)) return Promise.reject(new Error("i18n:set-locale: unsupported locale"));
  const run = async (): Promise<void> => {
    // Load first: a language that cannot load is not saved as the choice.
    const catalog = await load(next);
    await writeLocale(dir, next);
    select(next, catalog);
    for (const fn of listeners) {
      try {
        fn(next);
      } catch (err) {
        console.error("[i18n] locale listener failed:", err);
      }
    }
  };
  const result = queue.then(run);
  queue = result.catch(() => {});
  return result;
}

type Handle = (channel: string, fn: (event: unknown, ...args: any[]) => unknown) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

/** `handle` is the gate's, so both channels refuse foreign senders. */
export function registerI18nIpc(handle: Handle): void {
  handle("i18n:get-locale", () => locale);
  handle("i18n:set-locale", (_event, next: unknown) => setMainLocale(next));
}
