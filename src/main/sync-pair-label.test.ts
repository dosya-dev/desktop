import { test } from "node:test";
import assert from "node:assert/strict";

import { readFileSync } from "node:fs";
import {
  DEFAULT_ROOT_FOLDER_NAME,
  DEFAULT_WORKSPACE_NAME,
  mayShowDefaultName,
  pairFolderLabel,
  rootPairIds,
} from "./sync-pair-label.ts";
import { makeT, type Messages } from "../i18n/translator.ts";

/**
 * Run with `npm run test:unit`. A sync pair stores its folder and workspace
 * names in English config; "Root", the default the app writes for a pair on
 * the workspace root, is shown in the chosen language, every other name
 * (the "Workspace" fallback included) as stored.
 */
const messages = (locale: string): Messages =>
  JSON.parse(readFileSync(new URL(`../i18n/messages/${locale}.json`, import.meta.url), "utf8")) as Messages;
const en = messages("en");
const tr = messages("tr");
const enT = makeT("en", en, en);
const trT = makeT("tr", tr, en);

test("the stored defaults are the English the app wrote before", () => {
  assert.equal(DEFAULT_ROOT_FOLDER_NAME, "Root");
  assert.equal(DEFAULT_WORKSPACE_NAME, "Workspace");
});

test("a root pair's default name is shown in the chosen language", () => {
  assert.equal(pairFolderLabel("Root", true, trT), tr["sync.label.root"]);
  assert.equal(pairFolderLabel("Root", true, enT), "Root");
});

test("a folder the user named Root, or any other name, is shown as stored", () => {
  assert.equal(pairFolderLabel("Root", false, trT), "Root");
  assert.equal(pairFolderLabel("Thesis", true, trT), "Thesis");
});

test("the stored \"Workspace\" fallback is a folder label like any other: shown as stored", () => {
  assert.equal(pairFolderLabel("Workspace", true, trT), "Workspace");
});

test("only pairs carrying a default name need the config read", () => {
  assert.equal(mayShowDefaultName({ remoteFolderName: "Root" }), true);
  assert.equal(mayShowDefaultName({ remoteFolderName: "Thesis" }), false);
});

test("root pairs are the configured pairs with no remote folder", () => {
  const ids = rootPairIds([
    { id: "a", remoteFolderId: null },
    { id: "b", remoteFolderId: "fld_1" },
    { id: "c" },
  ]);
  assert.deepEqual([...ids].sort(), ["a", "c"]);
});

import { isolatePairName } from "./sync-pair-label.ts";

test("pair names are isolated only in right-to-left", () => {
  assert.equal(isolatePairName("Photos", "ltr"), "Photos");
  assert.equal(isolatePairName("Photos", "rtl"), "⁨Photos⁩");
  assert.equal(isolatePairName("", "rtl"), "");
});
