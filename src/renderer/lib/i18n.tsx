import { useEffect, useRef, useSyncExternalStore, type ReactNode } from "react";
import { isLocale, localeDir, type Locale } from "../../i18n/locales";
import { isolate, makeDirectionalT } from "../../i18n/bidi";
import {
  formatBytes,
  formatDate,
  formatNumber,
  formatRelative,
  makeT,
  type Messages,
  type T,
} from "../../i18n/translator";
import { createExternalTranslator, type RoleHint } from "../../i18n/match";
import { LOADERS } from "../../i18n/loaders";
import en from "../../i18n/messages/en.json";
import { setActiveLocale, setTranslator } from "./locale-state";

/**
 * The renderer's UI language.
 *
 * One module-level store holds the current locale and its translator. React
 * reads it through useT()/useLocale() (useSyncExternalStore, so every
 * consumer re-renders in place on a switch, portalled dialogs included);
 * plain modules use the exported `t`, which always translates with the
 * current locale, and onLocaleChange() when they cache text.
 *
 * The main process owns the choice: setLocale() persists it over IPC first
 * and only then switches here. English is bundled; every other language is
 * its own chunk, loaded on demand. While one loads the previous language
 * stays on screen, then the whole app switches at once.
 */

const english: Messages = en;

/** The messages for `locale`: English is already here, the rest load as chunks. */
export async function loadMessages(locale: Locale): Promise<Messages> {
  if (locale === "en") return english;
  return (await LOADERS[locale]()).default;
}

/** The starting language's messages; English if its chunk cannot be loaded. */
export async function loadStartupMessages(locale: Locale): Promise<{ locale: Locale; messages: Messages }> {
  try {
    return { locale, messages: await loadMessages(locale) };
  } catch (err) {
    console.error("[i18n] could not load", locale, "- starting in English:", err);
    return { locale: "en", messages: english };
  }
}

interface Snapshot {
  locale: Locale;
  /** Layout direction of `locale`. */
  dir: "ltr" | "rtl";
  /** Isolates plain string arguments in right-to-left languages: for text that is displayed. */
  t: T;
  /** The same messages, never isolated: for names, paths and anything that becomes data. */
  tPlain: T;
  messages: Messages;
}

let snapshot: Snapshot = {
  locale: "en",
  dir: "ltr",
  t: makeT("en", english, english),
  tPlain: makeT("en", english, english),
  messages: english,
};
const subscribers = new Set<() => void>();
const listeners = new Set<(l: Locale) => void>();
// Bumped by every switch request, so a slow load never lands after a newer one.
let generation = 0;
// The language a setLocale() call is still switching to, if any.
let pending: Locale | null = null;

function activate(locale: Locale, messages: Messages): void {
  const changed = locale !== snapshot.locale;
  const dir = localeDir(locale);
  snapshot = {
    locale,
    dir,
    t: makeDirectionalT(locale, messages, english),
    tPlain: makeT(locale, messages, english),
    messages,
  };
  setActiveLocale(locale);
  // lang and dir change together, before anything re-renders, so no frame
  // shows one language in the other's direction.
  if (typeof document !== "undefined") {
    document.documentElement.lang = locale;
    document.documentElement.dir = dir;
  }
  for (const fn of subscribers) fn();
  if (!changed) return;
  for (const fn of listeners) {
    try {
      fn(locale);
    } catch (err) {
      console.error("[i18n] locale listener failed:", err);
    }
  }
}

const subscribe = (fn: () => void): (() => void) => {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
};
const getSnapshot = (): Snapshot => snapshot;

/** Translates with whatever locale is current at call time. */
export const t: T = (key, values) => snapshot.t(key, values);
/** Translates without isolates: for file names, paths, API bodies and the clipboard. */
export const tPlain: T = (key, values) => snapshot.tPlain(key, values);
// Plain modules that cannot import this file translate through locale-state.
setTranslator(t);

const external = createExternalTranslator(english, undefined, {
  wrapPlainArg: (l) => (isLocale(l) && localeDir(l) === "rtl" ? isolate : undefined),
});

/**
 * Text the app shows but does not author (the sync engine's messages, the
 * book reader's library errors) in the current language: the translation
 * when the English is a catalog message, the text unchanged otherwise. Call
 * it at render, in a component that re-renders on a switch (useT), so it
 * follows the language. Never for user content or server text.
 */
