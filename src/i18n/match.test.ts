import { test } from "node:test";
import { readFileSync } from "node:fs";
import assert from "node:assert/strict";

import { parseIcu } from "./icu.ts";
import { createExternalTranslator, createTextMatcher } from "./match.ts";

const catalog = {
  strings: [
    { key: "cancel", source: "Cancel" },
    { key: "move", source: "{count, plural, one {Move # file to trash?} other {Move # files to trash?}}" },
    { key: "hide", source: "{kind, select, file {Hide file} folder {Hide folder} other {Hide file}}" },
    { key: "cover", source: "Cover art for {title}" },
    { key: "deleted", source: "{n, plural, =0 {Nothing deleted} other {# deleted}}" },
    { key: "bare", source: "{count}" },
    { key: "paused", source: "Paused" },
    { key: "status", source: "Sync: {state}" },
  ],
};
const tr = {
  cancel: "İptal",
  move: "{count, plural, other {# dosya çöp kutusuna taşınsın mı?}}",
  hide: "{kind, select, file {Dosya gizleme} folder {Klasör gizleme} other {Dosya gizleme}}",
  cover: "Kapak görseli: {title}",
  deleted: "{n, plural, =0 {Hiçbir şey silinmedi} other {# öğe silindi}}",
  bare: "{count}",
  paused: "Duraklatıldı",
  status: "Eşitleme: {state}",
};
const T = createTextMatcher(catalog, tr, "tr");

test("plain strings match exactly, ignoring surrounding whitespace", () => {
  assert.equal(T.translate("Cancel"), "İptal");
  assert.equal(T.translate("  Cancel\n"), "İptal");
  assert.equal(T.translate("Cancelled"), null);
});

test("plural counts are read from the English and reformatted for the locale", () => {
  assert.equal(T.translate("Move 1 file to trash?"), "1 dosya çöp kutusuna taşınsın mı?");
  assert.equal(T.translate("Move 1,234 files to trash?"), "1.234 dosya çöp kutusuna taşınsın mı?");
});

test("select branches bind the select value", () => {
  assert.equal(T.translate("Hide folder"), "Klasör gizleme");
  assert.equal(T.translate("Hide file"), "Dosya gizleme");
});

test("text arguments pass through, and translate when they are catalog strings", () => {
  assert.equal(T.translate("Cover art for Song A"), "Kapak görseli: Song A");
  assert.equal(T.translate("Sync: Paused"), "Eşitleme: Duraklatıldı");
});

test("an exact =0 branch is matched as plain text", () => {
  assert.equal(T.translate("Nothing deleted"), "Hiçbir şey silinmedi");
  assert.equal(T.translate("5 deleted"), "5 öğe silindi");
});

test("a placeholder with no literal text never matches arbitrary text", () => {
  assert.equal(T.translate("42"), null);
  assert.equal(T.translate("My Vacation.jpg"), null);
});

test("# inside a select nested in a plural is the plural's count", () => {
  const nested = createTextMatcher(
    { strings: [{ key: "n", source: "{count, plural, one {{kind, select, videos {# video · all folders} other {# photo}}} other {{kind, select, videos {# videos · all folders} other {# photos}}}}" }] },
    { n: "{count, plural, other {{kind, select, videos {# video · tüm klasörler} other {# fotoğraf}}}}" },
    "tr",
  );
  assert.equal(nested.translate("0 videos · all folders"), "0 video · tüm klasörler");
  assert.equal(nested.translate("1 video · all folders"), "1 video · tüm klasörler");
});

test("the parser handles nested plurals inside select", () => {
  const nodes = parseIcu("{a, select, x {{n, plural, one {# one} other {# many}}} other {none}}");
  assert.equal(nodes.length, 1);
  assert.deepEqual(Object.keys((nodes[0] as { options: object }).options), ["x", "other"]);
});

// Text the app does not author (sync engine messages, reader library errors),
// matched against the real catalog at the place it is shown.
const readMessages = (lang: string): Record<string, string> =>
  JSON.parse(readFileSync(new URL(`./messages/${lang}.json`, import.meta.url), "utf8"));

test("external text: an engine message is translated with its argument intact", () => {
  const translateExternal = createExternalTranslator(readMessages("en"));
  const tr = readMessages("tr");
  assert.equal(
    translateExternal("tr", tr, "Sync folder not found: /x"),
    "Senkronizasyon klasörü bulunamadı: /x",
  );
  assert.equal(translateExternal("tr", tr, "Session expired. Please log in again."), tr["sync.error.sessionExpiredPleaseLogInAgain"]);
});

test("external text: unknown text, empty text and English come back unchanged", () => {
  const translateExternal = createExternalTranslator(readMessages("en"));
  const tr = readMessages("tr");
  assert.equal(translateExternal("tr", tr, "Uploaded invoice-0042.pdf"), "Uploaded invoice-0042.pdf");
  assert.equal(translateExternal("tr", tr, ""), "");
  assert.equal(translateExternal("en", readMessages("en"), "Sync folder not found: /x"), "Sync folder not found: /x");
});

