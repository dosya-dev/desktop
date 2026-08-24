import { test } from "node:test";
import assert from "node:assert/strict";
import { isParentToChild, isChildToParent, isEngineRpcMethod, errorText, ENGINE_RPC_METHODS } from "./engine-protocol.ts";

test("a well-formed rpc request validates", () => {
  assert.equal(isParentToChild({ t: "rpc", id: 1, method: "start", args: [] }), true);
});

test("an unknown method is rejected even with a valid envelope", () => {
  assert.equal(isParentToChild({ t: "rpc", id: 1, method: "dropDatabase", args: [] }), false);
});

test("every advertised method passes its own guard", () => {
  for (const m of ENGINE_RPC_METHODS) {
    assert.equal(isEngineRpcMethod(m), true, `${m} must be recognised`);
    assert.equal(isParentToChild({ t: "rpc", id: 1, method: m, args: [] }), true);
  }
  assert.equal(isEngineRpcMethod("constructor"), false, "prototype members must not be callable");
  assert.equal(isEngineRpcMethod("__proto__"), false);
});

test("junk is rejected rather than thrown on", () => {
  for (const junk of [null, undefined, 0, "rpc", [], { t: "nope" }, { t: "rpc" }]) {
    assert.equal(isParentToChild(junk), false, `${JSON.stringify(junk ?? null)} must not validate`);
    assert.equal(isChildToParent(junk), false, `${JSON.stringify(junk ?? null)} must not validate`);
  }
});

test("rpc args must be an array - a non-array would spread into garbage", () => {
  assert.equal(isParentToChild({ t: "rpc", id: 1, method: "start", args: "nope" }), false);
  assert.equal(isParentToChild({ t: "rpc", id: 1, method: "start" }), false);
});

test("rpc ids must be finite numbers - NaN would strand a caller forever", () => {
  assert.equal(isChildToParent({ t: "rpc-res", id: NaN, ok: true, value: 1 }), false);
  assert.equal(isChildToParent({ t: "rpc-res", id: Infinity, ok: true, value: 1 }), false);
  assert.equal(isChildToParent({ t: "rpc-res", id: 3, ok: true, value: 1 }), true);
});

test("an error response carries a string, never an Error instance", () => {
  assert.equal(isChildToParent({ t: "rpc-res", id: 1, ok: false, error: "boom" }), true);
  assert.equal(isChildToParent({ t: "rpc-res", id: 1, ok: false, error: new Error("boom") }), false);
});

test("events are restricted to the three the renderer knows", () => {
  assert.equal(isChildToParent({ t: "event", name: "status-changed", data: {} }), true);
  assert.equal(isChildToParent({ t: "event", name: "conflict-detected", data: {} }), true);
  assert.equal(isChildToParent({ t: "event", name: "error", data: {} }), true);
  assert.equal(isChildToParent({ t: "event", name: "made-up", data: {} }), false);
});

test("the init message needs all three fields", () => {
  assert.equal(isParentToChild({ t: "init", apiBase: "https://x", userDataDir: "/tmp", isDev: false }), true);
  assert.equal(isParentToChild({ t: "init", apiBase: "https://x", userDataDir: "/tmp" }), false);
  assert.equal(isParentToChild({ t: "init", apiBase: 42, userDataDir: "/tmp", isDev: false }), false);
});

test("host calls from the child are restricted to the two env capabilities", () => {
  assert.equal(isChildToParent({ t: "host", id: 1, method: "getSessionCookies", args: [] }), true);
  assert.equal(isChildToParent({ t: "host", id: 1, method: "resolveProxy", args: ["https://x"] }), true);
  assert.equal(isChildToParent({ t: "host", id: 1, method: "readFile", args: ["/etc/passwd"] }), false);
});

test("ready needs no payload", () => {
  assert.equal(isChildToParent({ t: "ready" }), true);
});

test("errorText survives non-Error throws", () => {
  assert.equal(errorText(new Error("boom")), "boom");
  assert.equal(errorText("boom"), "boom");
  assert.equal(errorText({ nope: 1 }), "[object Object]");
  assert.equal(errorText(null), "null");
  assert.equal(errorText(undefined), "undefined");
});

test("errorText never returns an empty string, which would render as a blank error", () => {
  assert.notEqual(errorText(new Error("")), "");
  assert.notEqual(errorText(""), "");
});
