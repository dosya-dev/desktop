import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DRAG_MOVE_TYPE, dragItems, isMoveDrag, isOsFileDrag, isValidDropTarget, encodeMovePayload, decodeMovePayload, itemCount,
} from "./drag-move.ts";

/** Run with `npm run test:unit` in apps/desktop - Node's own test runner. */

const none = new Set<string>();

test("dragging an unselected file carries only that file", () => {
  const r = dragItems({ id: "f9", kind: "file" }, new Set(["f1", "f2"]), new Set(["d1"]));
  assert.deepEqual(r, { fileIds: ["f9"], folderIds: [], fromSelection: false });
});

test("dragging an unselected folder carries only that folder", () => {
  const r = dragItems({ id: "d9", kind: "folder" }, new Set(["f1"]), new Set(["d1"]));
  assert.deepEqual(r, { fileIds: [], folderIds: ["d9"], fromSelection: false });
});

test("dragging a selected item carries the whole selection, files and folders", () => {
  const r = dragItems({ id: "f2", kind: "file" }, new Set(["f1", "f2"]), new Set(["d1"]));
  assert.deepEqual(r, { fileIds: ["f1", "f2"], folderIds: ["d1"], fromSelection: true });
  const r2 = dragItems({ id: "d1", kind: "folder" }, new Set(["f1"]), new Set(["d1", "d2"]));
  assert.deepEqual(r2, { fileIds: ["f1"], folderIds: ["d1", "d2"], fromSelection: true });
});

test("a file id in the folder selection does not count as selected (kinds are separate)", () => {
  const r = dragItems({ id: "x", kind: "file" }, none, new Set(["x"]));
  assert.deepEqual(r, { fileIds: ["x"], folderIds: [], fromSelection: false });
});

test("itemCount adds files and folders", () => {
  assert.equal(itemCount({ fileIds: ["a", "b"], folderIds: ["c"] }), 3);
});

test("isMoveDrag only recognises the custom type", () => {
  assert.equal(isMoveDrag(["Files"]), false);
  assert.equal(isMoveDrag([]), false);
  assert.equal(isMoveDrag(null), false);
  assert.equal(isMoveDrag(["text/plain", DRAG_MOVE_TYPE]), true);
});

test("a sibling folder is a valid target", () => {
  assert.equal(isValidDropTarget("d2", { fileIds: ["f1"], folderIds: ["d1"] }, "parent"), true);
});

test("a folder cannot be dropped onto itself or onto another dragged folder", () => {
  const p = { fileIds: [], folderIds: ["d1", "d2"] };
  assert.equal(isValidDropTarget("d1", p, "parent"), false);
  assert.equal(isValidDropTarget("d2", p, "parent"), false);
  assert.equal(isValidDropTarget("d3", p, "parent"), true);
});

test("the folder the items are already in is not a target", () => {
  const p = { fileIds: ["f1"], folderIds: [] };
  assert.equal(isValidDropTarget("cur", p, "cur"), false);
  // The root, spelt "" in the URL and null on the wire.
  assert.equal(isValidDropTarget(null, p, ""), false);
  assert.equal(isValidDropTarget("", p, null), false);
});

test("the root is a valid target from inside a folder", () => {
  assert.equal(isValidDropTarget(null, { fileIds: ["f1"], folderIds: [] }, "cur"), true);
});

test("an empty drag has no targets", () => {
  assert.equal(isValidDropTarget("d1", { fileIds: [], folderIds: [] }, "cur"), false);
});

test("payload round-trips", () => {
  const p = { fileIds: ["f1", "f2"], folderIds: ["d1"], name: "Report.pdf" };
  assert.deepEqual(decodeMovePayload(encodeMovePayload(p)), p);
});

test("decode refuses anything this app did not write", () => {
  assert.equal(decodeMovePayload(""), null);
  assert.equal(decodeMovePayload(null), null);
  assert.equal(decodeMovePayload("not json"), null);
  assert.equal(decodeMovePayload("[]"), null);
  assert.equal(decodeMovePayload(JSON.stringify({ v: 2, files: ["a"], folders: [] })), null);
  assert.equal(decodeMovePayload(JSON.stringify({ v: 1, files: [1], folders: [] })), null);
  assert.equal(decodeMovePayload(JSON.stringify({ v: 1, files: [""], folders: [] })), null);
  assert.equal(decodeMovePayload(JSON.stringify({ v: 1, files: [], folders: [] })), null);
});

test("decode tolerates a missing name", () => {
  assert.deepEqual(decodeMovePayload(JSON.stringify({ v: 1, files: ["a"], folders: [] })), { fileIds: ["a"], folderIds: [], name: "" });
});

test("isOsFileDrag is true for files from the computer, never for an in-app move", () => {
  assert.equal(isOsFileDrag(["Files"]), true);
  assert.equal(isOsFileDrag(["text/plain", "Files"]), true);
  assert.equal(isOsFileDrag([DRAG_MOVE_TYPE]), false);
  assert.equal(isOsFileDrag([DRAG_MOVE_TYPE, "Files"]), false);
  assert.equal(isOsFileDrag(["text/plain"]), false);
  assert.equal(isOsFileDrag(null), false);
});
