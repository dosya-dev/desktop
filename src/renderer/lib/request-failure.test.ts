// node --test resolves imports literally: the ".ts" extension is required.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { EDGE_CHALLENGE_CODE, isAbortError, isEdgeChallenge } from "./request-failure.ts";

const headers = (h: Record<string, string>) => ({
  get: (name: string) => h[name.toLowerCase()] ?? null,
});

describe("isEdgeChallenge", () => {
  it("recognises Cloudflare's challenge marker (QA TC-014/015)", () => {
    assert.equal(isEdgeChallenge(headers({ "cf-mitigated": "challenge" })), true);
    assert.equal(isEdgeChallenge(headers({ "cf-mitigated": " Challenge " })), true);
  });

  it("does not fire for an ordinary API answer", () => {
    assert.equal(isEdgeChallenge(headers({})), false);
    assert.equal(isEdgeChallenge(headers({ "content-type": "application/json" })), false);
    assert.equal(isEdgeChallenge(headers({ "cf-mitigated": "" })), false);
  });

  it("has a stable error code", () => {
    assert.equal(EDGE_CHALLENGE_CODE, "edge_challenge");
  });
});

describe("isAbortError", () => {
  it("passes a deliberate cancellation through", () => {
    assert.equal(isAbortError(new DOMException("aborted", "AbortError")), true);
    assert.equal(isAbortError({ name: "AbortError" }), true);
  });

  it("treats a network failure as something else", () => {
    assert.equal(isAbortError(new TypeError("Failed to fetch (api.dosya.dev)")), false);
    assert.equal(isAbortError(null), false);
    assert.equal(isAbortError(undefined), false);
  });
});