export function translateExternal(text: string, hint?: RoleHint): string {
  return external(snapshot.locale, snapshot.messages, text, hint);
}

// Electron wraps an error thrown by an ipcMain handler before the renderer
// sees it: "Error invoking remote method 'sync:add-pair': Error: <message>".
const IPC_WRAPPER = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?([\s\S]*)$/;

/**
 * translateExternal for an error message that crossed IPC: the engine's
 * sentence inside Electron's wrapper is translated and shown without the
 * wrapper. Untranslated (English, or text the catalog does not know) it comes
 * back exactly as given.
 */
export function translateIpcError(message: string): string {
  const inner = IPC_WRAPPER.exec(message)?.[1];
  if (inner === undefined) return translateExternal(message);
  const translated = translateExternal(inner);
  return translated === inner ? message : translated;
}

/** The current locale, for code outside React. */
export const currentLocale = (): Locale => snapshot.locale;

/** The layout direction of the current language, for code outside React. */
export const currentDir = (): "ltr" | "rtl" => snapshot.dir;

/** Called after each switch. Returns the unsubscribe. */
export function onLocaleChange(fn: (l: Locale) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The Task 1 formatters, each call using the locale current at that moment. */
export function formatters() {
  return {
    formatDate: (value: Parameters<typeof formatDate>[1], style: Parameters<typeof formatDate>[2]) =>
      formatDate(snapshot.locale, value, style),
    formatNumber: (n: number) => formatNumber(snapshot.locale, n),
    formatBytes: (bytes: number) => formatBytes(snapshot.locale, bytes),
    formatRelative: (value: Parameters<typeof formatRelative>[1], now?: number) =>
      formatRelative(snapshot.locale, value, snapshot.t, now),
  };
}

/** Loads `locale` and switches to it, unless a newer request came in meanwhile. */
async function switchTo(locale: Locale, mine: number): Promise<void> {
  const messages = await loadMessages(locale);
  if (mine === generation) activate(locale, messages);
}

/**
 * Persists `locale` in the main process, then switches the app. Picking the
 * language already shown, with no switch pending, does nothing. Picking it
 * while another switch is still loading cancels that switch and tells main,
 * so both end on the last click. If main refuses, the old language stays; if the messages fail to load, main is told the old language again.
 */
async function setLocale(locale: Locale): Promise<void> {
  if (!isLocale(locale) || locale === (pending ?? snapshot.locale)) return;
  const mine = ++generation;
  pending = locale;
  try {
    await window.electronAPI.setLocale(locale);
    try {
      await switchTo(locale, mine);
    } catch (err) {
      // The window keeps the language it shows; main goes back to it too, so
      // its menus and the stored choice (the next launch) match the window.
      if (mine === generation) await window.electronAPI.setLocale(snapshot.locale).catch(() => {});
      throw err;
    }
  } finally {
    if (mine === generation) pending = null;
  }
}

/**
 * Sets the starting language. main.tsx resolves the stored locale and loads
 * its messages before the first render, so a non-English start never shows
 * an English frame; without `initialMessages` the messages load here and
 * English shows until they arrive.
 */
export function I18nProvider({
  initial,
  initialMessages,
  children,
}: {
  initial: Locale;
  initialMessages?: Messages;
  children: ReactNode;
}) {
  const primed = useRef(false);
  if (!primed.current) {
    primed.current = true;
    generation++;
    if (initial === "en") activate("en", english);
    else if (initialMessages) activate(initial, initialMessages);
  }
  useEffect(() => {
    if (initial !== "en" && !initialMessages && snapshot.locale !== initial) {
      void switchTo(initial, generation).catch((err) => console.error("[i18n] could not load", initial, err));
    }
  }, [initial, initialMessages]);
  return <>{children}</>;
}

/** t() for the current locale; the component re-renders when it changes. */
export function useT(): T {
  return useSyncExternalStore(subscribe, getSnapshot).t;
}

/** The layout direction of the current language; the component re-renders when it changes. */
export function useDir(): "ltr" | "rtl" {
  return useSyncExternalStore(subscribe, getSnapshot).dir;
}

export function useLocale(): { locale: Locale; setLocale(l: Locale): Promise<void> } {
  const { locale } = useSyncExternalStore(subscribe, getSnapshot);
  return { locale, setLocale };
}
