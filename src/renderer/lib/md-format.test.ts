import { test } from "node:test";
import assert from "node:assert/strict";

import { formatMarkdown, type MdEdit, type MdFormat } from "./md-format.ts";

/** Applies an edit and marks the resulting selection with « and » (or | for a cursor). */
function run(input: string, kind: MdFormat): string {
  // Input marks the selection the same way.
  let from: number;
  let to: number;
  let doc: string;
  if (input.includes("|")) {
    from = to = input.indexOf("|");
    doc = input.replace("|", "");
  } else {
    from = input.indexOf("«");
    to = input.indexOf("»") - 1;
    doc = input.replace("«", "").replace("»", "");
  }
  const edit = formatMarkdown(doc, from, to, kind);
  return render(apply(doc, edit), edit);
}

function apply(doc: string, edit: MdEdit): string {
  const sorted = [...edit.changes].sort((a, b) => b.from - a.from);
  let out = doc;
  for (const c of sorted) out = out.slice(0, c.from) + c.insert + out.slice(c.to);
  return out;
}

function render(doc: string, edit: MdEdit): string {
  const { anchor, head } = edit.selection;
  const a = Math.min(anchor, head);
  const b = Math.max(anchor, head);
  if (a === b) return doc.slice(0, a) + "|" + doc.slice(a);
  return doc.slice(0, a) + "«" + doc.slice(a, b) + "»" + doc.slice(b);
}

// ── Inline wraps ────────────────────────────────────────────

test("bold wraps the selection and keeps it selected", () => {
  assert.equal(run("say «hello» now", "bold"), "say **«hello»** now");
});

test("bold on a cursor inserts a pair with the cursor inside", () => {
  assert.equal(run("say | now", "bold"), "say **|** now");
});

test("bold toggles off when the markers sit just outside the selection", () => {
  assert.equal(run("say **«hello»** now", "bold"), "say «hello» now");
});

test("bold toggles off when the selection includes the markers", () => {
  assert.equal(run("say «**hello**» now", "bold"), "say «hello» now");
});

test("bold on an empty pair removes it", () => {
  assert.equal(run("say **|** now", "bold"), "say | now");
});

test("italic uses underscores, so it never confuses bold markers", () => {
  assert.equal(run("«word»", "italic"), "_«word»_");
  assert.equal(run("_«word»_", "italic"), "«word»");
  assert.equal(run("**«word»**", "italic"), "**_«word»_**");
});

test("inline code wraps one line in backticks and toggles", () => {
  assert.equal(run("run «npm test» now", "code"), "run `«npm test»` now");
  assert.equal(run("run `«npm test»` now", "code"), "run «npm test» now");
});

test("code over several lines becomes a fenced block", () => {
  assert.equal(run("«a\nb»", "code"), "```\n«a\nb»\n```");
});

test("a fenced block selected whole is unwrapped", () => {
  assert.equal(run("«```\na\nb\n```»", "code"), "«a\nb»");
});

// ── Links ───────────────────────────────────────────────────

test("link turns the selection into link text and selects the url", () => {
  assert.equal(run("see «docs» here", "link"), "see [docs](«https://») here");
});

test("link on a cursor leaves the cursor between the brackets", () => {
  assert.equal(run("see | here", "link"), "see [|](https://) here");
});

test("a selected url becomes the target, with the cursor in the text", () => {
  assert.equal(run("«https://dosya.dev»", "link"), "[|](https://dosya.dev)");
});

// ── Line prefixes ───────────────────────────────────────────

test("heading cycles # -> ## -> ### -> none", () => {
  assert.equal(run("Ti|tle", "heading"), "# Ti|tle");
  assert.equal(run("# Ti|tle", "heading"), "## Ti|tle");
  assert.equal(run("## Ti|tle", "heading"), "### Ti|tle");
  assert.equal(run("### Ti|tle", "heading"), "Ti|tle");
});

test("bullet list prefixes every selected line and selects the block", () => {
  assert.equal(run("«one\ntwo»", "bullet"), "«- one\n- two»");
});

test("bullet list toggles off when every line already has it", () => {
  assert.equal(run("«- one\n- two»", "bullet"), "«one\ntwo»");
});

test("blank lines inside a selection are left alone", () => {
  assert.equal(run("«one\n\ntwo»", "bullet"), "«- one\n\n- two»");
});

test("numbered list counts up", () => {
  assert.equal(run("«a\nb\nc»", "numbered"), "«1. a\n2. b\n3. c»");
});

test("switching list types replaces the old marker", () => {
  assert.equal(run("«- a\n- b»", "numbered"), "«1. a\n2. b»");
  assert.equal(run("«1. a\n2. b»", "task"), "«- [ ] a\n- [ ] b»");
  assert.equal(run("- [x] do|ne", "bullet"), "- do|ne");
});

test("task list toggles off a checked item too", () => {
  assert.equal(run("- [x] do|ne", "task"), "do|ne");
});

test("quote prefixes and toggles", () => {
  assert.equal(run("wi|se", "quote"), "> wi|se");
  assert.equal(run("> wi|se", "quote"), "wi|se");
});

test("a selection ending at the start of a line does not touch that line", () => {
  assert.equal(run("«one\n»two", "quote"), "«> one»\ntwo");
});

test("a cursor on an empty line still gets the prefix", () => {
  assert.equal(run("a\n|\nb", "bullet"), "a\n- |\nb");
});
