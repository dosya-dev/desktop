/**
 * Shared path utilities for the sync engine.
 *
 * Three concerns, one place:
 *  1. Unicode normalization — macOS returns filenames as NFD, most other
 *     systems (and our server) store NFC. Comparing raw strings makes the
 *     same file look different → re-upload loops. We normalize every path
 *     we derive from disk or from the server to NFC before comparing.
 *  2. Case-insensitive filesystems — macOS (default) and Windows treat
 *     "Foo.txt" and "foo.txt" as the same file. Our in-memory indexes must
 *     collapse them to a single key so we don't clobber or duplicate.
 *  3. Windows long paths — paths over 259 chars need the "\\?\" prefix or
 *     fs calls throw ENOENT/ENAMETOOLONG.
 *
 * Keys are computed lazily and never stored in place of the real path — the
 * real (case- and NFC-preserving) path is always what we write to disk and
 * persist in state. Keys exist only for map lookups, so this adds no
 * meaningful memory (one transient string per lookup, GC'd immediately).
 */

import { relative, sep, resolve as pathResolve } from "path";

/** True on filesystems that are case-insensitive by default. */
const CASE_INSENSITIVE = process.platform === "darwin" || process.platform === "win32";

/**
 * Normalize an absolute path to a forward-slash, NFC-normalized relative path.
 * This is THE canonical relative-path form used throughout the engine.
 */
export function toRelPath(root: string, absPath: string): string {
  return relative(root, absPath).split(sep).join("/").normalize("NFC");
}

/** Normalize an already-relative path (forward-slash) to canonical NFC form. */
export function normalizeRel(relPath: string): string {
  return relPath.normalize("NFC");
}

/**
 * Compute the lookup key for a relative path. On case-insensitive
 * filesystems this folds case so that case-only variants collapse to one
 * entry (matching how the OS treats them on disk). The real path is kept
 * separately in the record — this is only for indexing.
 */
export function pathKey(relPath: string): string {
  const nfc = relPath.normalize("NFC");
  return CASE_INSENSITIVE ? nfc.toLowerCase() : nfc;
}

/** Key for an absolute path (used by the recent-download suppression map). */
export function absKey(absPath: string): string {
  const nfc = absPath.normalize("NFC");
  return CASE_INSENSITIVE ? nfc.toLowerCase() : nfc;
}

/**
 * On Windows, prefix paths over the legacy MAX_PATH limit with "\\?\" so
 * fs operations don't fail. No-op on other platforms and for short paths.
 */
export function longPath(p: string): string {
  if (process.platform !== "win32") return p;
  if (p.length <= 259 || p.startsWith("\\\\?\\")) return p;
  return `\\\\?\\${pathResolve(p)}`;
}
