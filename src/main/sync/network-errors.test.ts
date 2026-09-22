import { test } from "node:test";
import assert from "node:assert/strict";
import { isNetworkErrorMessage, isOfflineError, OFFLINE_MESSAGE } from "./network-errors.ts";

// Re-audit: types.ts has declared an "offline" pair status since the
// beginning and nothing ever assigned it, because the poller's error handler
// only recognised session expiry and rate limits and dropped everything else.
// A machine with no network and no local changes therefore sat at "idle"
// showing "Synced" while the poller quietly backed off - the exact defect
// this status exists to describe.

test("connectivity failures are recognised by code and by message", () => {
  for (const m of [
    "fetch failed", "getaddrinfo ENOTFOUND api.dosya.dev", "connect ECONNREFUSED 127.0.0.1:443",
    "read ECONNRESET", "connect ETIMEDOUT", "connect EHOSTUNREACH", "connect ENETUNREACH",
    "socket hang up", "request timed out", "UND_ERR_CONNECT_TIMEOUT", "ERR_INTERNET_DISCONNECTED",
    "network error", "EAI_AGAIN api.dosya.dev",
  ]) {
    assert.equal(isNetworkErrorMessage(m), true, m);
  }
});

test("things that are NOT connectivity failures stay out of it", () => {
  for (const m of [
    "SESSION_EXPIRED", "RATE_LIMITED", "Upload failed: HTTP 500",
    "You don't have permission to do that", "EACCES: permission denied", null, undefined, "",
  ]) {
    assert.equal(isNetworkErrorMessage(m), false, String(m));
  }
});

test("isOfflineError reads an Error, a string or anything else safely", () => {
  assert.equal(isOfflineError(new Error("fetch failed")), true);
  assert.equal(isOfflineError("getaddrinfo ENOTFOUND api.dosya.dev"), true);
  assert.equal(isOfflineError(new Error("SESSION_EXPIRED")), false);
  assert.equal(isOfflineError({ message: "fetch failed" }), true);
  assert.equal(isOfflineError(null), false);
  assert.equal(isOfflineError(undefined), false);
  assert.equal(isOfflineError(42), false);
});

test("the offline message tells the user what is true and what happens next", () => {
  assert.match(OFFLINE_MESSAGE, /connect/i);
  // No em dashes, and never a claim that everything is synced.
  assert.equal(OFFLINE_MESSAGE.includes("—"), false);
});