test("external text: a new message set (a language switch) gets its own matcher", () => {
  const translateExternal = createExternalTranslator(readMessages("en"));
  const de = readMessages("de");
  assert.equal(translateExternal("tr", readMessages("tr"), "Sync folder not found: /x"), "Senkronizasyon klasörü bulunamadı: /x");
  assert.equal(
    translateExternal("de", de, "Sync folder not found: /x"),
    de["sync.error.syncFolderNotFoundLocalPath"].replace("{localPath}", "/x"),
  );
});

test("external text: engine lines that only resemble other screens' messages come back unchanged", () => {
  const translateExternal = createExternalTranslator(readMessages("en"));
  const tr = readMessages("tr");
  for (const line of [
    "Created 4 folders on server",
    "Moved: drafts/old.txt \u2192 archive/unused",
    "Skipped unsafe sync path: notes/caused",
    "Deleted locally: x",
    "Uploaded my  report  final.pdf",
  ]) {
    assert.equal(translateExternal("tr", tr, line), line);
  }
});

test("external text: captured values pass through byte-identical, never translated", () => {
  const translateExternal = createExternalTranslator(readMessages("en"));
  const tr = readMessages("tr");
  assert.equal(
    translateExternal("tr", tr, "Sync folder not found: /Users/a  b/Documents"),
    "Senkronizasyon klasörü bulunamadı: /Users/a  b/Documents",
  );
  assert.equal(
    translateExternal("tr", tr, "Sync folder not found: Paused"),
    "Senkronizasyon klasörü bulunamadı: Paused",
  );
});

test("external text: only engine and library messages are matched", () => {
  const translateExternal = createExternalTranslator(readMessages("en"));
  const tr = readMessages("tr");
  // "Cancel" is the app's own button text, not something the engine emits.
  assert.equal(translateExternal("tr", tr, "Cancel"), "Cancel");
  assert.equal(translateExternal("tr", tr, "File type not supported"), tr["common.error.fileTypeNotSupported"]);
});

test("external text: a unit glued to a number still matches (\"42s.\")", () => {
  const translateExternal = createExternalTranslator(readMessages("en"));
  const tr = readMessages("tr");
  assert.equal(
    translateExternal("tr", tr, "Rate limit reached. Resuming in 42s."),
    tr["sync.status.rateLimitReachedResumingInResumeInSecS"].replace("{resumeInSec}", "42"),
  );
});

test("wrapPlainArg wraps a captured plain {path}, never a select or plural argument", () => {
  const wrap = (v: string) => `<${v}>`;
  const en = { "k.path": "Sync folder not found: {localPath}", "k.sel": "{kind, select, a {Alpha item} other {Other item}}: {name}", "k.pl": "{n, plural, one {# file} other {# files}} in {where}" };
  const tr = { "k.path": "PATH {localPath}", "k.sel": "{kind, select, a {A} other {O}} / {name}", "k.pl": "{n, plural, one {# f} other {# fs}} @ {where}" };
  const keys = Object.keys(en);
  const plain = createExternalTranslator(en, keys);
  const wrapped = createExternalTranslator(en, keys, { wrapPlainArg: () => wrap });
  assert.equal(plain("xx", tr, "Sync folder not found: /x"), "PATH /x");
  assert.equal(wrapped("xx", tr, "Sync folder not found: /x"), "PATH </x>");
  assert.equal(wrapped("xx", tr, "3 files in /d"), "3 fs @ </d>");
  assert.equal(plain("xx", tr, "3 files in /d"), "3 fs @ /d");
  // a select argument is not wrapped, a plain {name} beside it is
  assert.equal(wrapped("xx", tr, "Alpha item: foo"), "A / <foo>");
  // a name that picks a select branch and is also printed stays unwrapped everywhere
  const en2 = { "k.chooser": "Item {kind} ready" };
  const tr2 = { "k.chooser": "{kind, select, file {F} other {O}} {kind}" };
  const w2 = createExternalTranslator(en2, ["k.chooser"], { wrapPlainArg: () => wrap });
  assert.equal(w2("xx", tr2, "Item file ready"), "F file");
  // a name captured twice is wrapped once
  const en3 = { "k.twice": "{a, select, x {Move} other {Copy}} {p} to {p}" };
  const tr3 = { "k.twice": "{p} -> {p}" };
  const w3 = createExternalTranslator(en3, ["k.twice"], { wrapPlainArg: () => wrap });
  assert.equal(w3("xx", tr3, "Move /x to /x"), "</x> -> </x>");
  // a locale the option declines is untouched
  const off = createExternalTranslator(en, keys, { wrapPlainArg: () => undefined });
  assert.equal(off("xx", tr, "Sync folder not found: /x"), "PATH /x");
});
