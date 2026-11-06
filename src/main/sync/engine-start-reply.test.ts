import { test } from "node:test";
import assert from "node:assert/strict";
import { engineStartedFromReply } from "./engine-start-reply.ts";

test("an engine that stayed stopped (no session yet) is not running", () => {
  // The bug: launching signed out left the host believing the engine ran,
  // so signing in never started it and every sync folder was skipped.
  assert.equal(engineStartedFromReply(false), false);
});

test("an engine that started is running", () => {
  assert.equal(engineStartedFromReply(true), true);
});

test("a reply from an older engine (null) keeps the old assumption", () => {
  assert.equal(engineStartedFromReply(null), true);
});
