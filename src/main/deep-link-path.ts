import { isAbsolute, resolve, normalize } from "path";

/**
 * Validation for the folder path carried by a `dosya://sync?path=...` deep
 * link.
 *
 * The link is attacker-reachable: any web page can navigate to a custom scheme,
 * so whatever comes out of here is untrusted input that ends up naming a
 * directory the app will offer to sync. The previous check was a literal
 * `folderPath.includes("..")` plus `isAbsolute`, which:
 *
 *  - missed double-encoded traversal (`%252E%252E` survives the single decode
 *    URLSearchParams performs and reaches the check as the harmless-looking
 *    literal `%2E%2E`),
 *  - missed Windows separators inside otherwise-clean segments,
 *  - never normalised, so the value handed to the renderer could still contain
 *    traversal segments, and
 *  - accepted paths that do not exist or are not directories at all.
 *
 * Returns the resolved absolute path, or null when the input must be rejected.
 * `isDirectory` is injected so the filesystem probe can be stubbed.
 */

const MAX_PATH_CHARS = 1000;
/** Bound on repeated decoding, so a deeply nested encoding can't spin here. */
const MAX_DECODE_PASSES = 5;

/** Decode until the string stops changing, so multi-layer encodings collapse. */
export function fullyDecode(input: string): string | null {
  let current = input;
  for (let i = 0; i < MAX_DECODE_PASSES; i++) {
    let next: string;
    try {
      next = decodeURIComponent(current);
    } catch {
      // Malformed percent-escape - refuse rather than guess.
      return null;
    }
    if (next === current) return current;
    current = next;
  }
  // Still changing after several passes: pathological input, refuse.
  return null;
}

export function validateSyncDeepLinkPath(
  rawPath: string,
  isDirectory: (p: string) => boolean,
): string | null {
  if (!rawPath || rawPath.length > MAX_PATH_CHARS) return null;

  const decoded = fullyDecode(rawPath);
  if (decoded === null || decoded.length > MAX_PATH_CHARS) return null;

  // A NUL truncates the path in some native calls, so "safe.txt\0/../../etc"
  // can validate as one thing and act as another. Other control characters
  // have no business in a path the user picked.
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(decoded)) return null;

  if (!isAbsolute(decoded)) return null;

  // Reject traversal on the SEGMENTS, so it catches both separators on every
  // platform rather than relying on a substring match.
  const segments = decoded.split(/[/\\]+/);
  if (segments.some((s) => s === "..")) return null;

  // normalize() first collapses any remaining oddities (`.` segments, repeated
  // separators); resolve() then produces the absolute form actually used.
  const resolved = resolve(normalize(decoded));
  if (!isAbsolute(resolved)) return null;

  // The strongest gate: a sync source that is not an existing directory is
  // never legitimate, whatever it spells.
  if (!isDirectory(resolved)) return null;

  return resolved;
}
