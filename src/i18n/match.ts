/**
 * Rendered English in, rendered target text out. Given the English catalog
 * and one language's messages, createTextMatcher recognises text the app has
 * already rendered in English (plurals, arguments and all) and produces the
 * same text in the target language. Text it cannot match is left alone.
 *
 * Used by the dev preview overlay and the menu preview today, and by the e2e
 * sweeps that look for English left on screen after the app switches language.
 */

import { formatIcu, parseIcu, UNKNOWN, type ArgValue, type IcuNode } from "./icu.ts";
import { EXTERNAL_KEYS } from "./external-keys.ts";

type Part = string | { cap: string; num: boolean };

interface Variant {
  parts: Part[];
  bind: Record<string, ArgValue>;
}

const MAX_VARIANTS = 512;

/** Every concrete shape the English message can render as. */
function expand(nodes: IcuNode[], pluralArg: string | null): Variant[] {
  let acc: Variant[] = [{ parts: [], bind: {} }];
  const append = (vs: Variant[]) => {
    const next: Variant[] = [];
    for (const a of acc) {
      for (const v of vs) {
        // One argument cannot take two different values in one rendering.
        let clash = false;
        for (const [k, val] of Object.entries(v.bind)) {
          if (k in a.bind && a.bind[k] !== val && a.bind[k] !== UNKNOWN && val !== UNKNOWN) clash = true;
        }
        if (clash) continue;
        next.push({ parts: [...a.parts, ...v.parts], bind: { ...a.bind, ...v.bind } });
        if (next.length > MAX_VARIANTS) throw new Error("too many variants");
      }
    }
    acc = next;
  };
  for (const n of nodes) {
    if (typeof n === "string") append([{ parts: [n], bind: {} }]);
    else if (n.type === "arg") append([{ parts: [{ cap: n.name, num: false }], bind: {} }]);
    else if (n.type === "pound") append([{ parts: [{ cap: pluralArg ?? "#", num: true }], bind: {} }]);
    else if (n.type === "select") {
      const vs: Variant[] = [];
      for (const [key, branch] of Object.entries(n.options)) {
        for (const v of expand(branch, pluralArg)) {
          vs.push({ parts: v.parts, bind: { ...v.bind, [n.name]: key === "other" ? UNKNOWN : key } });
        }
      }
      append(vs);
    } else {
      const vs: Variant[] = [];
      for (const [key, branch] of Object.entries(n.options)) {
        const sub = expand(branch, n.name);
        for (const v of sub) {
          const hasPound = v.parts.some((p) => typeof p !== "string" && p.num && p.cap === n.name);
          let value: ArgValue = UNKNOWN;
          if (key.startsWith("=")) value = Number(key.slice(1));
          else if (key === "one" && !hasPound) value = 1;
          vs.push({ parts: v.parts, bind: hasPound ? v.bind : { ...v.bind, [n.name]: value } });
        }
      }
      append(vs);
    }
  }
  return acc;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

interface Pattern {
  re: RegExp;
  caps: { name: string; num: boolean }[];
  bind: Record<string, ArgValue>;
  /** Longest literal run, used to skip patterns cheaply. */
  anchor: string;
  target: IcuNode[];
  /** Plain {name} arguments of the target, computed on first use. */
  plain?: Set<string>;
}

export function normalizeText(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

function compilePattern(v: Variant, target: IcuNode[], strict: boolean): Pattern | null {
  // Merge adjacent literals, then refuse patterns with too little literal
  // text: "{count}" alone would match every number on screen.
  const parts: Part[] = [];
  for (const p of v.parts) {
    const last = parts[parts.length - 1];
    if (typeof p === "string" && typeof last === "string") parts[parts.length - 1] = last + p;
    else parts.push(p);
  }
  const literal = parts.filter((p): p is string => typeof p === "string").join("");
  if ((literal.match(/\p{L}/gu) ?? []).length < 3) return null;
  if (!parts.some((p) => typeof p !== "string")) return null;
  let re = "^";
  const caps: Pattern["caps"] = [];
  let anchor = "";
  // A text capture next to a word-initial/final literal must not cut into a
  // word; letters only, so a value like "42" can still sit against a unit
  // ("Resuming in {resumeInSec}s.").
  const textCapture = (part: Part | undefined) => part !== undefined && typeof part !== "string" && !part.num;
  parts.forEach((p, idx) => {
    if (typeof p === "string") {
      let lit = p.replace(/\s+/g, " ");
      if (idx === 0) lit = lit.trimStart();
      if (idx === parts.length - 1) lit = lit.trimEnd();
      // Strict: a space in the English must be whitespace in the text, and a
      // placeholder next to a word cannot end or start inside a word, so
      // "{totalBytes} used" never reads "archive/unused". A numeric capture
      // (\d[\d,.]*) can never cut into a word and needs no guard.
      if (strict && textCapture(parts[idx - 1]) && /^\p{L}/u.test(lit)) re += "(?<!\\p{L})";
      re += lit.split(" ").map(escapeRe).join(strict ? "\\s+" : "\\s*");
      if (strict && textCapture(parts[idx + 1]) && /\p{L}$/u.test(lit)) re += "(?!\\p{L})";
      for (const w of lit.split(" ")) if (w.length > anchor.length) anchor = w;
    } else {
      caps.push({ name: p.cap, num: p.num });
      re += p.num ? "(\\d[\\d,.]*)" : "(.+?)";
    }
  });
  re += "$";
  return { re: new RegExp(re, "su"), caps, bind: v.bind, anchor, target };
}

export interface Catalog {
  strings: { key: string; source: string }[];
}

/**
 * What kind of element the text sits in. The same English can need different
 * target text by role ("Deleted" the filter heading vs "Deleted" the toast),
 * and catalog keys carry the role as their second segment
 * (files.heading.deleted, files.status.deleted).
 */
export type RoleHint = "action" | "heading" | "status" | "tooltip" | "accessibility" | "placeholder";

const PREFERRED: Record<RoleHint, string[]> = {
  action: ["action", "option"],
  heading: ["heading", "label", "column"],
  // A toast title is cataloged as a heading (files.heading.deleted = "Silindi").
  status: ["status", "message", "heading", "description", "error", "notificationTitle"],
  tooltip: ["tooltip", "accessibility", "action"],
  accessibility: ["accessibility", "tooltip", "action"],
  placeholder: ["placeholder"],
};

/** "files.heading.deleted" -> "heading"; "common.cancel" (a button) -> "action". */
const roleOf = (key: string): string => {
  const seg = key.split(".");
  return seg.length < 3 ? "action" : seg[1];
};

export interface TextMatcher {
  /** Rendered English in, rendered target out; null when nothing matches. */
  translate(text: string, hint?: RoleHint): string | null;
  size: { exact: number; patterns: number; skipped: number };
}

export interface MatcherOptions {
  /**
   * For text the app did not write (translateExternal): spaces in the
   * English are required, placeholders respect word edges, and captured
   * values are passed through exactly as found (whitespace and all), never
   * translated themselves.
   */
  strict?: boolean;
  /**
   * Wraps the text of a captured value that the target substitutes as a plain
   * {name} (never one that picks a select or plural branch), e.g. to isolate
   * a path inside right-to-left text. Omitted: output is unchanged.
   */
  wrapPlainArg?: (value: string) => string;
}

/** Names a message substitutes as plain text; names that pick a branch are left out. */
function plainArgNames(nodes: IcuNode[]): Set<string> {
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

export function createTextMatcher(
  catalog: Catalog,
  target: Record<string, string>,
  locale: string,
  { strict = false, wrapPlainArg }: MatcherOptions = {},
): TextMatcher {
  // Every target for one English text, in catalog order, with its role.
  const exact = new Map<string, { text: string; role: string }[]>();
  const addExact = (norm: string, text: string, role: string) => {
    const list = exact.get(norm);
    if (!list) exact.set(norm, [{ text, role }]);
    else if (!list.some((e) => e.text === text)) list.push({ text, role });
  };
  const pick = (norm: string, hint?: RoleHint): string | null => {
    const list = exact.get(norm);
    if (!list) return null;
    if (hint && list.length > 1) {
      for (const role of PREFERRED[hint]) {
        const e = list.find((x) => x.role === role);
        if (e) return e.text;
      }
    }
    return list[0].text;
  };
  const patterns: Pattern[] = [];
  let skipped = 0;

  for (const { key, source } of catalog.strings) {
    const tr = target[key];
    if (!tr) continue;
    try {
      const srcNodes = parseIcu(source);
      const trNodes = parseIcu(tr);
      if (srcNodes.every((n) => typeof n === "string")) {
        const norm = normalizeText(source);
        addExact(norm, formatIcu(trNodes, {}, locale), roleOf(key));
        continue;
      }
      for (const v of expand(srcNodes, null)) {
        if (v.parts.every((p) => typeof p === "string")) {
          // A branch with no placeholder left (=0 {No files}): exact text.
          const norm = normalizeText(v.parts.join(""));
          if (!norm) continue;
          try {
            addExact(norm, formatIcu(trNodes, v.bind, locale), roleOf(key));
          } catch {
            /* the target needs a value the English never showed */
          }
          continue;
        }
        const p = compilePattern(v, trNodes, strict);
        if (p) patterns.push(p);
      }
    } catch {
      skipped++;
    }
  }
  // Most specific first: a longer literal skeleton wins over a looser one.
  patterns.sort((a, b) => b.re.source.length - a.re.source.length);

  const cache = new Map<string, string | null>();

  const translate = (text: string, hint?: RoleHint): string | null => {
    const norm = normalizeText(text);
    if (!norm || !/\p{L}/u.test(norm)) return null;
    // Strict matching reads the text as given (trimmed), so a captured value
    // keeps its own whitespace; the cache is keyed on that text too.
    const subject = strict ? text.trim() : norm;
    const cacheKey = hint ? `${hint}\u0000${subject}` : subject;
    const hit = cache.get(cacheKey);
    if (hit !== undefined) return hit;
    let result: string | null = pick(norm, hint);
    if (result === null) {
      for (const p of patterns) {
        if (!subject.includes(p.anchor)) continue;
        const m = p.re.exec(subject);
        if (!m) continue;
        const args: Record<string, ArgValue> = { ...p.bind };
        let ok = true;
        p.caps.forEach((c, idx) => {
          const raw = m[idx + 1];
          let val: ArgValue = raw;
          if (c.num) {
            const n = Number(raw.replace(/,/g, ""));
            if (!Number.isFinite(n)) ok = false;
            val = n;
          } else {
            // A captured English fragment that is itself a catalog string
            // ("Paused", "Mac App Store") reads better translated.
            // Strict: a value is the engine's data (a path, a server message)
            // and passes through exactly as found.
            val = strict ? raw : (pick(normalizeText(raw)) ?? raw);
          }
          const prev = args[c.name];
          if (prev !== undefined && prev !== UNKNOWN && typeof prev === typeof val && prev !== val) ok = false;
          args[c.name] = val;
        });
        if (!ok) continue;
        if (wrapPlainArg) {
          const plain = (p.plain ??= plainArgNames(p.target));
          // Each name at most once, even when the English captured it twice.
          for (const name of new Set(p.caps.map((c) => c.name))) {
            const v = args[name];
            if (typeof v === "string" && plain.has(name)) args[name] = wrapPlainArg(v);
          }
        }
        try {
          result = formatIcu(p.target, args, locale);
          break;
        } catch {
          /* try a looser pattern */
        }
      }
    }
    if (cache.size > 5000) cache.clear();
    cache.set(cacheKey, result);
    return result;
  };

  return { translate, size: { exact: exact.size, patterns: patterns.length, skipped } };
}

/**
 * translateExternal's engine: text the app shows but does not author (the
 * sync engine's messages, the book reader's library errors), translated where
 * it is displayed. The English catalog is the vendored en.json (key ->
 * source), so this works without packages/i18n. English, and any text the
 * catalog does not know, comes back as it was given; a matcher is built on
 * first use for each message set, so a language switch (a new message set)
 * gets its own.
 *
 * Matching is strict (see MatcherOptions): values are never translated and
 * keep their exact text. Never feed it user content or server text on its
 * own: a file named like an engine message would be "translated".
 */
export function createExternalTranslator(
  english: Record<string, string>,
  keys: readonly string[] = EXTERNAL_KEYS,
  opts: { wrapPlainArg?(locale: string): ((value: string) => string) | undefined } = {},
): (locale: string, messages: Record<string, string>, text: string, hint?: RoleHint) => string {
  // Only what the engine and the reader libraries can emit: matched against
  // all 2,069 keys, an engine line could read as some other screen's message.
  const catalog: Catalog = {
    strings: keys.filter((key) => key in english).map((key) => ({ key, source: english[key] })),
  };
  let built: { messages: Record<string, string>; locale: string; matcher: TextMatcher } | null = null;
  return (locale, messages, text, hint) => {
    if (locale === "en" || !text) return text;
    if (!built || built.messages !== messages || built.locale !== locale) {
      built = { messages, locale, matcher: createTextMatcher(catalog, messages, locale, { strict: true, wrapPlainArg: opts.wrapPlainArg?.(locale) }) };
    }
    return built.matcher.translate(text, hint) ?? text;
  };
}
