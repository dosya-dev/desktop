import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

import { EXTERNAL_KEYS } from "./external-keys.ts";

/**
 * EXTERNAL_KEYS is a copy of what the catalog says the sync engine and the
 * reader libraries emit. Checked against the source catalog when it is here
 * (the public mirror has no packages/).
 */
const CATALOG = new URL("../../../../packages/i18n/desktop/en.catalog.json", import.meta.url);
const ROOTS = ["src/main/sync/", "src/engine/", "src/renderer/lib/reader/"];

test("EXTERNAL_KEYS matches the catalog's engine and reader-library uses", { skip: !existsSync(CATALOG) }, () => {
  const catalog = JSON.parse(readFileSync(CATALOG, "utf8")) as { strings: { key: string; uses: string[] }[] };
  const expected = catalog.strings
    .filter((s) => s.uses.some((u) => ROOTS.some((r) => u.startsWith(r)) && !u.includes("readerThemes")))
    .map((s) => s.key)
    .sort();
  assert.deepEqual([...EXTERNAL_KEYS], expected);
});

test("every external key exists in the vendored English messages", () => {
  const en = JSON.parse(readFileSync(new URL("./messages/en.json", import.meta.url), "utf8")) as Record<string, string>;
  for (const k of EXTERNAL_KEYS) assert.ok(k in en, k);
});
