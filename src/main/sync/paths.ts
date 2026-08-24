/**
 * Shared path utilities for the sync engine.
 *
 * Three concerns, one place:
 *  1. Unicode normalization - macOS returns filenames as NFD, most other
 *     systems (and our server) store NFC. Comparing raw strings makes the
 *     same file look different → re-upload loops. We normalize every path
 *     we derive from disk or from the server to NFC before comparing.
 *  2. Case-insensitive filesystems - macOS (default) and Windows treat
 *     "Foo.txt" and "foo.txt" as the same file. Our in-memory indexes must
 *     collapse them to a single key so we don't clobber or duplicate.
 *  3. Windows long paths - paths over 259 chars need the "\\?\" prefix or
 *     fs calls throw ENOENT/ENAMETOOLONG.
 *
 * Keys are computed lazily and never stored in place of the real path - the
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
 * True if `relPath` resolves inside `syncRoot`.
 *
 * Remote file and folder names are workspace-controlled and the reconciler
 * concatenates them into relPaths without sanitising (normalizeRel is NFC only),
 * so a name like ".." reaches every local filesystem sink. Every sink that
 * builds a path from a REMOTE name must gate on this - downloads, folder
 * creation, and moves alike.
 *
 * Both separators are rejected explicitly rather than left to path.resolve:
 * on POSIX a backslash is an ordinary filename character, so resolve() would
 * not see "..\\evil" as traversal, and the engine should fail closed on a
 * snapshot that is dangerous on any host it might also be syncing from.
 *
 * Lives here, exported and pure, rather than as a private engine method so it
 * can be tested directly - the API's folders/batch.ts route is a standing
 * reminder that an unenforced copy of a rule is the one that gets missed.
 */
export function isPathWithinRoot(syncRoot: string, relPath: string): boolean {
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(relPath)) return false;
  for (const segment of relPath.split(/[\\/]/)) {
    if (segment === "." || segment === "..") return false;
  }
  const root = pathResolve(syncRoot);
  const full = pathResolve(root, relPath);
  return full === root || full.startsWith(root + sep);
}

/**
 * Compute the lookup key for a relative path. On case-insensitive
 * filesystems this folds case so that case-only variants collapse to one
 * entry (matching how the OS treats them on disk). The real path is kept
 * separately in the record - this is only for indexing.
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
