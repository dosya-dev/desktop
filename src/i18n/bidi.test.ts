import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { isolate, makeDirectionalT, stripBidi } from "./bidi.ts";
import { makeT } from "./translator.ts";
import type { MessageKey } from "./keys.ts";

const FSI = "⁨";
const PDI = "⁩";
const k = (s: string) => s as MessageKey;
const readMessages = (name: string) =>
  JSON.parse(readFileSync(new URL(`./messages/${name}.json`, import.meta.url), "utf8")) as Record<string, string>;
const en = readMessages("en");

test("ar wraps a plain {name} in first-strong isolate marks", () => {
  const t = makeDirectionalT("ar", { del: "حذف {name}؟" }, { del: "Delete {name}?" });
  assert.equal(t(k("del"), { name: "a.txt" }), `حذف ${FSI}a.txt${PDI}؟`);
});

test("a select value is passed untouched and picks its branch", () => {
  const msg = "{hasExtension, select, yes {type {extension}} other {no extension}}";
  const t = makeDirectionalT("ar", { x: msg }, { x: msg });
  assert.equal(t(k("x"), { hasExtension: "yes", extension: "png" }), `type ${FSI}png${PDI}`);
});

test("a name used both plainly and as a selector is not wrapped", () => {
  const msg = "{kind, select, a {{kind} is A} other {other}}";
  const t = makeDirectionalT("ar", { x: msg }, { x: msg });
  assert.equal(t(k("x"), { kind: "a" }), "a is A");
});

test("plural {count} and # are untouched", () => {
  const msg = "{count, plural, =1 {{name} (copy)} other {{name} (copy #)}}";
  const t = makeDirectionalT("ar", { x: msg }, { x: msg });
  assert.equal(t(k("x"), { name: "n", count: 2 }), `${FSI}n${PDI} (copy 2)`);
  assert.equal(t(k("x"), { name: "n", count: 1 }), `${FSI}n${PDI} (copy)`);
});

test("an empty string is not wrapped", () => {
  const t = makeDirectionalT("ar", { x: "a{v}b" }, { x: "a{v}b" });
  assert.equal(t(k("x"), { v: "" }), "ab");
  assert.equal(isolate(""), "");
});

test("a broken ar message falls back to English and the argument analysis follows English", () => {
  const t = makeDirectionalT("ar", { x: "{oops" }, { x: "Hi {name}" });
  assert.equal(t(k("x"), { name: "Z" }), `Hi ${FSI}Z${PDI}`);
  const sel = "{k, select, yes {Y {k}} other {N}}";
  const t2 = makeDirectionalT("he", { x: "{broken" }, { x: sel });
  assert.equal(t2(k("x"), { k: "yes" }), "Y yes");
});

test("left-to-right languages are byte-identical to makeT on every key", () => {
  const values = { name: "file.txt", count: 3, extension: "png", hasExtension: "yes", n: 2, max: 5, reason: "r", summary: "s", limit: "1" };
  for (const loc of ["en", "de", "tr", "ja"] as const) {
    const messages = loc === "en" ? en : readMessages(loc);
    const plain = makeT(loc, messages, en);
    const dir = makeDirectionalT(loc, messages, en);
    let checked = 0;
    for (const key of Object.keys(en)) {
      if (!/\{\w+/.test(en[key])) continue;
      assert.equal(dir(k(key), values), plain(k(key), values), `${loc} ${key}`);
      checked++;
    }
    assert.ok(checked >= 200, `${loc}: ${checked} keys`);
  }
});

test("stripBidi removes the marks and isolates and nothing else", () => {
  assert.equal(stripBidi("‎a‏b⁦c⁧d⁨e⁩f"), "abcdef");
  assert.equal(stripBidi("a​b‪c؜"), "a​b‪c؜");
});
