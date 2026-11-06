import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * scripts/vendor-i18n.mjs decides which languages ship. These tests run it on copies of the real
 * catalog with one defect each. Monorepo-only: the public desktop repo has no packages/ folder.
 */
const deskRoot = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const realCatalogDir = resolve(deskRoot, "../../packages/i18n/desktop");
const script = resolve(deskRoot, "scripts/vendor-i18n.mjs");
const inMonorepo = existsSync(join(realCatalogDir, "en.catalog.json")) && existsSync(script);
const maybe = inMonorepo ? test : test.skip;

type Result =
  | { ok: true; shipped: string[]; skipped: Record<string, string[]>; warnings: string[]; files: Record<string, string> }
  | { ok: false; error: string };

function build(catalogDir: string, root: string = mkdtempSync(join(tmpdir(), "desk-root-")), allowDrop: string[] = []): Result {
  const code = `
    import { buildOutputs } from ${JSON.stringify(script)};
    try {
      const r = await buildOutputs(${JSON.stringify({ deskRoot: root, catalogDir, allowDrop })});
      process.stdout.write(JSON.stringify({ ok: true, shipped: r.shipped, skipped: r.skipped, warnings: r.warnings, files: r.files }));
    } catch (e) { process.stdout.write(JSON.stringify({ ok: false, error: e.message })); }
  `;
  return JSON.parse(execFileSync(process.execPath, ["--input-type=module", "-e", code], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }));
}

// A root that has the real icu.ts (the script parses messages with it) and no shipped.json.
function freshRoot(shipped?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "desk-root-"));
  mkdirSync(join(root, "src/i18n"), { recursive: true });
  cpSync(join(deskRoot, "src/i18n/icu.ts"), join(root, "src/i18n/icu.ts"));
  if (shipped) writeFileSync(join(root, "src/i18n/shipped.json"), JSON.stringify(shipped));
  return root;
}

function tempCatalog(): string {
  const dir = mkdtempSync(join(tmpdir(), "desk-i18n-"));
  for (const f of readdirSync(realCatalogDir)) if (/^[A-Za-z0-9-]+(\.catalog)?\.json$/.test(f)) cpSync(join(realCatalogDir, f), join(dir, f));
  return dir;
}
function edit(dir: string, lang: string, fn: (m: Record<string, string>) => void) {
  const p = join(dir, `${lang}.json`);
  const m = JSON.parse(readFileSync(p, "utf8"));
  fn(m);
  writeFileSync(p, JSON.stringify(m));
}
function ok(r: Result) {
  if (!r.ok) throw new Error(r.error);
  return r;
}
const ORIGINAL = ["tr", "de", "fr", "es", "it", "pl", "pt-BR", "nl", "sv", "da", "nb", "fi", "cs", "ro", "hu", "el", "id", "vi"];
const catalog = (dir: string) => JSON.parse(readFileSync(join(dir, "en.catalog.json"), "utf8")).strings as { key: string; source: string; translate?: boolean }[];

maybe("the 18 languages shipped before the computed list still ship, in order", () => {
  const r = ok(build(realCatalogDir, freshRoot()));
  assert.deepEqual(r.shipped.filter((l) => ORIGINAL.includes(l)), ORIGINAL);
  assert.ok(r.shipped.indexOf("id") < r.shipped.indexOf("zh-Hans"));
  assert.ok(r.files["src/i18n/messages/en.json"] && r.files["src/i18n/keys.ts"] && r.files["src/i18n/shipped.json"]);
});

