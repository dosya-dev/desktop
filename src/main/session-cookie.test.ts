import { test } from "node:test";
import assert from "node:assert/strict";

import { parseSessionCookieHeaders } from "./session-cookie.ts";
import { originAllowed } from "./trusted-origins.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * The bug behind this split: `onHeadersReceived` decided whether a response was
 * allowed to set `dosya_session` with `details.url.startsWith(apiBase)`. A page
 * on the attacker-registered `api.dosya.dev.evil.example` satisfies that prefix
 * test, so its `Set-Cookie` was captured and written into the real cookie store
 * scoped to `https://api.dosya.dev` - session fixation. The OAuth popup ran on
 * the default session and got no CSP, so a page there could reach this.
 *
 * Parsing and the origin decision are now separate: `session.ts` gates on
 * `originAllowed` before it ever parses headers.
 */

const API = "https://api.dosya.dev";
const sc = (...values: string[]) => ({ "set-cookie": values });

// ── the gate that stops the reported bypass ───────────────────────

test("the API origin gate rejects hosts that merely start with the API base", () => {
  assert.equal(originAllowed("https://api.dosya.dev.evil.example/x", [API]), false);
  assert.equal(originAllowed("https://api.dosya.dev@evil.example/x", [API]), false);
  assert.equal(originAllowed("https://evil.example/x", [API]), false);
  assert.equal(originAllowed("https://api.dosya.dev/api/auth/google/callback", [API]), true);
});

// ── header parsing ────────────────────────────────────────────────

test("captures the session cookie value", () => {
  assert.deepEqual(
    parseSessionCookieHeaders(sc("dosya_session=abc123; Path=/; HttpOnly; Secure; SameSite=None")),
    [{ action: "store", value: "abc123" }],
  );
});

test("treats an empty value as a logout that clears the cookie", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("dosya_session=; Path=/")), [{ action: "clear" }]);
});

test("preserves a value containing '=' padding", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("dosya_session=a=b=; Path=/")), [
    { action: "store", value: "a=b=" },
  ]);
});

test("finds the header whatever its capitalisation", () => {
  assert.deepEqual(parseSessionCookieHeaders({ "Set-Cookie": ["dosya_session=abc"] }), [
    { action: "store", value: "abc" },
  ]);
});

test("ignores other cookies on the same response", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("csrf=zzz; Path=/", "dosya_session=abc", "theme=dark")), [
    { action: "store", value: "abc" },
  ]);
});

test("does not confuse a differently named cookie with the session cookie", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("dosya_session_backup=abc")), []);
});

test("returns nothing when the response sets no cookies", () => {
  assert.deepEqual(parseSessionCookieHeaders({}), []);
  assert.deepEqual(parseSessionCookieHeaders(undefined), []);
});
