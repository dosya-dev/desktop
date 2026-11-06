import { test } from "node:test";
import assert from "node:assert/strict";

import { guardNavigation, setNavGuard } from "./nav-guard.ts";

test("with no guard, navigation goes ahead", () => {
  let went = 0;
  guardNavigation(() => { went++; });
  assert.equal(went, 1);
});

test("a guard can hold the navigation and run it later", () => {
  let held: (() => void) | null = null;
  const release = setNavGuard((proceed) => { held = proceed; return true; });
  let went = 0;
  guardNavigation(() => { went++; });
  assert.equal(went, 0);
  held!();
  assert.equal(went, 1);
  release();
});

test("a guard that declines lets it through", () => {
  const release = setNavGuard(() => false);
  let went = 0;
  guardNavigation(() => { went++; });
  assert.equal(went, 1);
  release();
});

test("releasing removes only that guard", () => {
  const releaseA = setNavGuard(() => true);
  const releaseB = setNavGuard(() => true);
  releaseA(); // stale release: B stays
  let went = 0;
  guardNavigation(() => { went++; });
  assert.equal(went, 0);
  releaseB();
  guardNavigation(() => { went++; });
  assert.equal(went, 1);
});
