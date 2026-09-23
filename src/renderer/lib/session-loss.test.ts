// apps/desktop/src/renderer/lib/session-loss.test.ts
//
// An admin revoking a session from the portal (DELETE the row + drop the KV
// entry) used to leave the desktop app fully usable: the renderer checked
// /api/me once at boot and never again, and no 401 afterwards did anything
// beyond failing the one request that saw it. These tests pin the pure
// decisions behind the fix; the wiring (API client, auth context, IPC from
// the sync engine) is exercised by hand.
//
// node --test resolves imports literally: the ".ts" extension is required.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSessionLossResponse,
  SESSION_CHECK_INTERVAL_MS,
  SessionLossSignal,
} from "./session-loss.ts";

describe("isSessionLossResponse", () => {
  it("treats a 401 from an ordinary API route as the session being gone", () => {
    assert.equal(isSessionLossResponse("/api/files?workspace_id=w1", 401), true);
    assert.equal(isSessionLossResponse("/api/me", 401), true);
  });

  it("ignores a 401 from the auth routes, where it means wrong credentials", () => {
    assert.equal(isSessionLossResponse("/api/auth/login", 401), false);
    assert.equal(isSessionLossResponse("/api/auth/2fa/verify", 401), false);
  });

  it("ignores every other status", () => {
    assert.equal(isSessionLossResponse("/api/files", 403), false);
    assert.equal(isSessionLossResponse("/api/files", 500), false);
    assert.equal(isSessionLossResponse("/api/files", 200), false);
  });
});

describe("SessionLossSignal", () => {
  it("delivers a report to every subscriber", () => {
    const signal = new SessionLossSignal();
    const seen: string[] = [];
    signal.subscribe(() => seen.push("a"));
    signal.subscribe(() => seen.push("b"));

    signal.report();

    assert.deepEqual(seen, ["a", "b"]);
  });

  it("stops delivering after unsubscribe", () => {
    const signal = new SessionLossSignal();
    let calls = 0;
    const off = signal.subscribe(() => { calls++; });
    signal.report();
    off();
    signal.report();

    assert.equal(calls, 1);
  });

  it("holds a report made before anyone subscribed until the first subscriber arrives", () => {
    // A 401 can land while the auth provider is still mounting; losing it
    // would leave the app signed in on a dead session until the next check.
    const signal = new SessionLossSignal();
    signal.report();
    let calls = 0;

    signal.subscribe(() => { calls++; });

    assert.equal(calls, 1);
  });

  it("checks the session no more than every five minutes when nothing else fires", () => {
    assert.equal(SESSION_CHECK_INTERVAL_MS, 5 * 60 * 1000);
  });
});