maybe("ships a complete Arabic copy and generates the direction table", () => {
  const dir = tempCatalog();
  cpSync(join(dir, "tr.json"), join(dir, "ar.json"));
  const r = ok(build(dir, freshRoot()));
  assert.ok(r.shipped.includes("ar"));
  assert.ok(r.files["src/i18n/messages/ar.json"]);
  assert.ok(r.files["src/i18n/loaders.ts"].includes('import("./messages/ar.json")'));
  const locales = r.files["src/i18n/locales.ts"];
  const js = ts.transpileModule(locales, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
  const exported: Record<string, unknown> = {};
  new Function("exports", js)(exported);
  const api = exported as {
    localeDir: (l: string) => string;
    intlTag: (l: string) => string | undefined;
    RTL_LOCALES: string[];
  };
  assert.equal(api.localeDir("ar"), "rtl");
  assert.equal(api.localeDir("de"), "ltr");
  assert.equal(api.intlTag("ar"), "ar-u-nu-latn");
  assert.equal(api.intlTag("en"), undefined);
  assert.equal(api.intlTag("de"), "de");
  assert.deepEqual(api.RTL_LOCALES, ["ar", "he", "fa"]);
});

maybe("still skips a complete Urdu copy as right-to-left", () => {
  const dir = tempCatalog();
  cpSync(join(dir, "tr.json"), join(dir, "ur.json"));
  const r = ok(build(dir, freshRoot()));
  assert.ok(!r.shipped.includes("ur"));
  assert.match(r.skipped.ur.join(" "), /right-to-left \(not supported\)/);
  assert.equal(r.files["src/i18n/messages/ur.json"], undefined);
});

maybe("the 30 languages shipped before keep their order and their files match the data minus stale keys", () => {
  const BEFORE = [...ORIGINAL, "bg", "sk", "et", "zh-Hans", "zh-Hant", "sl", "th", "hr", "lv", "lt", "ja", "ko"];
  assert.equal(BEFORE.length, 30);
  const r = ok(build(realCatalogDir, freshRoot()));
  assert.deepEqual(r.shipped.filter((l) => BEFORE.includes(l)), BEFORE);
  const en = new Set(catalog(realCatalogDir).map((s) => s.key));
  for (const l of BEFORE) {
    const data = JSON.parse(readFileSync(join(realCatalogDir, `${l}.json`), "utf8")) as Record<string, string>;
    for (const k of Object.keys(data)) if (!en.has(k)) delete data[k];
    assert.equal(r.files[`src/i18n/messages/${l}.json`], JSON.stringify(data, null, 2) + "\n", l);
  }
});

maybe("leaves out a language missing one key, and keeps it in the label table", () => {
  const dir = tempCatalog();
  edit(dir, "de", (m) => delete m[Object.keys(m)[0]]);
  const r = ok(build(dir, freshRoot()));
  assert.ok(!r.shipped.includes("de"));
  assert.match(r.skipped.de.join(" "), /missing 1 keys/);
  assert.ok(!r.files["src/i18n/loaders.ts"].includes("messages/de.json"));
  // Candidate languages stay in LOCALE_LABELS only once shipped, but the table knows them all.
  assert.ok(/bg:\s*'/.test(readFileSync(script, "utf8")));
});

maybe("exempts a translate:false key from completeness", () => {
  const dir = tempCatalog();
  const key = catalog(dir).find((s) => s.translate !== false)!.key;
  edit(dir, "de", (m) => delete m[key]);
  assert.ok(!ok(build(dir, freshRoot())).shipped.includes("de"));
  const cat = JSON.parse(readFileSync(join(dir, "en.catalog.json"), "utf8"));
  for (const s of cat.strings) if (s.key === key) s.translate = false;
  writeFileSync(join(dir, "en.catalog.json"), JSON.stringify(cat));
  assert.ok(ok(build(dir, freshRoot())).shipped.includes("de"));
});

maybe("rejects a message that does not parse, one whose argument names differ, and a bogus plural branch", () => {
  const dir = tempCatalog();
  const cat = catalog(dir);
  const plain = cat.find((s) => s.translate !== false && !/[{}]/.test(s.source))!;
  const withArg = cat.find((s) => /\{[a-zA-Z]+\}/.test(s.source))!;
  edit(dir, "fr", (m) => (m[plain.key] = "{unclosed, plural, one {x"));
  edit(dir, "de", (m) => (m[withArg.key] = withArg.source.replace(/\{[a-zA-Z]+\}/, "{wrongName}")));
  const plural = cat.find((s) => /\{\w+, plural, one \{/.test(s.source))!;
  edit(dir, "es", (m) => (m[plural.key] = plural.source.replace("one {", "bogus {")));
  const r = ok(build(dir, freshRoot()));
  assert.match(r.skipped.fr.join(" "), new RegExp(`${plain.key.replace(/\./g, "\\.")} \\(does not parse\\)`));
  assert.match(r.skipped.de.join(" "), /differ from English/);
  assert.match(r.skipped.es.join(" "), /plural branch "bogus"/);
  for (const l of ["fr", "de", "es"]) assert.ok(!r.shipped.includes(l));
});

maybe("keeps a plural branch Indonesian never selects (shipped that way before)", () => {
  const r = ok(build(realCatalogDir, freshRoot()));
  assert.ok(r.shipped.includes("id"));
  assert.ok(r.shipped.includes("vi"));
});

maybe("leaves a key the catalog lacks out of the vendored copy and says so", () => {
  const dir = tempCatalog();
  edit(dir, "de", (m) => (m["bogus.extra.key"] = "x"));
  const r = ok(build(dir, freshRoot()));
  assert.ok(r.shipped.includes("de"));
  assert.equal("bogus.extra.key" in JSON.parse(r.files["src/i18n/messages/de.json"]), false);
  assert.ok(r.warnings.some((w) => w.includes("de.json") && w.includes("bogus.extra.key")));
});

maybe("refuses to drop a shipped language without --allow-drop", () => {
  const shipped = ok(build(realCatalogDir, freshRoot())).shipped;
  const root = freshRoot(shipped);
  const dir = tempCatalog();
  edit(dir, "pl", (m) => delete m[Object.keys(m)[0]]);
  const refused = build(dir, root);
  assert.equal(refused.ok, false);
  assert.match(!refused.ok ? refused.error : "", /pl/);
  assert.ok(!ok(build(dir, root, ["pl"])).shipped.includes("pl"));
});

maybe("generates locales and loaders from the shipped list", () => {
  const r = ok(build(realCatalogDir, freshRoot()));
  const locales = r.files["src/i18n/locales.ts"];
  const loaders = r.files["src/i18n/loaders.ts"];
  for (const l of r.shipped) {
    assert.ok(loaders.includes(`import("./messages/${l}.json")`), l);
    assert.ok(r.files[`src/i18n/messages/${l}.json`], l);
  }
  assert.ok(locales.includes('"zh-Hans": "简体中文"'));
  assert.equal(JSON.parse(r.files["src/i18n/shipped.json"]).includes("en"), false);
});
