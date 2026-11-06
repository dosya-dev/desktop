// Direction helpers for text the app did not write: file and person names
// inside a sentence, and server or engine messages shown in a toast.
//
// Both are no-ops in a left-to-right language, so the English DOM stays
// exactly as it was. Text from t() is already isolated in a right-to-left
// language: never pass it through these as well.
import { type ReactNode } from "react";
import { currentDir, translateExternal, translateIpcError, useDir } from "./i18n";

/**
 * A name inside a sentence the page builds itself ("2 MB · Sam · 3 days
 * ago"). In a right-to-left language it renders inside a <bdi> so its own
 * punctuation stays put; in every other language it is the bare text.
 * Never use it as a direct child of a flex row: a <bdi> there becomes its
 * own flex item and drops the spaces around it. dir="ltr" is for a path or
 * an address inside a sentence.
 */
export function Bdi({ children, dir }: { children: ReactNode; dir?: "ltr" }) {
  return useDir() === "rtl" ? <bdi dir={dir}>{children}</bdi> : <>{children}</>;
}

/**
 * One part of a line the page joins with " · " ("1.2 MB · application/zip ·
 * 1 March 2025"). In a right-to-left language it is its own isolated span,
 * so a day number cannot drift over to the size next to it; dir="ltr" is for
 * an identifier (a MIME type). In every other language it is the bare text.
 */
export function Part({ children, dir = "auto" }: { children: ReactNode; dir?: "auto" | "ltr" }) {
  return useDir() === "rtl" ? <span dir={dir}>{children}</span> : <>{children}</>;
}

/**
 * The dir attribute for text that takes its own direction (a name, the
 * server's or engine's words, user content): "auto" in a right-to-left
 * language, none otherwise, so every left-to-right language lays such text
 * out exactly as before (a Hebrew name in English keeps the page's base
 * direction).
 */
export function useAutoDir(): "auto" | undefined {
  return useDir() === "rtl" ? "auto" : undefined;
}

/** Isolates t() puts around arguments in a right-to-left language. */
const ISOLATES = /[\u2066-\u2069]/;

/**
 * Server or engine text for a sonner toast title or description: in a
 * right-to-left language it sits in a dir="auto" span, so an English error
 * reads left to right; otherwise the string itself. Read at call time, which
 * is when the toast is raised.
 *
 * Only for the raw text, never for t() output: dir="auto" finds its first
 * strong character inside an isolated argument, so an Arabic sentence that
 * starts with a Latin file name would lay out left to right. Text that
 * carries isolates is t() output and is returned as it is.
 */
export function autoDir<V extends string | null | undefined>(text: V): V | ReactNode {
  if (currentDir() !== "rtl" || !text || ISOLATES.test(text)) return text;
  return <span dir="auto">{text}</span>;
}

/**
 * An error that crossed IPC, for a toast: the catalog's translation follows
 * the page; engine text the catalog does not know takes its own direction;
 * nothing at all falls back to `fallback`.
 */
export function ipcErrorText(message: string | null | undefined, fallback: string): ReactNode {
  const raw = message ?? "";
  const shown = translateIpcError(raw);
  if (!shown) return fallback;
  return shown === raw ? autoDir(raw) : shown;
}

/**
 * The direction attribute for a block that shows translateExternal(text):
 * "auto" when the catalog does not know the text (the engine's own words),
 * none when it is translated (it follows the page). Decided at the source,
 * never by looking at the shown string. Empty text (the block falls back to
 * a t() string) gets none as well, and so does every left-to-right language.
 */
export function externalDir(text: string | null | undefined): "auto" | undefined {
  return currentDir() === "rtl" && text && translateExternal(text) === text ? "auto" : undefined;
}

/** A path for a toast description: in a right-to-left language it sits in a dir="ltr" span. */
export function ltrDir<V extends string | null | undefined>(text: V): V | ReactNode {
  if (currentDir() !== "rtl" || !text) return text;
  return <span dir="ltr">{text}</span>;
}

/**
 * "<name>: <text>" for a toast description. In a right-to-left language the
 * name is isolated and the text follows the page (a translation) or, when
 * `raw` (server or engine words), takes its own direction; elsewhere the
 * plain string.
 */
export function namedLine(name: string, text: string, raw = false): ReactNode {
  if (currentDir() !== "rtl") return `${name}: ${text}`;
  return <><bdi>{name}</bdi>: {raw ? autoDir(text) : text}</>;
}
