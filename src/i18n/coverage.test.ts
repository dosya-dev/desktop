import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { parseIcu, type IcuNode } from "./icu.ts";
import { LOCALES } from "./locales.ts";

/**
 * The catalog and the app must agree. Every English message is referenced
 * somewhere in the app's source (so a deleted screen cannot leave dead
 * translations behind), and every shipped language has every message (a
 * missing one would quietly fall back to English).
 *
 * "Referenced" means the key appears as a string literal in a source file:
 * a t()/tMain()/tl() argument, a value in a key map, a labelKey field or
 * EXTERNAL_KEYS. Tests do not count: a key only a test mentions is dead in
 * the app. The generated keys.ts and the message files are not sources.
 */
const SRC = fileURLToPath(new URL("../", import.meta.url));
const SKIP_FILES = new Set([join(SRC, "i18n/keys.ts")]);
const SKIP_DIRS = new Set([join(SRC, "i18n/messages")]);

const readMessages = (name: string) =>
  JSON.parse(readFileSync(new URL(`./messages/${name}.json`, import.meta.url), "utf8")) as Record<string, string>;

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (!SKIP_DIRS.has(path)) sourceFiles(path, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.(test|spec)\.[a-z]+$/.test(name) && !SKIP_FILES.has(path)) {
      out.push(path);
    }
  }
  return out;
}

/**
 * The source with its comments blanked, so a key that survives only in a
 * comment counts as unreferenced. Strings are skipped whole, so "//" inside
 * a URL or a quote inside a comment does not confuse the scan.
 */
export function stripComments(code: string): string {
  return code.replace(
    /("(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*'|`(?:\\.|[^`\\])*`)|\/\/[^\n]*|\/\*[\s\S]*?\*\//g,
    (_match, str: string | undefined) => str ?? " ",
  );
}

/** Quoted literals shaped like a catalog key in one source text. */
export function keysIn(code: string): string[] {
  const literal = /["'`]([a-z][a-zA-Z0-9-]*(?:\.[a-zA-Z0-9-]+)+)["'`]/g;
  return [...stripComments(code).matchAll(literal)].map((m) => m[1]);
}

/** Every quoted literal shaped like a catalog key, across the app's sources. */
function referencedKeys(): Set<string> {
  const found = new Set<string>();
  for (const file of sourceFiles(SRC)) {
    for (const k of keysIn(readFileSync(file, "utf8"))) found.add(k);
  }
  return found;
}

const english = readMessages("en");

test("a key that appears only in a comment is not a reference", () => {
  const code = [
    `// t("files.label.inLineComment")`,
    `/* labelKey: "files.label.inBlockComment" */`,
    `const url = "https://dosya.dev/x"; t("files.label.real"); // trailing`,
    `const k = 'files.label.single'; const q = \`files.label.template\`;`,
  ].join("\n");
  assert.deepEqual(keysIn(code), ["files.label.real", "files.label.single", "files.label.template"]);
});

test("every English message is referenced by the app", () => {
  const used = referencedKeys();
  const orphans = Object.keys(english).filter((k) => !used.has(k));
  assert.deepEqual(
    orphans,
    [],
    `${orphans.length} catalog key(s) no source file under ${relative(process.cwd(), SRC) || "src"} references. ` +
      `Wire each where its text is shown, or delete it from packages/i18n/desktop/en.catalog.json and the ` +
      `language files, then run npm run vendor:i18n:\n  ${orphans.join("\n  ")}`,
  );
});

for (const lang of LOCALES.filter((l) => l !== "en")) {
  test(`${lang} has every English message`, () => {
    const messages = readMessages(lang);
    const missing = Object.keys(english).filter((k) => !(k in messages));
    assert.deepEqual(
      missing,
      [],
      `${missing.length} key(s) missing in ${lang}.json (shown in English until translated; ` +
        `add them to the next translation batch):\n  ${missing.join("\n  ")}`,
    );
  });
}

/**
 * Arabic, Hebrew and Persian. Their files carry every translatable key with the English
 * argument names, only plural categories the language has, and no hand-placed bidi control:
 * isolation is the runtime's job (src/i18n/bidi.ts), a mark in the data would leak into data.
 */
const RTL_LANGUAGES = ["ar", "he", "fa"] as const;
const BIDI = /[\u200E\u200F\u202A-\u202E\u2066-\u2069]/;

function walk(nodes: IcuNode[], names: Set<string>, plurals: string[][]) {
  for (const n of nodes) {
    if (typeof n === "string" || n.type === "pound") continue;
    names.add(n.name);
    if (n.type === "plural") plurals.push(Object.keys(n.options));
    if (n.type === "plural" || n.type === "select") for (const o of Object.values(n.options)) walk(o, names, plurals);
  }
}
const analyse = (text: string) => {
  const names = new Set<string>();
  const plurals: string[][] = [];
  walk(parseIcu(text), names, plurals);
  return { names: [...names].sort().join(","), plurals };
};

for (const lang of RTL_LANGUAGES) {
  test(`${lang} is shipped`, () => {
    assert.ok((LOCALES as readonly string[]).includes(lang));
  });

  test(`${lang} has every translatable key, matching argument names and valid plural categories`, () => {
    const messages = readMessages(lang);
    const allowed = new Set(new Intl.PluralRules(lang).resolvedOptions().pluralCategories);
    const bad: string[] = [];
    for (const [key, source] of Object.entries(english)) {
      if (!(key in messages)) {
        bad.push(`${key} (missing)`);
        continue;
      }
      const want = analyse(source);
      const have = analyse(messages[key]);
      if (want.names !== have.names) bad.push(`${key} (arguments {${have.names}} differ from {${want.names}})`);
      for (const cats of have.plurals) {
        const wrong = cats.find((c) => !allowed.has(c as Intl.LDMLPluralRule) && !/^=\d+$/.test(c));
        if (wrong) bad.push(`${key} (plural category ${wrong} is not used by ${lang})`);
      }
    }
    assert.deepEqual(bad, []);
  });

  test(`${lang} has no bidi control character in any value`, () => {
    const bad = Object.entries(readMessages(lang)).filter(([, v]) => BIDI.test(v)).map(([k]) => k);
    assert.deepEqual(bad, []);
  });
}
