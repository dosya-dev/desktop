import { test } from "node:test";
import assert from "node:assert/strict";

import {
  libraryRequestPath, mergeLibraryPages, formatItemDate, kindForFilter, sortOptionsFor, plural,
  defaultLayoutFor, loadLibraryLayouts, saveLibraryLayout, LIBRARY_LAYOUT_KEY,
  LIBRARY_PAGE_SIZE, type LibraryPage, type LibraryItem,
} from "./library-request.ts";

function item(id: string, taken_at = 0): LibraryItem {
  return {
    id, name: `${id}.jpg`, size_bytes: 1, mime_type: "image/jpeg", extension: ".jpg", region: "eu",
    created_at: taken_at, updated_at: taken_at, current_version: 1, lock_mode: "none", is_hidden: 0,
    hidden_mode: "none", uploaded_by: "u1", uploader_name: "Me", share_count: 0, comment_count: 0,
    is_synced: 0, origin: null, folder_id: null, taken_at,
  };
}

test("kindForFilter maps the sidebar's type filters to a library kind", () => {
  assert.equal(kindForFilter("images"), "photos");
  assert.equal(kindForFilter("videos"), "videos");
  assert.equal(kindForFilter("documents"), "documents");
  assert.equal(kindForFilter("starred"), null);
});

test("sortOptionsFor labels the primary date per kind", () => {
  assert.equal(sortOptionsFor("videos")[0].label, "Date created · newest");
  assert.equal(sortOptionsFor("photos")[1].label, "Date taken · oldest");
});

test("plural formats the noun for the kind and count", () => {
  assert.equal(plural("documents", 1), "1 document");
  assert.equal(plural("videos", 23), "23 videos");
});

test("libraryRequestPath builds the first page and adds kind/q/cursor only when present", () => {
  assert.equal(
    libraryRequestPath({ workspaceId: "ws_1", kind: "photos", sort: "taken_desc", q: "" }, null),
    `/api/library?workspace_id=ws_1&kind=photos&limit=${LIBRARY_PAGE_SIZE}&sort=taken_desc`,
  );
  assert.equal(
    libraryRequestPath({ workspaceId: "ws_1", kind: "documents", sort: "taken_asc", q: "ice" }, "abc"),
    `/api/library?workspace_id=ws_1&kind=documents&limit=${LIBRARY_PAGE_SIZE}&sort=taken_asc&q=ice&cursor=abc`,
  );
});

test("mergeLibraryPages continues a month across pages and keeps first-page counts", () => {
  const p1: LibraryPage = {
    ok: true, kind: "photos", total: 5, counts: { "2024-07": 2, "2024-06": 3 }, can_lock: true,
    months: [
      { key: "2024-07", label: "July 2024", files: [item("a", 7), item("b", 6)] },
      { key: "2024-06", label: "June 2024", files: [item("c", 5)] },
    ],
    next_cursor: "cur1",
  };
  const p2: LibraryPage = { ok: true, kind: "photos", months: [{ key: "2024-06", label: "June 2024", files: [item("d", 4), item("e", 3)] }], next_cursor: null };
  const lib = mergeLibraryPages([p1, p2]);
  assert.deepEqual(lib.months.map((m) => m.key), ["2024-07", "2024-06"]);
  assert.deepEqual(lib.months[1].files.map((f) => f.id), ["c", "d", "e"]);
  assert.equal(lib.months[1].count, 3);
  assert.equal(lib.total, 5);
  assert.equal(lib.loaded, 5);
  assert.equal(lib.hasMore, false);
  assert.equal(lib.canLock, true);
  const partial = mergeLibraryPages([p1]);
  assert.equal(partial.hasMore, true);
  assert.equal(partial.months[1].count, 3);
  assert.equal(partial.months[1].files.length, 1);
  assert.deepEqual(mergeLibraryPages([]).months, []);
});

