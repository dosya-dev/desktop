import { test } from "node:test";
import assert from "node:assert/strict";
import { rendererLogLine } from "./renderer-log.ts";

test("drops info and debug, keeps warning and error (Electron 43 details param)", () => {
  assert.equal(rendererLogLine({ level: "info", message: "hi", lineNumber: 1, sourceId: "a.js" }), null);
  assert.equal(rendererLogLine({ level: "debug", message: "hi", lineNumber: 1, sourceId: "a.js" }), null);
  assert.deepEqual(rendererLogLine({ level: "warning", message: "careful", lineNumber: 7, sourceId: "a.js" }), {
    tag: "warn",
    text: "careful  (a.js:7)",
  });
  assert.deepEqual(rendererLogLine({ level: "error", message: "boom", lineNumber: 9, sourceId: "b.js" }), {
    tag: "error",
    text: "boom  (b.js:9)",
  });
});

test("falls back to the deprecated positional args when details has no level", () => {
  // Electron <35 shape, and any future build that stops populating `details`.
  assert.equal(rendererLogLine({} as never, 1, "info line", "a.js", 3), null);
  assert.deepEqual(rendererLogLine({} as never, 3, "boom", "b.js", 9), { tag: "error", text: "boom  (b.js:9)" });
});

test("never throws and never logs 'undefined' when both shapes are absent", () => {
  assert.equal(rendererLogLine(undefined as never), null);
  assert.equal(rendererLogLine({} as never), null);
});
