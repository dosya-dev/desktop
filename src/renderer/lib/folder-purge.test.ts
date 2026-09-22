import { test } from "node:test";
import assert from "node:assert/strict";

import {
  purgeTrashedFolder,
  purgeSummary,
  bulkPurgeSummary,
  MAX_PURGE_CALLS,
  type PurgeResponse,
} from "./folder-purge.ts";

/**
 * Run with `npm run test:unit` in apps/desktop - Node's own test runner.
 *
 * Permanently deleting a trashed folder is bounded on the server: it works
 * through the folder until its round-trip budget runs out and answers 202
 * `{ complete: false, remaining, files_affected }`, or 200
 * `{ complete: true, remaining: 0 }` when it is finished. The call is
 * idempotent and the folder rows deliberately survive an unfinished pass -
 * they are how the next call re-enumerates what is left.
 *
 * The desktop took the first answer as the whole job and said "permanently
 * deleted" over a folder that was still half full - reporting success over
 * incomplete work. This is the loop that fixes it. (The web has its own copy
 * in apps/web/src/lib/folder-purge.ts; the two apps are separate, so the
 * behaviour is mirrored deliberately rather than imported.)
 */

const page = (over: Partial<PurgeResponse> = {}): PurgeResponse =>
  ({ ok: true, permanent: true, complete: false, remaining: 10, files_affected: 5, ...over });

/** A purgeOnce that answers from a script, then records the call count. */
function scripted(...pages: PurgeResponse[]) {
  let calls = 0;
  const fn = async (): Promise<PurgeResponse> => {
    const body = pages[Math.min(calls, pages.length - 1)];
    calls += 1;
    return body;
  };
  return { fn, calls: () => calls };
}

test("keeps calling while the server says it is not finished, and sums what each pass removed", async () => {
  const s = scripted(
    page({ complete: false, remaining: 120, files_affected: 300 }),
    page({ complete: true, remaining: 0, files_affected: 120 }),
  );
  const outcome = await purgeTrashedFolder(s.fn);
  assert.equal(s.calls(), 2);
  assert.deepEqual(outcome, { complete: true, filesAffected: 420, remaining: 0, calls: 2 });
});

test("a first answer that is already complete is a single call", async () => {
  const s = scripted(page({ complete: true, remaining: 0, files_affected: 3 }));
  const outcome = await purgeTrashedFolder(s.fn);
  assert.equal(s.calls(), 1);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.filesAffected, 3);
});

test("a body with no `complete` field counts as finished - an older API is not hit fifty times", async () => {
  const s = scripted({ ok: true });
  const outcome = await purgeTrashedFolder(s.fn);
  assert.equal(s.calls(), 1);
  assert.equal(outcome.complete, true);
  assert.equal(outcome.filesAffected, 0);
});

test("the pass cap stops a folder that never finishes, and the outcome says so", async () => {
  const s = scripted(page({ complete: false, remaining: 9_999, files_affected: 10 }));
  const outcome = await purgeTrashedFolder(s.fn);
  assert.equal(s.calls(), MAX_PURGE_CALLS);
  assert.equal(MAX_PURGE_CALLS, 50);
  assert.equal(outcome.complete, false);
  assert.equal(outcome.calls, 50);
  assert.equal(outcome.filesAffected, 500);
  assert.equal(outcome.remaining, 9_999);
});

test("the cap is configurable and never below one pass", async () => {
  const s = scripted(page({ complete: false }));
  assert.equal((await purgeTrashedFolder(s.fn, { maxCalls: 3 })).calls, 3);
  const s2 = scripted(page({ complete: false }));
  assert.equal((await purgeTrashedFolder(s2.fn, { maxCalls: 0 })).calls, 1);
});

test("a rejection propagates rather than being retried", async () => {
  let calls = 0;
  const boom = async (): Promise<PurgeResponse> => {
    calls += 1;
    throw new Error("Folder not found");
  };
  await assert.rejects(() => purgeTrashedFolder(boom), /Folder not found/);
  assert.equal(calls, 1);
});

test("a finished purge reads as deleted, with the file count when there was one", () => {
  assert.deepEqual(
    purgeSummary({ complete: true, filesAffected: 420, remaining: 0, calls: 2 }, "Archive"),
    { kind: "success", title: "Deleted", body: '"Archive" and its 420 files were permanently deleted.' },
  );
  assert.equal(
    purgeSummary({ complete: true, filesAffected: 0, remaining: 0, calls: 1 }, "Empty").body,
    '"Empty" was permanently deleted.',
  );
  assert.equal(
    purgeSummary({ complete: true, filesAffected: 1, remaining: 0, calls: 1 }, "One").body,
    '"One" and its 1 file were permanently deleted.',
  );
});

test("an unfinished purge says the folder is still emptying and how to carry on - never that it is gone", () => {
  const msg = purgeSummary({ complete: false, filesAffected: 500, remaining: 9999, calls: 50 }, "Huge");
  assert.equal(msg.kind, "info");
  assert.equal(msg.title, "Still emptying");
  assert.match(msg.body, /"Huge" is very large/);
  assert.match(msg.body, /500 files removed so far/);
  assert.match(msg.body, /9,999 to go/);
  assert.match(msg.body, /again/);
  assert.equal(/permanently deleted/.test(msg.body), false);
});

test("a bulk purge with an unfinished folder does not count it among the deleted items", () => {
  const msg = bulkPurgeSummary({
    deleted: 2,
    failed: 0,
    incomplete: [{ name: "Huge", filesAffected: 500, remaining: 9999 }],
  });
  assert.equal(msg.kind, "info");
  assert.equal(msg.title, "Still emptying");
  assert.match(msg.body, /2 items permanently deleted\./);
  assert.match(msg.body, /"Huge" is very large/);
  assert.match(msg.body, /again/);
});

test("a bulk purge that finished everything reports plain success", () => {
  const msg = bulkPurgeSummary({ deleted: 3, failed: 0, incomplete: [] });
  assert.equal(msg.kind, "success");
  assert.equal(msg.title, "Deleted");
  assert.match(msg.body, /3 items permanently deleted/);
});

test("failures are still reported alongside an unfinished folder", () => {
  const msg = bulkPurgeSummary({
    deleted: 1,
    failed: 2,
    incomplete: [{ name: "Big", filesAffected: 10, remaining: 5 }],
  });
  assert.match(msg.body, /2 items could not be deleted/);
});

test("failures with nothing left emptying stay an error, not a success", () => {
  // The toast that carries this is an error toast, so the kind has to say so -
  // "1 item permanently deleted" in green over two that were refused is the
  // same overstatement in a smaller form.
  const msg = bulkPurgeSummary({ deleted: 1, failed: 2, incomplete: [] });
  assert.equal(msg.kind, "error");
  assert.equal(msg.title, "Some items could not be deleted");
  assert.equal(msg.body, "1 item permanently deleted. 2 items could not be deleted.");
});
