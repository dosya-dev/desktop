import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { aboutRows, detailsText, syncLine, syncState, updateButton, updateHint } from "./about-info.ts";
import { setTranslator } from "./locale-state.ts";
import { makeT } from "../../i18n/translator.ts";

// The module translates at call time; these assertions read the English.
const readMessages = (lang: string) =>
  JSON.parse(readFileSync(new URL(`../../i18n/messages/${lang}.json`, import.meta.url), "utf8"));
const enMessages = readMessages("en");
setTranslator(makeT("en", enMessages, enMessages));

test("a ready update offers Restart to Update", () => {
  const b = updateButton("direct", { state: "ready", version: "3.1.4" });
  assert.deepEqual(b, { label: "Restart to Update", action: "install", busy: false });
  assert.equal(updateHint({ state: "ready", version: "3.1.4" }), "Version 3.1.4 is ready to install");
});

test("while installing, the button is busy and the hint says the app will reopen", () => {
  const b = updateButton("direct", { state: "installing", version: "3.1.4" });
  assert.equal(b.label, "Installing…");
  assert.equal(b.busy, true);
  assert.equal(b.action, null);
  assert.equal(updateHint({ state: "installing", version: "3.1.4" }), "Installing version 3.1.4, dosya will reopen in a moment");
});

test("the Sync row's state is a stable value, whatever the language", () => {
  const status = { pairs: [{ status: "idle" }, { status: "idle" }], globalPaused: false, activeTransfers: [] };
  setTranslator(makeT("tr", readMessages("tr"), enMessages));
  try {
    assert.equal(syncState(status), "synced");
    assert.equal(syncLine(status), "Tümü senkronize edildi · 2 klasör");
    assert.equal(updateHint({ state: "available", version: "3.1.5" }), "3.1.5 sürümü kullanılabilir");
  } finally {
    setTranslator(makeT("en", enMessages, enMessages));
  }
  assert.equal(syncState(null), "none");
  assert.equal(syncState({ ...status, globalPaused: true }), "paused");
});

test("Profile > About hides the Engine row on screen, Copy Details keeps it", () => {
  const en = makeT("en", enMessages, enMessages);
  const info = { version: "3.1.4", distribution: "direct", platform: "darwin", arch: "arm64", electron: "43.4.0", chrome: "150.0" };
  const onScreen = aboutRows(en, info, "a@example.com", null, null, { engine: false }).map(([k]) => k);
  assert.deepEqual(onScreen, ["Channel", "System", "Signed in as", "Sync"]);
  const copied = detailsText(en, info, aboutRows(en, info, "a@example.com", null, null));
  assert.match(copied, /^Engine: Electron 43\.4\.0 · Chromium 150\.0$/m);
});