test("mergeLibraryPages deduplicates files across pages", () => {
  const p1: LibraryPage = {
    ok: true, kind: "photos", total: 4, counts: { "2024-07": 2, "2024-06": 2 },
    months: [
      { key: "2024-07", label: "July 2024", files: [item("a", 7), item("b", 6)] },
      { key: "2024-06", label: "June 2024", files: [item("c", 5)] },
    ],
    next_cursor: "cur1",
  };
  const p2: LibraryPage = { ok: true, kind: "photos", months: [{ key: "2024-06", label: "June 2024", files: [item("c", 5), item("d", 4)] }], next_cursor: null };
  const lib = mergeLibraryPages([p1, p2]);
  assert.deepEqual(lib.files.map((f) => f.id), ["a", "b", "c", "d"]);
});

test("formatItemDate renders a short date", () => {
  assert.equal(formatItemDate(1718445600), "Jun 15, 2024");
});

// ── Per-kind layout preference ─────────────────────────────
// `node --test` has no DOM, so the helpers get the smallest localStorage that
// satisfies them: getItem/setItem/removeItem/clear over a Map. Installed once
// on globalThis and cleared before each layout test, so one test's saved
// preference never leaks into the next.

interface StorageStub {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function installStorage(): { store: Map<string, string>; fail: (on: boolean) => void } {
  const store = new Map<string, string>();
  let failing = false;
  const stub: StorageStub = {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      if (failing) throw new Error("QuotaExceededError");
      store.set(key, value);
    },
    removeItem: (key) => { store.delete(key); },
    clear: () => { store.clear(); },
  };
  (globalThis as unknown as { localStorage: StorageStub }).localStorage = stub;
  return { store, fail: (on: boolean) => { failing = on; } };
}

const storage = installStorage();

function resetStorage() {
  storage.fail(false);
  globalThis.localStorage.clear();
}

test("defaultLayoutFor puts documents in a list and photos/videos in a grid", () => {
  resetStorage();
  assert.equal(defaultLayoutFor("documents"), "list");
  assert.equal(defaultLayoutFor("photos"), "grid");
  assert.equal(defaultLayoutFor("videos"), "grid");
});

test("loadLibraryLayouts falls back to the per-kind defaults with nothing saved", () => {
  resetStorage();
  assert.deepEqual(loadLibraryLayouts(), { photos: "grid", videos: "grid", documents: "list" });
});

test("saveLibraryLayout round-trips through loadLibraryLayouts", () => {
  resetStorage();
  saveLibraryLayout("photos", "list");
  assert.deepEqual(loadLibraryLayouts(), { photos: "list", videos: "grid", documents: "list" });
});

test("saveLibraryLayout read-merge-writes: setting one kind never disturbs another", () => {
  resetStorage();
  saveLibraryLayout("photos", "list");
  saveLibraryLayout("videos", "list");
  saveLibraryLayout("documents", "grid");
  assert.deepEqual(loadLibraryLayouts(), { photos: "list", videos: "list", documents: "grid" });
});

test("loadLibraryLayouts falls back to the defaults on garbage JSON without throwing", () => {
  resetStorage();
  globalThis.localStorage.setItem(LIBRARY_LAYOUT_KEY, "{not json");
  assert.deepEqual(loadLibraryLayouts(), { photos: "grid", videos: "grid", documents: "list" });
});

test("loadLibraryLayouts ignores an unknown kind and an invalid layout value", () => {
  resetStorage();
  globalThis.localStorage.setItem(LIBRARY_LAYOUT_KEY, JSON.stringify({ photos: "list", bogus_kind: "grid", videos: "sideways" }));
  assert.deepEqual(loadLibraryLayouts(), { photos: "list", videos: "grid", documents: "list" });
});

test("loadLibraryLayouts falls back to the defaults when the saved JSON is null or an array", () => {
  resetStorage();
  globalThis.localStorage.setItem(LIBRARY_LAYOUT_KEY, "null");
  assert.deepEqual(loadLibraryLayouts(), { photos: "grid", videos: "grid", documents: "list" });
  globalThis.localStorage.setItem(LIBRARY_LAYOUT_KEY, "[]");
  assert.deepEqual(loadLibraryLayouts(), { photos: "grid", videos: "grid", documents: "list" });
});

test("saveLibraryLayout swallows a storage write failure instead of throwing", () => {
  resetStorage();
  storage.fail(true);
  assert.doesNotThrow(() => saveLibraryLayout("photos", "list"));
  storage.fail(false);
});
