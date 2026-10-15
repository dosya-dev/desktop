import { test } from "node:test";
import assert from "node:assert/strict";

import { restoreTarget } from "./view-restore.ts";

// FileBrowserPage's deep-link restore effect used to gate on a one-shot
// "have we ever restored" ref with no `searchParams` in its deps, so a
// `?view=` change on an already-mounted /files page did nothing (OBS-3).
// This is the pure decision it now makes every time the params change,
// keyed on "the id we last restored" instead - see the module header for
// why that specific memory is the loop guard against the url-mirror effect.

test("first mount with ?view=X restores X as the viewer", () => {
  const params = new URLSearchParams("view=file_2");
  assert.deepEqual(restoreTarget(params, null), { type: "restore", id: "file_2", action: "view" });
});

test("first mount with ?panel=X restores X as the detail panel", () => {
  const params = new URLSearchParams("panel=file_2");
  assert.deepEqual(restoreTarget(params, null), { type: "restore", id: "file_2", action: "detail" });
});

test("first mount with neither param does nothing", () => {
  const params = new URLSearchParams("folder=root");
  assert.deepEqual(restoreTarget(params, null), { type: "noop" });
});

test("both view and panel present: view wins, matching today's behaviour", () => {
  const params = new URLSearchParams("view=file_2&panel=file_9");
  assert.deepEqual(restoreTarget(params, null), { type: "restore", id: "file_2", action: "view" });
});

test("?view=X already restored, params unchanged: no-op (the mirror-effect loop guard)", () => {
  const params = new URLSearchParams("view=file_2");
  assert.deepEqual(restoreTarget(params, "file_2"), { type: "noop" });
});

test("?view=X already restored, params now ?view=Y: restores Y", () => {
  const params = new URLSearchParams("view=file_9");
  assert.deepEqual(restoreTarget(params, "file_2"), { type: "restore", id: "file_9", action: "view" });
});

test("?view=X already restored, params now empty: nothing to restore, and memory clears", () => {
  const params = new URLSearchParams("folder=root");
  assert.deepEqual(restoreTarget(params, "file_2"), { type: "clear" });
});

test("after memory clears, the same id restores again instead of being swallowed", () => {
  const cleared = restoreTarget(new URLSearchParams("folder=root"), "file_2");
  assert.deepEqual(cleared, { type: "clear" });
  // The caller resets its ref to null on `clear`; a later return to the same
  // id must be treated as new, not as an echo of what it last restored.
  const again = restoreTarget(new URLSearchParams("view=file_2"), null);
  assert.deepEqual(again, { type: "restore", id: "file_2", action: "view" });
});
