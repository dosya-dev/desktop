import { test } from "node:test";
import assert from "node:assert/strict";

import {
  tileColumns, buildLibraryRows, rowOffsets, rowIndexAtOffset, stickyHeaderIndex,
  type LibraryRow, type RowMetrics, type WindowMonth,
} from "./library-window.ts";

function month(key: string, ids: string[]): WindowMonth {
  return { key, files: ids.map((id) => ({ id })) };
}

const M: RowMetrics = { headerH: 46, itemH: 100, gap: 6 };

const keys = (rows: LibraryRow[]) => rows.map((r) => r.key);
const shape = (rows: LibraryRow[]) =>
  rows.map((r) => (r.type === "header" ? `H${r.month}` : r.type === "items" ? `I${r.month}:${r.from}+${r.count}` : `S${r.count}`));

// ── tileColumns ────────────────────────────────────────────

test("tileColumns matches what CSS auto-fill would pick", () => {
  // 6 columns of 148 + 5 gaps of 6 = 918 <= 918; a 7th would need 1072.
  assert.equal(tileColumns(918, 148, 6), 6);
  assert.equal(tileColumns(1071, 148, 6), 6);
  assert.equal(tileColumns(1072, 148, 6), 7);
});

test("tileColumns never drops below one tile, however narrow the viewport", () => {
  assert.equal(tileColumns(147, 148, 6), 1);
  assert.equal(tileColumns(10, 148, 6), 1);
  assert.equal(tileColumns(0, 148, 6), 1);
  assert.equal(tileColumns(-50, 148, 6), 1);
  assert.equal(tileColumns(Number.NaN, 148, 6), 1);
});

// ── buildLibraryRows ───────────────────────────────────────

test("buildLibraryRows on an empty library is an empty model", () => {
  assert.deepEqual(buildLibraryRows([], 6, 0), []);
});

test("buildLibraryRows gives one short month a header and a single part-filled row", () => {
  const rows = buildLibraryRows([month("2024-06", ["a", "b", "c"])], 6, 0);
  assert.deepEqual(shape(rows), ["H0", "I0:0+3"]);
  assert.deepEqual(keys(rows), ["h:2024-06", "i:a"]);
});

test("buildLibraryRows chunks each month's files into rows of `columns`", () => {
  const ids = Array.from({ length: 13 }, (_, i) => `f${i}`);
  const rows = buildLibraryRows([month("2024-06", ids)], 5, 0);
  assert.deepEqual(shape(rows), ["H0", "I0:0+5", "I0:5+5", "I0:10+3"]);
});

test("buildLibraryRows keeps every month's header, in feed order", () => {
  const rows = buildLibraryRows([month("2024-06", ["a", "b"]), month("2024-05", ["c"])], 2, 0);
  assert.deepEqual(shape(rows), ["H0", "I0:0+2", "H1", "I1:0+1"]);
});

test("buildLibraryRows keeps a header for a month whose files were all de-duplicated away", () => {
  const rows = buildLibraryRows([month("2024-06", []), month("2024-05", ["c"])], 4, 0);
  assert.deepEqual(shape(rows), ["H0", "H1", "I1:0+1"]);
  assert.deepEqual(keys(rows), ["h:2024-06", "h:2024-05", "i:c"]);
});

test("buildLibraryRows appends the load-more skeletons as whole rows at the end", () => {
  const rows = buildLibraryRows([month("2024-06", ["a"])], 4, 6);
  assert.deepEqual(shape(rows), ["H0", "I0:0+1", "S4", "S2"]);
  assert.deepEqual(keys(rows), ["h:2024-06", "i:a", "sk:0", "sk:1"]);
});

test("buildLibraryRows can show skeletons with nothing loaded yet", () => {
  assert.deepEqual(shape(buildLibraryRows([], 3, 3)), ["S3"]);
});

test("buildLibraryRows row keys are unique, so React and the virtualizer agree", () => {
  const rows = buildLibraryRows([month("2024-06", ["a", "b", "c"]), month("2024-05", ["d", "e"])], 2, 4);
  assert.equal(new Set(keys(rows)).size, rows.length);
});

test("buildLibraryRows keys an item row by its first file, so dropping the head does not rename later rows", () => {
  const ids = Array.from({ length: 8 }, (_, i) => `f${i}`);
  const before = buildLibraryRows([month("2024-06", ids)], 4, 0);
  // Whatever removes the first 4 files of the month - a refresh, a delete.
  const after = buildLibraryRows([month("2024-06", ids.slice(4))], 4, 0);
  assert.equal(before[2].key, "i:f4");
  assert.equal(after[1].key, "i:f4");
});

// ── offsets ────────────────────────────────────────────────

test("rowOffsets is cumulative and ends with the total height", () => {
  const rows = buildLibraryRows([month("2024-06", ["a", "b", "c"])], 2, 0);
  // header 46, then two item rows of 100 + 6.
  assert.deepEqual(rowOffsets(rows, M), [0, 46, 152, 258]);
});

test("rowOffsets of an empty model is just the zero total", () => {
  assert.deepEqual(rowOffsets([], M), [0]);
});

test("rowIndexAtOffset finds the row under a scroll position", () => {
  const offsets = [0, 46, 152, 258];
  assert.equal(rowIndexAtOffset(offsets, 0), 0);
  assert.equal(rowIndexAtOffset(offsets, 45), 0);
  assert.equal(rowIndexAtOffset(offsets, 46), 1);
  assert.equal(rowIndexAtOffset(offsets, 151), 1);
  assert.equal(rowIndexAtOffset(offsets, 152), 2);
});

test("rowIndexAtOffset clamps a scroll position past the end, and a negative one", () => {
  const offsets = [0, 46, 152, 258];
  assert.equal(rowIndexAtOffset(offsets, 10_000), 2);
  assert.equal(rowIndexAtOffset(offsets, 258), 2);
  assert.equal(rowIndexAtOffset(offsets, -400), 0);
  assert.equal(rowIndexAtOffset([0], 999), 0);
});

// ── sticky month header ────────────────────────────────────

test("stickyHeaderIndex pins the header of the month the viewport is inside", () => {
  const rows = buildLibraryRows([month("2024-06", ["a", "b", "c", "d"]), month("2024-05", ["e", "f"])], 2, 0);
  // rows: H0 I0 I0 H1 I1
  assert.equal(stickyHeaderIndex(rows, 0), 0);
  assert.equal(stickyHeaderIndex(rows, 1), 0);
  assert.equal(stickyHeaderIndex(rows, 2), 0);
  assert.equal(stickyHeaderIndex(rows, 3), 3);
  assert.equal(stickyHeaderIndex(rows, 4), 3);
});

test("stickyHeaderIndex has nothing to pin for an empty model or an out-of-range index", () => {
  assert.equal(stickyHeaderIndex([], 0), -1);
  const rows = buildLibraryRows([month("2024-06", ["a"])], 2, 0);
  assert.equal(stickyHeaderIndex(rows, 99), 0);
  assert.equal(stickyHeaderIndex(rows, -1), -1);
});

test("stickyHeaderIndex pins nothing when only skeletons are on screen", () => {
  assert.equal(stickyHeaderIndex(buildLibraryRows([], 3, 3), 0), -1);
});
