/**
 * The direction of the operating system's own UI, which decides the side the
 * OS draws the window buttons on: macOS puts the traffic lights on the right
 * when the app runs in a right-to-left localization, and Chromium mirrors the
 * Windows caption overlay with its UI language. This is not the app's chosen
 * language (the renderer's `dir`): an English app on an Arabic Mac still has
 * the lights on the right.
 *
 * Fed `app.getLocale()`. On macOS that is the localization Cocoa picked from
 * the user's preferred languages and the bundle's .lproj folders, the same
 * choice AppKit makes the window's layout direction from (an unsupported first
 * language such as Pashto falls through to the next one, as AppKit does);
 * `getPreferredSystemLanguages()` would report Pashto and get that case wrong.
 * On Windows it is the UI locale Chromium lays its own views out in. Pure: no
 * Electron import.
 */

/** Scripts written right to left (ISO 15924, lower case). */
const RTL_SCRIPTS = new Set(["arab", "hebr", "thaa", "syrc", "nkoo", "adlm", "rohg", "mand", "samr"]);

/** Languages whose default script is right to left. */
const RTL_LANGUAGES = new Set([
  "ar", "he", "iw", "fa", "ur", "ps", "sd", "ug", "yi", "ji", "dv", "ckb", "syr", "prs", "pnb", "lrc", "mzn", "glk", "bal", "ks", "arc",
]);

export function osDirection(locale: string | undefined | null): "ltr" | "rtl" {
  const parts = (locale ?? "").trim().toLowerCase().replace(/_/g, "-").split("-").filter(Boolean);
  if (!parts.length) return "ltr";
  // An explicit script decides it (ku-Latn is left to right, pa-Arab right to left).
  const script = parts.slice(1).find((p) => /^[a-z]{4}$/.test(p));
  if (script) return RTL_SCRIPTS.has(script) ? "rtl" : "ltr";
  return RTL_LANGUAGES.has(parts[0]) ? "rtl" : "ltr";
}
