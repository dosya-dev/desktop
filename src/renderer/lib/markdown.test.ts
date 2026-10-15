import { test } from "node:test";
import assert from "node:assert/strict";

import { parseInline, parseMarkdown, isLinkableUrl } from "./markdown.ts";

test("resolves bold, italic, code and links in one line", () => {
  assert.deepEqual(parseInline("a **b** *c* `d` [e](https://x.test)"), [
    { kind: "text", text: "a " },
    { kind: "bold", text: "b" },
    { kind: "text", text: " " },
    { kind: "italic", text: "c" },
    { kind: "text", text: " " },
    { kind: "code", text: "d" },
    { kind: "text", text: " " },
    { kind: "link", text: "e", url: "https://x.test" },
  ]);
});

test("keeps asterisks inside code spans literal, unclosed markers stay text", () => {
  assert.deepEqual(parseInline("`*ptr` rest"), [
    { kind: "code", text: "*ptr" },
    { kind: "text", text: " rest" },
  ]);
  assert.deepEqual(parseInline("2 * 3 = 6"), [{ kind: "text", text: "2 * 3 = 6" }]);
});

test("splits headings, paragraphs and rules", () => {
  const blocks = parseMarkdown("# Title\n\nSome text\nsame paragraph\n\n---\n\nNext");
  assert.deepEqual(blocks.map((b) => b.kind), ["heading", "paragraph", "hr", "paragraph"]);
});

test("keeps code fences verbatim and survives an unclosed fence", () => {
  assert.deepEqual(parseMarkdown("```ts\nconst a = b ** c;\n```"), [
    { kind: "code", text: "const a = b ** c;", lang: "ts" },
  ]);
  assert.deepEqual(parseMarkdown("```\nline1\nline2"), [
    { kind: "code", text: "line1\nline2", lang: null },
  ]);
});

test("collects lists and quotes", () => {
  const blocks = parseMarkdown("- one\n- two\n\n1. first\n2. second\n\n> a\n> b");
  assert.equal(blocks[0].kind, "list");
  assert.equal((blocks[0] as { ordered: boolean }).ordered, false);
  assert.equal((blocks[1] as { ordered: boolean }).ordered, true);
  assert.deepEqual(blocks[2], { kind: "quote", inline: [{ kind: "text", text: "a b" }] });
});

test("classifies only http/https/mailto as linkable", () => {
  assert.equal(isLinkableUrl("https://example.com/"), true);
  assert.equal(isLinkableUrl("http://example.com/"), true);
  assert.equal(isLinkableUrl("mailto:a@b.c"), true);
  assert.equal(isLinkableUrl("javascript:alert(1)"), false);
  assert.equal(isLinkableUrl("JavaScript:alert(1)"), false); // Review Focus #4
  assert.equal(isLinkableUrl("data:text/html,<script>"), false);
  assert.equal(isLinkableUrl("vbscript:msgbox"), false);
  assert.equal(isLinkableUrl("foo/bar"), true); // relative stays renderable
  assert.equal(isLinkableUrl(""), false);
});

test("treats a colon before the first slash as a scheme, not a relative path", () => {
  assert.equal(isLinkableUrl("//evil.example/x"), false); // protocol-relative, inherits whatever scheme embeds it
  assert.equal(isLinkableUrl(":"), false);
  assert.equal(isLinkableUrl("foo/bar:baz"), true); // colon AFTER the first slash is a legal relative path
  assert.equal(isLinkableUrl("#anchor"), true);
  assert.equal(isLinkableUrl("?q=1"), true);
});
