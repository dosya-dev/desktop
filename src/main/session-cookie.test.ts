import { test } from "node:test";
import assert from "node:assert/strict";

import {
  parseSessionCookieHeaders,
  sessionCookieHeader,
  isSessionCookieName,
  HOST_SESSION_COOKIE,
  LEGACY_SESSION_COOKIE,
} from "./session-cookie.ts";
import { originAllowed } from "./trusted-origins.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * The bug behind this split: `onHeadersReceived` decided whether a response was
 * allowed to set the session cookie with `details.url.startsWith(apiBase)`. A
 * page on the attacker-registered `api.dosya.dev.evil.example` satisfies that
 * prefix test, so its `Set-Cookie` was captured and written into the real
 * cookie store scoped to `https://api.dosya.dev` - session fixation.
 *
 * The cookie also gained a second name: the API issues `__Host-dosya_session`
 * in prod (host-only, untossable) and the plain `dosya_session` in dev. Desktop
 * must recognise and round-trip whichever it is given.
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

// ── header parsing: legacy name ───────────────────────────────────

test("captures the legacy session cookie value", () => {
  assert.deepEqual(
    parseSessionCookieHeaders(sc("dosya_session=abc123; Path=/; HttpOnly; Secure; SameSite=None")),
    [{ action: "store", name: LEGACY_SESSION_COOKIE, value: "abc123" }],
  );
});

test("treats an empty value as a logout that clears the cookie", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("dosya_session=; Path=/")), [
    { action: "clear", name: LEGACY_SESSION_COOKIE },
  ]);
});

test("preserves a value containing '=' padding", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("dosya_session=a=b=; Path=/")), [
    { action: "store", name: LEGACY_SESSION_COOKIE, value: "a=b=" },
  ]);
});

test("finds the header whatever its capitalisation", () => {
  assert.deepEqual(parseSessionCookieHeaders({ "Set-Cookie": ["dosya_session=abc"] }), [
    { action: "store", name: LEGACY_SESSION_COOKIE, value: "abc" },
  ]);
});

test("ignores other cookies on the same response", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("csrf=zzz; Path=/", "dosya_session=abc", "theme=dark")), [
    { action: "store", name: LEGACY_SESSION_COOKIE, value: "abc" },
  ]);
});

test("does not confuse a differently named cookie with the session cookie", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("dosya_session_backup=abc")), []);
});

test("returns nothing when the response sets no cookies", () => {
  assert.deepEqual(parseSessionCookieHeaders({}), []);
  assert.deepEqual(parseSessionCookieHeaders(undefined), []);
});

// ── header parsing: __Host- name ──────────────────────────────────

test("captures the __Host- session cookie, reporting its name", () => {
  assert.deepEqual(
    parseSessionCookieHeaders(sc("__Host-dosya_session=xyz; Path=/; HttpOnly; Secure; SameSite=None")),
    [{ action: "store", name: HOST_SESSION_COOKIE, value: "xyz" }],
  );
});

test("does NOT misread __Host-dosya_session (which contains 'dosya_session=') as the legacy name", () => {
  const [update] = parseSessionCookieHeaders(sc("__Host-dosya_session=xyz; Path=/"));
  assert.equal(update.name, HOST_SESSION_COOKIE);
  assert.equal(update.action === "store" && update.value, "xyz");
});

test("clears the __Host- cookie on an empty value", () => {
  assert.deepEqual(parseSessionCookieHeaders(sc("__Host-dosya_session=; Path=/")), [
    { action: "clear", name: HOST_SESSION_COOKIE },
  ]);
});

// ── sending: pick the right cookie ────────────────────────────────

test("sessionCookieHeader prefers the untossable __Host- cookie", () => {
  assert.equal(
    sessionCookieHeader([
      { name: LEGACY_SESSION_COOKIE, value: "legacy" },
      { name: HOST_SESSION_COOKIE, value: "host" },
    ]),
    "__Host-dosya_session=host",
  );
});

test("sessionCookieHeader falls back to the legacy cookie", () => {
  assert.equal(
    sessionCookieHeader([{ name: LEGACY_SESSION_COOKIE, value: "legacy" }]),
    "dosya_session=legacy",
  );
});

test("sessionCookieHeader returns null when neither name is held", () => {
  assert.equal(sessionCookieHeader([{ name: "theme", value: "dark" }]), null);
  assert.equal(sessionCookieHeader([]), null);
});

test("isSessionCookieName recognises both names and nothing else", () => {
  assert.equal(isSessionCookieName(HOST_SESSION_COOKIE), true);
  assert.equal(isSessionCookieName(LEGACY_SESSION_COOKIE), true);
  assert.equal(isSessionCookieName("dosya_session_backup"), false);
  assert.equal(isSessionCookieName("csrf"), false);
});
