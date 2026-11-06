import { test } from "node:test";
import assert from "node:assert/strict";

import { clearDrafts, draftKey, draftToOffer, loadDraft, saveDraft, type DraftStorage } from "./text-drafts.ts";

/** A Map-backed Storage, with a switch to make every call throw. */
function memoryStorage(): DraftStorage & { map: Map<string, string>; broken: boolean } {
  const map = new Map<string, string>();
  const s = {
    map,
    broken: false,
    get length() { if (s.broken) throw new Error("denied"); return map.size; },
    key(i: number) { if (s.broken) throw new Error("denied"); return [...map.keys()][i] ?? null; },
    getItem(k: string) { if (s.broken) throw new Error("denied"); return map.get(k) ?? null; },
    setItem(k: string, v: string) { if (s.broken) throw new Error("denied"); map.set(k, v); },
    removeItem(k: string) { if (s.broken) throw new Error("denied"); map.delete(k); },
  };
  return s;
}

const ref = { workspaceId: "ws1", fileId: "f1", version: 3 };

test("the key names the workspace, the file and the version", () => {
  assert.equal(draftKey(ref), "dosya_text_draft:ws1:f1:v3");
  assert.notEqual(draftKey(ref), draftKey({ ...ref, version: 4 }));
  assert.notEqual(draftKey(ref), draftKey({ ...ref, workspaceId: "ws2" }));
});

test("a saved draft loads back with its time", () => {
  const s = memoryStorage();
  saveDraft(s, ref, "hello", 1_000);
  assert.deepEqual(loadDraft(s, ref), { text: "hello", savedAt: 1_000 });
});

test("a draft for another version is not this one's", () => {
  const s = memoryStorage();
  saveDraft(s, ref, "hello", 1_000);
  assert.equal(loadDraft(s, { ...ref, version: 4 }), null);
});

test("garbage in storage reads as no draft", () => {
  const s = memoryStorage();
  s.setItem(draftKey(ref), "{not json");
  assert.equal(loadDraft(s, ref), null);
  s.setItem(draftKey(ref), JSON.stringify({ text: 5 }));
  assert.equal(loadDraft(s, ref), null);
});

test("clearing removes every version's draft of the file, and nothing else", () => {
  const s = memoryStorage();
  saveDraft(s, ref, "a", 1);
  saveDraft(s, { ...ref, version: 2 }, "b", 1);
  saveDraft(s, { ...ref, fileId: "f10" }, "other file", 1);
  s.setItem("unrelated", "x");
  clearDrafts(s, { workspaceId: "ws1", fileId: "f1" });
  assert.deepEqual([...s.map.keys()].sort(), ["dosya_text_draft:ws1:f10:v3", "unrelated"]);
});

test("storage that throws never breaks the editor", () => {
  const s = memoryStorage();
  s.broken = true;
  assert.doesNotThrow(() => saveDraft(s, ref, "x", 1));
  assert.equal(loadDraft(s, ref), null);
  assert.doesNotThrow(() => clearDrafts(s, ref));
  assert.equal(draftToOffer(s, ref, { text: "x", updatedAtSec: 0 }), null);
});

test("a draft is offered only when it is newer than the file and differs from it", () => {
  const s = memoryStorage();
  saveDraft(s, ref, "edited", 5_000);
  // Newer than a file last changed at 4 s.
  assert.deepEqual(draftToOffer(s, ref, { text: "original", updatedAtSec: 4 }), { text: "edited", savedAt: 5_000 });
  // The file changed after the draft was written.
  assert.equal(draftToOffer(s, ref, { text: "original", updatedAtSec: 6 }), null);
  // Same text as the file: nothing to restore.
  assert.equal(draftToOffer(s, ref, { text: "edited", updatedAtSec: 4 }), null);
});
