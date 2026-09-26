import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SNAP_NAME,
  detectDistribution,
  isStoreManaged,
  storeDisplayName,
  storeUpdatesUrl,
} from "./distribution.ts";

/**
 * Run with `npm run test:unit` - Node's own test runner, no Electron.
 *
 * What these pin down: a store install must never self-update (store policy,
 * and two updaters racing for one install), and a direct install must never
 * be mistaken for a store one (that silently switches its updates off).
 */

test("nothing set means a direct download", () => {
  assert.equal(detectDistribution({ env: {} }), "direct");
  assert.equal(detectDistribution({ windowsStore: false, mas: false, env: {} }), "direct");
});

test("the AppX container flag means the Microsoft Store", () => {
  assert.equal(detectDistribution({ windowsStore: true, env: {} }), "ms-store");
});

test("the mas flag means the Mac App Store", () => {
  assert.equal(detectDistribution({ mas: true, env: {} }), "mas");
});

test("snapd's environment for OUR snap means the Snap Store", () => {
  assert.equal(
    detectDistribution({ env: { SNAP: "/snap/dosya/12", SNAP_NAME: SNAP_NAME, SNAP_REVISION: "12" } }),
    "snap",
  );
});

test("another snap's environment does not claim an AppImage run", () => {
  // An AppImage launched from a terminal emulator that is itself a snap
  // inherits that snap's SNAP/SNAP_NAME. Treating it as a store install
  // would disable its updates for good.
  assert.equal(
    detectDistribution({ env: { SNAP: "/snap/alacritty/99", SNAP_NAME: "alacritty" } }),
    "direct",
  );
  assert.equal(detectDistribution({ env: { SNAP_NAME: SNAP_NAME } }), "direct");
});

test("the platform flags win over the environment", () => {
  assert.equal(
    detectDistribution({ windowsStore: true, env: { SNAP: "/x", SNAP_NAME: SNAP_NAME } }),
    "ms-store",
  );
});

test("every store is store-managed, direct is not", () => {
  assert.equal(isStoreManaged("direct"), false);
  assert.equal(isStoreManaged("ms-store"), true);
  assert.equal(isStoreManaged("snap"), true);
  assert.equal(isStoreManaged("mas"), true);
});

test("store names and update pages", () => {
  assert.equal(storeDisplayName("direct"), null);
  assert.equal(storeDisplayName("ms-store"), "Microsoft Store");
  assert.equal(storeDisplayName("snap"), "Snap Store");
  assert.equal(storeDisplayName("mas"), "Mac App Store");
  assert.equal(storeUpdatesUrl("ms-store"), "ms-windows-store://downloadsandupdates");
  assert.equal(storeUpdatesUrl("mas"), "macappstore://showUpdatesPage");
  // snapd refreshes on its own; there is no page to send the user to.
  assert.equal(storeUpdatesUrl("snap"), null);
  assert.equal(storeUpdatesUrl("direct"), null);
});
