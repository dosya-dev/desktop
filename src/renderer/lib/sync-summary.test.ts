import { test } from "node:test";
import assert from "node:assert/strict";

import { workspaceSyncSummary, syncSummaryKey, type SyncSummaryPair } from "./sync-summary.ts";

/**
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner.
 *
 * Pins the reduction that used to live inline in Sidebar.tsx (DSK-002) and
 * the key derived from it, which the sidebar now subscribes to instead of
 * the raw `pairs` array (a new identity on every IPC tick).
 */

const pair = (workspaceId: string, status: string): SyncSummaryPair => ({ workspaceId, status });

test("a pair with an empty workspaceId is skipped entirely", () => {
  const summary = workspaceSyncSummary([pair("", "syncing"), pair("ws_1", "idle")]);
  assert.deepEqual(summary, { ws_1: { syncing: false, error: false, paused: false, count: 1 } });
});

test("status 'syncing' sets syncing", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "syncing")]);
  assert.equal(summary.ws_1.syncing, true);
  assert.equal(summary.ws_1.error, false);
  assert.equal(summary.ws_1.paused, false);
});

test("status 'error' sets error", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "error")]);
  assert.equal(summary.ws_1.error, true);
});

test("status 'needs-confirmation' (a held deletion) also sets error", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "needs-confirmation")]);
  assert.equal(summary.ws_1.error, true);
});

test("status 'needs-permission' (a dropped sandbox grant) also sets error", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "needs-permission")]);
  assert.equal(summary.ws_1.error, true);
});

test("status 'paused' sets paused", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "paused")]);
  assert.equal(summary.ws_1.paused, true);
  assert.equal(summary.ws_1.error, false);
  assert.equal(summary.ws_1.syncing, false);
});

test("an idle pair sets no flag but is still counted", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "idle")]);
  assert.deepEqual(summary.ws_1, { syncing: false, error: false, paused: false, count: 1 });
});

test("count counts every pair with a non-empty workspaceId, across statuses", () => {
  const summary = workspaceSyncSummary([
    pair("ws_1", "syncing"),
    pair("ws_1", "idle"),
    pair("ws_1", "error"),
  ]);
  assert.equal(summary.ws_1.count, 3);
});

test("flags are independent, not mutually exclusive, across pairs in one workspace", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "syncing"), pair("ws_1", "error")]);
  assert.equal(summary.ws_1.syncing, true);
  assert.equal(summary.ws_1.error, true);
  assert.equal(summary.ws_1.paused, false);
});

test("multiple workspaces are kept separate", () => {
  const summary = workspaceSyncSummary([pair("ws_1", "syncing"), pair("ws_2", "error")]);
  assert.equal(summary.ws_1.syncing, true);
  assert.equal(summary.ws_2.error, true);
  assert.equal(Object.keys(summary).length, 2);
});

test("an empty pairs array produces an empty summary and an empty key", () => {
  assert.deepEqual(workspaceSyncSummary([]), {});
  assert.equal(syncSummaryKey([]), "");
});

// ── syncSummaryKey ──────────────────────────────────────────────────

test("key is a primitive string naming each workspace's state", () => {
  const key = syncSummaryKey([pair("ws_1", "syncing"), pair("ws_2", "error")]);
  assert.equal(key, "ws_1:syncing,ws_2:error");
});

test("key is stable across two different array identities with the same content", () => {
  const a = [pair("ws_1", "syncing")];
  const b = [pair("ws_1", "syncing")]; // different array/object identity, same content
  assert.notEqual(a, b);
  assert.equal(syncSummaryKey(a), syncSummaryKey(b));
});

test("key is unaffected by pair order (workspace ids are sorted)", () => {
  const key1 = syncSummaryKey([pair("ws_2", "error"), pair("ws_1", "syncing")]);
  const key2 = syncSummaryKey([pair("ws_1", "syncing"), pair("ws_2", "error")]);
  assert.equal(key1, key2);
});

test("key changes when a workspace's error flag flips on", () => {
  const before = syncSummaryKey([pair("ws_1", "idle")]);
  const after = syncSummaryKey([pair("ws_1", "error")]);
  assert.notEqual(before, after);
});

test("key does not change when a count-only detail changes (same flags, more pairs)", () => {
  const before = syncSummaryKey([pair("ws_1", "syncing")]);
  const after = syncSummaryKey([pair("ws_1", "syncing"), pair("ws_1", "syncing")]);
  assert.equal(before, after);
});

test("key cannot collide between a workspace with combined flags and one with a single flag", () => {
  const combined = syncSummaryKey([pair("ws_1", "syncing"), pair("ws_1", "error")]);
  const single = syncSummaryKey([pair("ws_1", "error")]);
  assert.notEqual(combined, single);
  assert.equal(combined, "ws_1:error+syncing");
  assert.equal(single, "ws_1:error");
});

test("key cannot collide between two distinct workspace sets of the same total size", () => {
  // ws_1 alone syncing+error vs. ws_1 syncing / ws_2 error split across two
  // workspaces - different shapes, must not serialize to the same string.
  const oneWorkspace = syncSummaryKey([pair("ws_1", "syncing"), pair("ws_1", "error")]);
  const twoWorkspaces = syncSummaryKey([pair("ws_1", "syncing"), pair("ws_2", "error")]);
  assert.notEqual(oneWorkspace, twoWorkspaces);
});
