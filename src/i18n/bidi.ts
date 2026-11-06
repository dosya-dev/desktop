/**
 * Bidirectional isolation for translated messages.
 *
 * In a right-to-left language a Latin file name or an English server message
 * dropped into a sentence would reorder its punctuation. makeDirectionalT wraps
 * each plain string argument in a first-strong isolate so it keeps its own
 * order. Pure: no React, no Electron, loadable by node:test.
 *
 * Three rules, learned on the web programme:
 *  - Only right-to-left locales isolate. Every other language renders exactly
 *    as makeT does.
 *  - Never isolate a value that picks a select or plural branch: an isolated
 *    "yes" would match no branch.
 *  - Never use this t() for text that is sent to a server or written to disk
 *    (file names, "Save as copy"): use the plain translator.
 */

import { parseIcu, type IcuNode } from "./icu.ts";
import { makeT, type Messages, type T } from "./translator.ts";
import { localeDir, type Locale } from "./locales.ts";

/** First strong isolate and pop directional isolate: keep a substituted value's own direction. */
const FSI = "⁨";
const PDI = "⁩";

/** Wraps `s` so it keeps its own direction inside a right-to-left sentence. Empty stays empty. */
export const isolate = (s: string): string => (s === "" ? s : FSI + s + PDI);

/** Removes the directional marks and isolates (U+200E, U+200F, U+2066 to U+2069) and nothing else. */
export const stripBidi = (s: string): string => s.replace(/[‎‏⁦-⁩]/g, "");

/**
 * The names a message substitutes as plain text ({name}, {n, number}), which
 * never steer a select or plural. A name that picks a branch anywhere in the
 * message is left out: its value must reach the selector exactly as given.
 */
function simpleArgs(nodes: IcuNode[]): Set<string> {
  const plain = new Set<string>();
  const choosers = new Set<string>();
  const walk = (list: IcuNode[]) => {
    for (const n of list) {
      if (typeof n === "string" || n.type === "pound") continue;
      if (n.type === "arg") plain.add(n.name);
      else {
        choosers.add(n.name);
        for (const branch of Object.values(n.options)) walk(branch);
      }
    }
  };
  walk(nodes);
  for (const name of choosers) plain.delete(name);
  return plain;
}

/** Parses `src`, or undefined when it is missing or broken (makeT then falls back). */
const tryParse = (src: string | undefined): IcuNode[] | undefined => {
  if (src === undefined) return undefined;
  try {
    return parseIcu(src);
  } catch {
    return undefined;
  }
};

/** makeT, plus isolation of plain string arguments in right-to-left languages. */
export function makeDirectionalT(locale: Locale, messages: Messages, english: Messages): T {
  const base = makeT(locale, messages, english);
  if (localeDir(locale) !== "rtl") return base;
  // Parsed once per key, from the same message makeT renders: the
  // translation, or English when the translation is missing or broken.
  const plainArgs = new Map<string, Set<string>>();
  const plainFor = (key: string): Set<string> => {
    let names = plainArgs.get(key);
    if (!names) {
      const nodes = tryParse(messages[key]) ?? tryParse(english[key]);
      names = nodes ? simpleArgs(nodes) : new Set();
      plainArgs.set(key, names);
    }
    return names;
  };
  return (key, values) => {
    if (!values) return base(key, values);
    const plain = plainFor(key);
    const out: Record<string, string | number> = {};
    for (const [k, v] of Object.entries(values)) {
      out[k] = typeof v === "string" && plain.has(k) ? isolate(v) : v;
    }
    return base(key, out);
  };
}
