import { test } from "node:test";
import assert from "node:assert/strict";
import { showsBillingTab, showsUpdateControls } from "./store-surfaces.ts";

/**
 * Billing: App Store Review Guideline 3.1.1 forbids linking out to an external
 * purchase from a Mac App Store app, and the app sells nothing in-app, so the
 * store build has no Billing tab at all. Other channels keep it.
 *
 * Update controls: every store delivers its own updates and the updater
 * reports "store-managed" there, so "Check for updates" would be a dead
 * button on any store build, not just Apple's.
 */
test("billing is hidden only on the Mac App Store build", () => {
  assert.equal(showsBillingTab("mas"), false);
  assert.equal(showsBillingTab("direct"), true);
  assert.equal(showsBillingTab("ms-store"), true);
  assert.equal(showsBillingTab("snap"), true);
  assert.equal(showsBillingTab(null), true, "unknown yet: do not flash the tab away");
});

test("update controls show only on the direct download", () => {
  assert.equal(showsUpdateControls("direct"), true);
  assert.equal(showsUpdateControls(null), true);
  assert.equal(showsUpdateControls("mas"), false);
  assert.equal(showsUpdateControls("ms-store"), false);
  assert.equal(showsUpdateControls("snap"), false);
});
