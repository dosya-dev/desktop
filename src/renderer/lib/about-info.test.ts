import { test } from "node:test";
import assert from "node:assert/strict";
import { updateButton, updateHint } from "./about-info.ts";

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
