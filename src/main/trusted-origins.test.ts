import { test } from "node:test";
import assert from "node:assert/strict";

import { originAllowed } from "./trusted-origins.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * These pin down a reported origin-validation bypass (CWE-346). Every guard in
 * the main process used to compare URLs with `String.prototype.startsWith`,
 * which is a substring test, not an origin test. An attacker-registered
 * `accounts.google.com.evil.example` satisfies a `startsWith` against
 * `https://accounts.google.com`, so the OAuth popup's navigation allow-list and
 * the session cookie-capture filter both accepted attacker-owned hosts.
 */

const OAUTH = ["https://accounts.google.com", "https://github.com"];
const API = ["https://api.dosya.dev"];

// ── the origins that must keep working ────────────────────────────

test("allows the exact origin, whatever the path", () => {
  assert.equal(originAllowed("https://accounts.google.com/o/oauth2/v2/auth", OAUTH), true);
  assert.equal(originAllowed("https://github.com/login/oauth/authorize?a=1#f", OAUTH), true);
  assert.equal(originAllowed("https://api.dosya.dev/api/auth/google", API), true);
});

test("allows the bare origin with no trailing slash", () => {
  assert.equal(originAllowed("https://api.dosya.dev", API), true);
});

test("ignores an explicit default port", () => {
  assert.equal(originAllowed("https://api.dosya.dev:443/x", API), true);
});

// ── the reported bypass ───────────────────────────────────────────

test("rejects a lookalike host that merely starts with a trusted origin", () => {
  assert.equal(originAllowed("https://accounts.google.com.evil.example/harvest", OAUTH), false);
  assert.equal(originAllowed("https://github.com.evil.example/harvest", OAUTH), false);
  assert.equal(originAllowed("https://api.dosya.dev.evil.example/callback", API), false);
});

test("rejects a trusted origin smuggled into the userinfo field", () => {
  assert.equal(originAllowed("https://accounts.google.com@evil.example/x", OAUTH), false);
  assert.equal(originAllowed("https://api.dosya.dev@evil.example/x", API), false);
});

test("rejects a trusted host under a different scheme", () => {
  assert.equal(originAllowed("http://api.dosya.dev/x", API), false);
});

test("rejects a trusted host on a different port", () => {
  assert.equal(originAllowed("https://api.dosya.dev:8443/x", API), false);
});

test("rejects a subdomain of a trusted origin", () => {
  assert.equal(originAllowed("https://evil.api.dosya.dev/x", API), false);
});

test("rejects an unrelated origin", () => {
  assert.equal(originAllowed("https://evil.example/dashboard", API), false);
});

// ── non-special schemes: app://bundle ─────────────────────────────

/**
 * `new URL("app://bundle/x").origin` is the string "null" for a non-special
 * scheme, so an `.origin === .origin` comparison would treat EVERY app:// URL
 * as trusted. The comparison has to be scheme+host, not `.origin`.
 */
test("compares non-special schemes by scheme and host, not by opaque origin", () => {
  const APP = ["app://bundle"];
  assert.equal(originAllowed("app://bundle/index.html", APP), true);
  assert.equal(originAllowed("app://bundle.evil.example/x", APP), false);
  assert.equal(originAllowed("app://evil/x", APP), false);
});

// ── malformed input ───────────────────────────────────────────────

test("rejects anything that does not parse as a URL", () => {
  assert.equal(originAllowed("not a url", API), false);
  assert.equal(originAllowed("", API), false);
});

test("rejects when the allow-list is empty", () => {
  assert.equal(originAllowed("https://api.dosya.dev/x", []), false);
});

test("ignores an unparseable entry in the allow-list instead of throwing", () => {
  assert.equal(originAllowed("https://api.dosya.dev/x", ["", "https://api.dosya.dev"]), true);
});
