import { test } from "node:test";
import assert from "node:assert/strict";

import { pinchedZoom, steppedZoom, ZOOM_STEPS } from "./pinch-zoom.ts";
import { ZOOM_MAX, ZOOM_MIN } from "../../main/zoom.ts";

test("a pinch follows the fingers: spreading zooms in, pinching back undoes it", () => {
  assert.ok(pinchedZoom(1, -20) > 1);
  assert.ok(pinchedZoom(1, 20) < 1);
  // Chromium reports a pinch to scale s as deltaY = -100 * ln(s).
  assert.ok(Math.abs(pinchedZoom(1, -100 * Math.log(2)) - 2) < 1e-9);
  assert.ok(Math.abs(pinchedZoom(pinchedZoom(1.25, -37), 37) - 1.25) < 1e-9);
});

test("the − and + buttons walk the step list and stop at its ends", () => {
  assert.equal(steppedZoom(1, 1), 1.1);
  assert.equal(steppedZoom(1, -1), 0.9);
  // Off a step (after a pinch), the next step in that direction.
  assert.equal(steppedZoom(1.33, 1), 1.5);
  assert.equal(steppedZoom(1.33, -1), 1.25);
  assert.equal(steppedZoom(3, 1), 3);
  assert.equal(steppedZoom(0.5, -1), 0.5);
});

test("the button steps span exactly the range main allows", () => {
  assert.equal(ZOOM_STEPS[0], ZOOM_MIN);
  assert.equal(ZOOM_STEPS[ZOOM_STEPS.length - 1], ZOOM_MAX);
});
