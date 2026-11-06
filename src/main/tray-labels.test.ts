import { test } from "node:test";
import assert from "node:assert/strict";
import { trayFolderName, trayPairLabel } from "./tray-labels.ts";

/** Run with `npm run test:unit`. The tray's per-pair rows, direction aware. */

const FSI = "⁨";
const PDI = "⁩";

test("English pair row is unchanged", () => {
  assert.equal(trayPairLabel("✓", "Work", "Reports", "Synced", "ltr"), "  ✓ Work/Reports - Synced");
  assert.equal(trayPairLabel("•", "Work", "Reports", "", "ltr"), "  • Work/Reports");
});

test("Hebrew pair row isolates the workspace/folder path as one unit", () => {
  assert.equal(trayPairLabel("✓", "ws", "folder", "מסונכרן", "rtl"), `  ✓ ${FSI}ws/folder${PDI} - מסונכרן`);
  assert.equal(trayPairLabel("•", "ws", "folder", "", "rtl"), `  • ${FSI}ws/folder${PDI}`);
});

test("the open-folder submenu name is isolated only in right-to-left", () => {
  assert.equal(trayFolderName("Photos", "ltr"), "Photos");
  assert.equal(trayFolderName("Photos", "rtl"), `${FSI}Photos${PDI}`);
});
