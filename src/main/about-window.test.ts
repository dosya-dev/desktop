import { test } from "node:test";
import assert from "node:assert/strict";
import { aboutUrl } from "./about-url.ts";

test("aboutUrl appends the About route to the renderer's base URL", () => {
  assert.equal(aboutUrl("http://localhost:5174"), "http://localhost:5174#/about");
  assert.equal(aboutUrl("app://bundle/index.html"), "app://bundle/index.html#/about");
});

test("aboutUrl replaces any hash the base URL already carries", () => {
  assert.equal(aboutUrl("app://bundle/index.html#/files?folder=x"), "app://bundle/index.html#/about");
});
