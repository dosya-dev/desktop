import { test } from "node:test";
import assert from "node:assert/strict";

import { challengeCorsHeaders, rendererOrigin } from "./edge-challenge.ts";

const ALLOWED = ["app://bundle", "http://localhost:5174"];
const challenge = () => ({
  "content-type": ["text/html; charset=UTF-8"],
  "cf-mitigated": ["challenge"],
});

test("a Cloudflare challenge gets a CORS grant for the app's own origin (QA TC-014/015)", () => {
  const out = challengeCorsHeaders(challenge(), "app://bundle", ALLOWED);
  assert.ok(out);
  assert.deepEqual(out["Access-Control-Allow-Origin"], ["app://bundle"]);
  assert.deepEqual(out["Access-Control-Allow-Credentials"], ["true"]);
  assert.deepEqual(out["Access-Control-Expose-Headers"], ["cf-mitigated"]);
  assert.deepEqual(out["cf-mitigated"], ["challenge"], "original headers are kept");
});

test("an ordinary API response is left alone", () => {
  assert.equal(challengeCorsHeaders({ "content-type": ["application/json"] }, "app://bundle", ALLOWED), null);
  assert.equal(challengeCorsHeaders(undefined, "app://bundle", ALLOWED), null);
});

test("a response that already has its own CORS grant is left alone", () => {
  const h = { ...challenge(), "Access-Control-Allow-Origin": ["app://bundle"] };
  assert.equal(challengeCorsHeaders(h, "app://bundle", ALLOWED), null);
});

test("never grants an origin outside the allowlist", () => {
  assert.equal(challengeCorsHeaders(challenge(), "https://evil.example", ALLOWED), null);
  assert.equal(challengeCorsHeaders(challenge(), "app://bundle.evil", ALLOWED), null);
  assert.equal(challengeCorsHeaders(challenge(), null, ALLOWED), null);
});

test("header names are matched case-insensitively", () => {
  const out = challengeCorsHeaders({ "CF-Mitigated": ["challenge"] }, "app://bundle", ALLOWED);
  assert.ok(out);
});

test("rendererOrigin keeps the app: scheme's host instead of the opaque 'null'", () => {
  assert.equal(rendererOrigin("app://bundle/index.html#/login"), "app://bundle");
  assert.equal(rendererOrigin("http://localhost:5174/#/signup"), "http://localhost:5174");
  assert.equal(rendererOrigin(""), null);
  assert.equal(rendererOrigin(undefined), null);
  assert.equal(rendererOrigin("not a url"), null);
});
