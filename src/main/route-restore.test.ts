import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LAST_ROUTE_KEY, isRestorableRoute, saveLastRoute, readLastRoute,
} from "../renderer/lib/route-restore.ts";

/**
 * Lives under src/main because `npm run test:unit` globs src/main - the
 * module is deliberately DOM-free (storage is injected) so this import is
 * legal. It decides WHICH route a recreated window boots back into.
 */

const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
};

test("app pages are restorable, auth and transient pages are not", () => {
  for (const p of ["/files", "/dashboard", "/settings", "/sync", "/map", "/profile?section=appearance"]) {
    assert.equal(isRestorableRoute(p), true, `${p} should be restorable`);
  }
  for (const p of ["/", "/onboarding", "/login", "/signup", "/forgot-password", "/2fa", "/verify", "/editor/abc123"]) {
    assert.equal(isRestorableRoute(p), false, `${p} should NOT be restorable`);
  }
});

test("save/read round-trips an app route", () => {
  const s = memStorage();
  saveLastRoute("/files", s);
  assert.equal(readLastRoute(s), "/files");
});

test("navigating to a non-restorable route does not clobber the saved one", () => {
  const s = memStorage();
  saveLastRoute("/files", s);
  saveLastRoute("/login", s);
  assert.equal(readLastRoute(s), "/files");
});

test("query strings survive the round-trip", () => {
  const s = memStorage();
  saveLastRoute("/profile?section=appearance", s);
  assert.equal(readLastRoute(s), "/profile?section=appearance");
});

test("a tampered stored value reads as null", () => {
  const cases = ["", "files", "http://evil.example", "/login", "/" + "x".repeat(600)];
  for (const bad of cases) {
    const s = memStorage();
    s.setItem(LAST_ROUTE_KEY, bad);
    assert.equal(readLastRoute(s), null, `expected null for ${JSON.stringify(bad.slice(0, 40))}`);
  }
});

test("empty storage reads as null", () => {
  assert.equal(readLastRoute(memStorage()), null);
});
