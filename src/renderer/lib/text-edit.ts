// apps/desktop/src/renderer/lib/text-edit.ts
//
// The rules of the Markdown/text editor that are not about drawing it: which
// files it opens, whether a file changed under it, what "Save as copy" names
// the copy, and how words are counted for the status bar.
//
// Framework-free with no "@/" imports, so it runs under `node --test`
// (text-edit.test.ts).

export type TextEditorKind = "markdown" | "text";

/** Same ceiling as the web editor and the viewer's text preview. */
export const TEXT_EDIT_MAX_BYTES = 2 * 1024 * 1024;

/** "markdown" for .md/.markdown, "text" for .txt, null for anything else. */
export function textEditorKind(name: string): TextEditorKind | null {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return null;
  const ext = name.slice(dot + 1).toLowerCase();
  if (ext === "md" || ext === "markdown") return "markdown";
  if (ext === "txt") return "text";
  return null;
}

/**
 * Whether the editor is offered for this file: a kind it edits, small enough,
 * and not behind a password. A password lock hides the bytes everywhere, so
 * the editor would have nothing to load. A view-only file still opens; the
 * server decides whether a new version is allowed.
 */
export function canEditText(file: { name: string; size_bytes: number; lock_mode?: string | null }): boolean {
  return textEditorKind(file.name) !== null
    && file.size_bytes <= TEXT_EDIT_MAX_BYTES
    && file.lock_mode !== "full_lock";
}

export interface FileStamp { current_version?: number | null; updated_at: number }

/**
 * Whether the file moved on since `opened`. The version number is the real
 * signal - a rename, a move or a lock also touch updated_at without changing
 * the content - so updated_at is only the fallback when either side has no
 * version.
 */
export function changedSince(opened: FileStamp, latest: FileStamp): boolean {
  const a = opened.current_version;
  const b = latest.current_version;
  if (typeof a === "number" && typeof b === "number") return a !== b;
  return opened.updated_at !== latest.updated_at;
}

const MAX_COPY_TRIES = 50;

/**
 * "plan.md" -> "plan (copy).md", or the first "plan (copy N).md" not taken.
 * `label` words the base name in the user's language; `taken` asks the
 * folder. Rejects after MAX_COPY_TRIES rather than looping on a folder that
 * answers "taken" for everything.
 */
export async function pickCopyName(
  name: string,
  taken: (candidate: string) => Promise<boolean>,
  label: (base: string, n: number) => string,
): Promise<string> {
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n <= MAX_COPY_TRIES; n++) {
    const candidate = label(base, n) + ext;
    if (!(await taken(candidate))) return candidate;
  }
  throw new Error("no free copy name");
}

const TASK_MARK_RE = /^\s*[-*+] \[[ xX]\]/gm;
const WORDLIKE_RE = /[\p{L}\p{N}]/u;

let segmenter: Intl.Segmenter | null | undefined;
function wordSegmenter(): Intl.Segmenter | null {
  if (segmenter === undefined) {
    segmenter = typeof Intl !== "undefined" && "Segmenter" in Intl ? new Intl.Segmenter(undefined, { granularity: "word" }) : null;
  }
  return segmenter;
}

/**
 * Words as a reader counts them. Markdown punctuation is not a word; a task
 * box's "x" is markup too. Intl.Segmenter splits languages written without
 * spaces (Chinese, Japanese, Thai) into words; without it, runs of letters
 * between spaces and punctuation are counted.
 */
export function countWords(text: string): number {
  const clean = text.replace(TASK_MARK_RE, "");
  const seg = wordSegmenter();
  let n = 0;
  if (seg) {
    for (const s of seg.segment(clean)) if (s.isWordLike) n++;
    return n;
  }
  for (const token of clean.split(/[^\p{L}\p{N}]+/u)) if (WORDLIKE_RE.test(token)) n++;
  return n;
}
