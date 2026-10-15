import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldReceiveStatus } from "./broadcast-targets.ts";

const win = (o: Partial<{ destroyed: boolean; visible: boolean; minimized: boolean }>) => ({
  isDestroyed: () => o.destroyed ?? false,
  isVisible: () => o.visible ?? true,
  isMinimized: () => o.minimized ?? false,
});

test("a visible window receives status", () => {
  assert.equal(shouldReceiveStatus(win({})), true);
});

test("a destroyed, hidden or minimized window does not", () => {
  assert.equal(shouldReceiveStatus(win({ destroyed: true })), false);
  assert.equal(shouldReceiveStatus(win({ visible: false })), false);
  assert.equal(shouldReceiveStatus(win({ minimized: true })), false);
});

test("a window that reports visible AND minimized does not receive", () => {
  // Review Focus #2 / the platform risk: isVisible() is documented to differ
  // per platform for a minimized window. Either signal alone is enough to skip.
  assert.equal(shouldReceiveStatus(win({ visible: true, minimized: true })), false);
});

test("a probe that throws (window torn down mid-check) is treated as not receiving", () => {
  assert.equal(
    shouldReceiveStatus({
      isDestroyed: () => { throw new Error("gone"); },
      isVisible: () => true,
      isMinimized: () => false,
    }),
    false,
  );
});
