import { test } from "node:test";
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";

import { formatItemDate } from "./library-request.ts";

/**
 * `npm run test:unit` runs this under plain `node --test`, which on its own
 * cannot load the module under test: file-columns is a `.tsx` (an extension
 * Node refuses outright) and it imports through the `@/` alias that only the
 * bundler and tsc understand. Rather than test a copy of the logic - which
 * would keep passing after the real module broke - the two gaps are bridged
 * here, for this file only:
 *
 *   resolve: `@/x` becomes <renderer>/x, and a specifier with no extension
 *            gets .ts / .tsx / index.ts probed, the way the bundler does.
 *   load:    a .tsx file is handed to Node's type stripper explicitly.
 *
 * Anything under node_modules is left alone, so the real dependency chain
 * (lib/format -> @dosya-dev/shared -> zod) still resolves and loads normally
 * instead of being mistaken for TypeScript. Node runs each test file in its
 * own process, so these hooks never reach another test.
 */
const RENDERER = path.join(import.meta.dirname, "..");

function probe(base: string): string | null {
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts")]) {
    if (existsSync(candidate)) return candidate;
  }
  if ((base.endsWith(".ts") || base.endsWith(".tsx")) && existsSync(base)) return base;
  return null;
}

registerHooks({
  resolve(specifier, context, nextResolve) {
    const parent = context.parentURL ?? "";
    if (parent.includes("/node_modules/")) return nextResolve(specifier, context);
    let target: string | null = null;
    if (specifier.startsWith("@/")) target = path.join(RENDERER, specifier.slice(2));
    else if (specifier.startsWith(".") && parent.startsWith("file:")) {
      target = path.resolve(path.dirname(fileURLToPath(parent)), specifier);
    }
    const hit = target ? probe(target) : null;
    if (hit) return { url: pathToFileURL(hit).href, format: "module-typescript", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.endsWith(".tsx")) {
      return { format: "module-typescript", source: readFileSync(fileURLToPath(url), "utf8"), shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

// The column set reads localStorage on demand, never at module load, so the
// stub only has to be in place before the first loadSavedColumns() call.
// Same Map-backed shape as library-request.test.ts.
interface StorageStub {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

const store = new Map<string, string>();
const stub: StorageStub = {
  getItem: (key) => (store.has(key) ? store.get(key)! : null),
  setItem: (key, value) => { store.set(key, value); },
  removeItem: (key) => { store.delete(key); },
  clear: () => { store.clear(); },
};
(globalThis as unknown as { localStorage: StorageStub }).localStorage = stub;

const {
  ALL_COLUMNS, DEFAULT_VISIBLE, TABLE_COLUMNS_KEY, loadSavedColumns, libraryColumnsFor,
} = await import("./file-columns.tsx");

type Col = { key: string; label: string; width?: number; render: (f: unknown) => unknown };

function keys(columns: Col[]): string[] {
  return columns.map((c) => c.key);
}

function labelOf(columns: Col[], key: string): string {
  return columns.find((c) => c.key === key)!.label;
}

test("libraryColumnsFor(photos) keeps `created` (\"Created\"), with `taken` immediately after it", () => {
  const k = keys(libraryColumnsFor("photos"));
  assert.equal(k[k.indexOf("created") + 1], "taken");
  assert.equal(labelOf(libraryColumnsFor("photos"), "created"), "Created");
  // Nothing else moves: the rest of the order is ALL_COLUMNS untouched.
  assert.deepEqual(k.filter((key) => key !== "taken"), keys(ALL_COLUMNS));
});

test("libraryColumnsFor labels `taken` with the kind's primary date", () => {
  assert.equal(labelOf(libraryColumnsFor("photos"), "taken"), "Date taken");
  assert.equal(labelOf(libraryColumnsFor("videos"), "taken"), "Date created");
  assert.equal(labelOf(libraryColumnsFor("documents"), "taken"), "Date created");
});

// Ruling R8: the library feed's created_at is COALESCE(source_created_at,
// created_at) (display-time.ts), the same expression taken_at resolves to
// for videos and documents - so for those two kinds `created` and `taken`
// would be byte-equal. `created` is dropped and `taken` sits in its slot.
for (const kind of ["videos", "documents"] as const) {
  test(`libraryColumnsFor(${kind}) has no \`created\` column, with \`taken\` where \`created\` was (after \`size\`)`, () => {
    const k = keys(libraryColumnsFor(kind));
    assert.equal(k.includes("created"), false);
    assert.equal(k[k.indexOf("size") + 1], "taken");
    // Nothing else moves: the rest of the order is ALL_COLUMNS minus `created`.
    assert.deepEqual(k.filter((key) => key !== "taken"), keys(ALL_COLUMNS).filter((key) => key !== "created"));
  });
}

test("libraryColumnsFor never mutates ALL_COLUMNS", () => {
  const before = ALL_COLUMNS.map((c: Col) => ({ ...c }));
  libraryColumnsFor("photos");
  libraryColumnsFor("videos");
  libraryColumnsFor("documents");
  assert.deepEqual(ALL_COLUMNS.map((c: Col) => ({ ...c })), before);
  assert.equal(labelOf(ALL_COLUMNS, "created"), "Created");
  assert.equal(ALL_COLUMNS.find((c: Col) => c.key === "taken"), undefined);
});

test("the `taken` cell renders the item's taken_at through formatItemDate", () => {
  const taken = libraryColumnsFor("photos").find((c: Col) => c.key === "taken")!;
  assert.equal(taken.render({ taken_at: 1718445600 }), formatItemDate(1718445600));
  assert.equal(taken.render({ taken_at: 1718445600 }), "Jun 15, 2024");
});

test("loadSavedColumns drops unknown keys and never restores `taken`", () => {
  // `taken` is not in ALL_COLUMNS, so a hand-edited value cannot smuggle the
  // library-only column into the folder listing's table or its picker.
  localStorage.clear();
  localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify(["name", "size", "taken", "was_renamed_away"]));
  assert.deepEqual([...loadSavedColumns()], ["name", "size"]);
});

test("loadSavedColumns always includes `name`, even in a saved selection that dropped it", () => {
  localStorage.clear();
  localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify(["size", "modified"]));
  const columns = loadSavedColumns();
  assert.equal(columns.has("name"), true);
  assert.deepEqual([...columns].sort(), ["modified", "name", "size"].sort());
});

test("loadSavedColumns falls back to the defaults when nothing valid remains", () => {
  localStorage.clear();
  localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify(["taken", "was_renamed_away", 7, null]));
  assert.deepEqual([...loadSavedColumns()], [...DEFAULT_VISIBLE]);
  // An empty saved list is the same case: a table with no columns is not a
  // preference anyone can have expressed on purpose.
  localStorage.setItem(TABLE_COLUMNS_KEY, "[]");
  assert.deepEqual([...loadSavedColumns()], [...DEFAULT_VISIBLE]);
});

test("loadSavedColumns survives garbage JSON, a non-array, and an empty store", () => {
  localStorage.clear();
  assert.deepEqual([...loadSavedColumns()], [...DEFAULT_VISIBLE]);
  localStorage.setItem(TABLE_COLUMNS_KEY, "{not json");
  assert.deepEqual([...loadSavedColumns()], [...DEFAULT_VISIBLE]);
  localStorage.setItem(TABLE_COLUMNS_KEY, JSON.stringify({ name: true }));
  assert.deepEqual([...loadSavedColumns()], [...DEFAULT_VISIBLE]);
});

test("DEFAULT_VISIBLE is the defaultVisible set of ALL_COLUMNS, without `taken`", () => {
  assert.deepEqual([...DEFAULT_VISIBLE], ALL_COLUMNS.filter((c: Col & { defaultVisible: boolean }) => c.defaultVisible).map((c: Col) => c.key));
  assert.equal(DEFAULT_VISIBLE.has("taken"), false);
});
