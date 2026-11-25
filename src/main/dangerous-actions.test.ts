import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmedBy, promptFor } from "./dangerous-actions.ts";

/**
 * Bounty (desktop 3.1.10): app:factory-reset, app:set-launch-at-login and
 * updater:install acted on a bare IPC call from a renderer that also runs
 * remote script. The main process now asks in a native dialog first; these
 * pin the dialog's shape: Cancel first (the default and what Esc/close means),
 * the action second, copy from shipped catalog strings.
 */

const t = (key: string, values?: Record<string, string>) => (values ? `${key}(${JSON.stringify(values)})` : key);

test("factory reset names what it deletes and offers Cancel first", () => {
  const p = promptFor({ kind: "factory-reset" }, t);
  assert.equal(p.message, "settings.heading.resetAppDataQuestionSentenceCase");
  assert.equal(p.detail, "settings.description.signsYouOutRemovesAllLocalAppDataIncluding");
  assert.deepEqual(p.buttons, ["common.cancel", "settings.action.resetAndRestart"]);
});

test("launch at login asks with the standard title", () => {
  const p = promptFor({ kind: "launch-at-login" }, t);
  assert.equal(p.message, "common.heading.areYouSure");
  assert.deepEqual(p.buttons, ["common.cancel", "sync.label.launchAtLogin"]);
});

test("install update names the version when it is known", () => {
  assert.match(promptFor({ kind: "install-update", version: "3.1.11" }, t).detail, /3\.1\.11/);
  assert.equal(promptFor({ kind: "install-update" }, t).detail, "about.action.restartToUpdate");
  assert.deepEqual(promptFor({ kind: "install-update" }, t).buttons, ["common.cancel", "profile.action.installRestart"]);
});

test("only the action button confirms; Cancel and closing the dialog never do", () => {
  assert.equal(confirmedBy(1), true);
  assert.equal(confirmedBy(0), false);
  assert.equal(confirmedBy(-1), false);
});
