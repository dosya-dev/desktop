import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_CSV_RENDER_ROWS, parseCsvTable } from "./csv-table.ts";

test("parses a plain comma file with a header", () => {
  const t = parseCsvTable("name,size,kind\nreport.pdf,12,PDF\nnotes.txt,3,Text\n");
  assert.ok(t);
  assert.deepEqual(t.header, ["name", "size", "kind"]);
  assert.deepEqual(t.rows, [["report.pdf", "12", "PDF"], ["notes.txt", "3", "Text"]]);
  assert.equal(t.columns, 3);
  assert.equal(t.delimiter, ",");
});

test("handles quoted fields containing delimiters, escaped quotes and newlines", () => {
  const t = parseCsvTable('title,note\n"Surname, first","said ""hi""\nand left"\nplain,ok\n');
  assert.ok(t);
  assert.deepEqual(t.rows[0], ["Surname, first", 'said "hi"\nand left']);
});

test("sniffs semicolon and tab delimiters, and quoted commas do not vote", () => {
  assert.equal(parseCsvTable("a;b\n1,5;2,7\n")?.delimiter, ";");
  assert.equal(parseCsvTable("a\tb\n1\t2\n")?.delimiter, "\t");
  assert.equal(parseCsvTable('"Surname, first";age\n"Kaya, F";30\n')?.delimiter, ";");
});

test("pads ragged rows, strips the BOM, honours the render cap", () => {
  assert.deepEqual(parseCsvTable("a,b,c\n1,2\n1,2,3,4\n")?.rows[0], ["1", "2", "", ""]);
  assert.deepEqual(parseCsvTable("﻿a,b\r\n1,2\r\n")?.header, ["a", "b"]);
  const body = "a,b\n" + Array.from({ length: MAX_CSV_RENDER_ROWS + 40 }, (_, i) => `${i},x`).join("\n");
  const t = parseCsvTable(body);
  assert.equal(t?.rows.length, MAX_CSV_RENDER_ROWS);
  assert.equal(t?.truncatedRows, 40);
});

test("refuses shapes that are not usefully tables", () => {
  assert.equal(parseCsvTable("just a sentence with no structure"), null);
  assert.equal(parseCsvTable("one\ntwo\nthree\n"), null);
  assert.equal(parseCsvTable("a,b\n"), null);
});
