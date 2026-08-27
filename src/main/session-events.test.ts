import { test } from "node:test";
import assert from "node:assert/strict";

import { isUnexpectedSessionLoss } from "./session-events.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * The bug this covers: session.ts's cookies.on("changed") handler stopped the
 * sync engine on ANY removal of the dosya_session cookie - an explicit
 * logout() click, the fixed 30-day expiry silently elapsing, or eviction from
 * a remote revocation - with nothing but a console.log line as evidence. When
 * it's the user's own logout they already know; when it's not, they had no
 * way to find out short of a 72-hour-later "sync stopped" email. This
 * classifier is what tells the two apart so only the latter fires a
 * notification.
 */

test("an explicit logout is expected - the user just clicked it", () => {
  assert.equal(isUnexpectedSessionLoss(true, "explicit"), false);
});

test("the cookie's own 30-day timer elapsing is unexpected", () => {
  assert.equal(isUnexpectedSessionLoss(true, "expired"), true);
});

test("eviction (e.g. remote revocation clobbering the cookie store) is unexpected", () => {
  assert.equal(isUnexpectedSessionLoss(true, "evicted"), true);
});

test("an overwrite that removes the value counts as unexpected", () => {
  assert.equal(isUnexpectedSessionLoss(true, "overwrite"), true);
});

test("a cookie being set (not removed) is never a session loss, whatever the cause", () => {
  assert.equal(isUnexpectedSessionLoss(false, "explicit"), false);
  assert.equal(isUnexpectedSessionLoss(false, "expired"), false);
  assert.equal(isUnexpectedSessionLoss(false, "inserted"), false);
});
