// apps/desktop/src/renderer/lib/md-format.ts
//
// The Markdown toolbar of the text editor, as pure functions on text and a
// selection. Each command answers with the changes to make and where the
// selection lands afterwards, so the editor applies it as one transaction
// (one undo step) and the logic stays testable without CodeMirror.
//
// Framework-free with no "@/" imports, so it runs under `node --test`
// (md-format.test.ts).

export type MdFormat =
  | "bold" | "italic" | "heading"
  | "bullet" | "numbered" | "task"
  | "link" | "code" | "quote";

export interface MdChange { from: number; to: number; insert: string }

export interface MdEdit {
  /** Non-overlapping changes, positions in the ORIGINAL document. */
  changes: MdChange[];
  /** Selection after the changes, positions in the NEW document. */
  selection: { anchor: number; head: number };
}

const URL_RE = /^https?:\/\/\S+$/i;
const LINK_PLACEHOLDER = "https://";

export function formatMarkdown(doc: string, from: number, to: number, kind: MdFormat): MdEdit {
  if (to < from) [from, to] = [to, from];
  switch (kind) {
    case "bold": return wrap(doc, from, to, "**");
    case "italic": return wrap(doc, from, to, "_");
    case "code": return doc.slice(from, to).includes("\n") ? fence(doc, from, to) : wrap(doc, from, to, "`");
    case "link": return link(doc, from, to);
    default: return prefixLines(doc, from, to, kind);
  }
}

// ── Inline ───────────────────────────────────────────────────

function wrap(doc: string, from: number, to: number, marker: string): MdEdit {
  const m = marker.length;
  const sel = doc.slice(from, to);
  // The selection carries the markers itself: "**hello**" -> "hello".
  if (sel.length >= 2 * m && sel.startsWith(marker) && sel.endsWith(marker)) {
    const inner = sel.slice(m, sel.length - m);
    return { changes: [{ from, to, insert: inner }], selection: { anchor: from, head: from + inner.length } };
  }
  // The markers sit just outside it: **[hello]** -> [hello], and **|** -> |.
  if (doc.slice(from - m, from) === marker && doc.slice(to, to + m) === marker && from - m >= 0) {
    return {
      changes: [{ from: from - m, to: from, insert: "" }, { from: to, to: to + m, insert: "" }],
      selection: { anchor: from - m, head: to - m },
    };
  }
  return {
    changes: [{ from, to, insert: marker + sel + marker }],
    selection: { anchor: from + m, head: to + m },
  };
}

const FENCE_RE = /^```[^\n]*\n([\s\S]*)\n```$/;

function fence(doc: string, from: number, to: number): MdEdit {
  const sel = doc.slice(from, to);
  const fenced = FENCE_RE.exec(sel);
  if (fenced) {
    const inner = fenced[1];
    return { changes: [{ from, to, insert: inner }], selection: { anchor: from, head: from + inner.length } };
  }
  // A fence has to own its lines, so break out of a line the selection starts or ends inside.
  const before = from > 0 && doc[from - 1] !== "\n" ? "\n" : "";
  const after = to < doc.length && doc[to] !== "\n" ? "\n" : "";
  const open = before + "```\n";
  return {
    changes: [{ from, to, insert: open + sel + "\n```" + after }],
    selection: { anchor: from + open.length, head: from + open.length + sel.length },
  };
}

function link(doc: string, from: number, to: number): MdEdit {
  const sel = doc.slice(from, to);
  if (sel === "" || URL_RE.test(sel.trim())) {
    const target = sel === "" ? LINK_PLACEHOLDER : sel.trim();
    return { changes: [{ from, to, insert: `[](${target})` }], selection: { anchor: from + 1, head: from + 1 } };
  }
  const urlStart = from + sel.length + 3; // "[" + text + "]("
  return {
    changes: [{ from, to, insert: `[${sel}](${LINK_PLACEHOLDER})` }],
    selection: { anchor: urlStart, head: urlStart + LINK_PLACEHOLDER.length },
  };
}

// ── Line prefixes ───────────────────────────────────────────

type LineKind = "heading" | "bullet" | "numbered" | "task" | "quote";

const TASK_RE = /^(\s*)[-*+] \[[ xX]\] /;
const BULLET_RE = /^(\s*)[-*+] /;
const NUMBERED_RE = /^(\s*)\d+[.)] /;
const HEADING_RE = /^(#{1,6}) /;
const QUOTE_RE = /^> ?/;

function listKind(line: string): "task" | "bullet" | "numbered" | null {
  if (TASK_RE.test(line)) return "task";
  if (BULLET_RE.test(line)) return "bullet";
  if (NUMBERED_RE.test(line)) return "numbered";
  return null;
}

/** The line without any list marker, and the indent the marker sat after. */
function stripList(line: string): { indent: string; rest: string } {
  for (const re of [TASK_RE, BULLET_RE, NUMBERED_RE]) {
    const m = re.exec(line);
    if (m) return { indent: m[1], rest: line.slice(m[0].length) };
  }
  const indent = /^\s*/.exec(line)![0];
  return { indent, rest: line.slice(indent.length) };
}

function prefixLines(doc: string, from: number, to: number, kind: LineKind): MdEdit {
  const lineStart = doc.lastIndexOf("\n", from - 1) + 1;
  // A selection that ends at the very start of a line has not chosen that line.
  const effTo = to > from && doc[to - 1] === "\n" ? to - 1 : to;
  const nl = doc.indexOf("\n", effTo);
  const lineEnd = nl === -1 ? doc.length : nl;
  const oldBlock = doc.slice(lineStart, lineEnd);
  const lines = oldBlock.split("\n");
  const single = lines.length === 1;
  const counts = (line: string) => single || line.trim() !== "";
  const touched = lines.filter(counts);

  let next: string[];
  if (kind === "heading") {
    next = lines.map((line) => {
      if (!counts(line)) return line;
      const m = HEADING_RE.exec(line);
      const level = m ? m[1].length : 0;
      const rest = m ? line.slice(m[0].length) : line;
      const to = level >= 3 ? 0 : level + 1;
      return to === 0 ? rest : "#".repeat(to) + " " + rest;
    });
  } else if (kind === "quote") {
    const on = touched.length > 0 && touched.every((l) => QUOTE_RE.test(l));
    next = lines.map((line) => {
      if (!counts(line)) return line;
      return on ? line.replace(QUOTE_RE, "") : "> " + line;
    });
  } else {
    const on = touched.length > 0 && touched.every((l) => listKind(l) === kind);
    let n = 0;
    next = lines.map((line) => {
      if (!counts(line)) return line;
      const { indent, rest } = stripList(line);
      if (on) return indent + rest;
      n++;
      const marker = kind === "bullet" ? "- " : kind === "task" ? "- [ ] " : `${n}. `;
      return indent + marker + rest;
    });
  }

  const newBlock = next.join("\n");
  const changes = [{ from: lineStart, to: lineEnd, insert: newBlock }];
  if (from === to) {
    // A cursor stays where it was in the text, shifted by what changed in front of it.
    const col = from - lineStart;
    const delta = newBlock.length - oldBlock.length;
    const pos = lineStart + Math.min(newBlock.length, Math.max(0, col + delta));
    return { changes, selection: { anchor: pos, head: pos } };
  }
  return { changes, selection: { anchor: lineStart, head: lineStart + newBlock.length } };
}
