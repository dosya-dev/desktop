import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLocale, writeLocale } from "./locale-store.ts";

const fresh = () => mkdtempSync(join(tmpdir(), "locale-store-"));

test("a missing file reads as en", async () => {
  const dir = fresh();
  assert.equal(await readLocale(dir), "en");
  rmSync(dir, { recursive: true });
});

test("a stored locale is read back", async () => {
  const dir = fresh();
  writeFileSync(join(dir, "locale.json"), '{"locale":"de"}');
  assert.equal(await readLocale(dir), "de");
  rmSync(dir, { recursive: true });
});

for (const [name, body] of [
  ["unknown locale", '{"locale":"xx"}'],
  ["not json", "not json"],
  ["empty file", ""],
  ["non-string locale", '{"locale":5}'],
] as const) {
  test(`${name} reads as en`, async () => {
    const dir = fresh();
    writeFileSync(join(dir, "locale.json"), body);
    assert.equal(await readLocale(dir), "en");
    rmSync(dir, { recursive: true });
  });
}

test("write then read round-trips and leaves no temp file", async () => {
  const dir = join(fresh(), "nested");
  await writeLocale(dir, "tr");
  assert.equal(await readLocale(dir), "tr");
  assert.deepEqual(readdirSync(dir), ["locale.json"]);
  rmSync(join(dir, ".."), { recursive: true });
});
