import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  dispatchMenuAction,
  subscribeMenuActions,
  reportMenuState,
  currentMenuState,
} from "./menu-bus.ts";

/**
 * Run with `npm run test:unit`. No window here: the bus must work without
 * electronAPI (component tests under jsdom have none either), and the
 * outbound report must simply skip the IPC when there is nothing to send to.
 */

beforeEach(() => {
  // Each test subscribes its own handlers and unsubscribes them.
});

test("page handlers win over fallbacks, and a consumed action stops there", () => {
  const seen: string[] = [];
  const offFallback = subscribeMenuActions(() => { seen.push("fallback"); return true; }, { fallback: true });
  const offPage = subscribeMenuActions(() => { seen.push("page"); return true; });
  assert.equal(dispatchMenuAction({ kind: "simple", id: "find" }), true);
  assert.deepEqual(seen, ["page"]);
  offPage();
  offFallback();
});

test("a handler that returns nothing passes the action on to the fallback", () => {
  const seen: string[] = [];
  const offFallback = subscribeMenuActions(() => { seen.push("fallback"); return true; }, { fallback: true });
  const offPage = subscribeMenuActions(() => { seen.push("page"); });
  assert.equal(dispatchMenuAction({ kind: "simple", id: "find" }), true);
  assert.deepEqual(seen, ["page", "fallback"]);
  offPage();
  offFallback();
});

test("nobody listening means the action is reported unconsumed", () => {
  assert.equal(dispatchMenuAction({ kind: "navigate", path: "/files" }), false);
});

test("reportMenuState merges partial updates and ignores undefined fields", () => {
  reportMenuState({ route: "/files", selectionCount: 2 });
  reportMenuState({ viewMode: "card", route: undefined });
  const s = currentMenuState();
  assert.equal(s.route, "/files");
  assert.equal(s.selectionCount, 2);
  assert.equal(s.viewMode, "card");
  reportMenuState({ route: "/", selectionCount: 0, viewMode: null });
});
