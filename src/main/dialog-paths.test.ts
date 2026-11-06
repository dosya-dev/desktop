import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Run with `npm run test:unit`. A dialog's defaultPath is a file system path:
 * in a right-to-left language the isolating translator would put bidi marks
 * into a file name. Every `defaultPath:` expression stays free of translation.
 */
const FILES = ["ipc.ts", "lan-receive.ts", "vault-save.ts", "sync/ipc-handlers.ts"];

for (const file of FILES) {
  test(`${file}: no defaultPath uses a translator`, () => {
    const src = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
    const lines = src.split("\n").filter((l) => /defaultPath\s*:/.test(l) && !/^\s*(\/\/|\*)/.test(l));
    for (const line of lines) {
      assert.doesNotMatch(line, /\bt\(|\btMain\(|\bisolate\(/, `${file}: ${line.trim()}`);
    }
  });
}

test("the scan finds the defaultPath expressions it guards", () => {
  const n = FILES.map((f) => readFileSync(new URL(`./${f}`, import.meta.url), "utf8"))
    .join("\n").split("\n").filter((l) => /defaultPath\s*:/.test(l)).length;
  assert.ok(n >= 4, `expected at least 4 defaultPath expressions, found ${n}`);
});
