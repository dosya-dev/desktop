/**
 * Naming for conflict copies.
 *
 * When both sides changed the same file since the last sync, the safe move is
 * to keep both and let the user choose - the alternative is silently throwing
 * away somebody's edit. The copy's name has to answer the question the user
 * will actually ask when they see two files: WHEN did this fork, and WHERE did
 * the other version come from.
 *
 * Hence date, time and device, in that order. Seconds matter: a fast
 * edit-sync-edit cycle produces two conflicts on the same day from the same
 * machine, and a date alone would collide. If even the second collides, a
 * numeric suffix breaks the tie rather than overwriting - which would destroy
 * the very edit this exists to preserve.
 *
 * Pure (the clock, the hostname and the "does this exist" check are all
 * injected) so the rules are testable without a filesystem.
 */

/** Split a FILE NAME into base and extension. */
function splitExtension(fileName: string): { base: string; ext: string } {
  const dotIdx = fileName.lastIndexOf(".");
  // dotIdx > 0 guards dotfiles (".env" is all base, no extension).
  if (dotIdx <= 0) return { base: fileName, ext: "" };
  return { base: fileName.substring(0, dotIdx), ext: fileName.substring(dotIdx) };
}

/** "2026-08-21 14-33-05" - filename-safe, sorts chronologically. */
export function conflictStamp(at: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())} ` +
    `${p(at.getHours())}-${p(at.getMinutes())}-${p(at.getSeconds())}`;
}

/** Strip characters that are illegal in a filename on any supported platform. */
function safeDevice(device: string): string {
  const cleaned = device.replace(/[\\/:*?"<>|]/g, "").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 40) : "another device";
}

export interface ConflictNameInput {
  /** The file's name, WITHOUT its directory. */
  fileName: string;
  at: Date;
  device: string;
  /** True when that name is already taken in the same folder. */
  taken: (candidate: string) => boolean;
}

/**
 * The name for a conflict copy of `fileName`, guaranteed not to be `taken`.
 *
 * The extension is preserved so the copy still opens in the same application -
 * a conflict copy nobody can double-click is a conflict copy nobody reads.
 */
export function conflictCopyName(input: ConflictNameInput): string {
  const { base, ext } = splitExtension(input.fileName);
  const label = `(conflict copy ${conflictStamp(input.at)} from ${safeDevice(input.device)})`;

  const first = `${base} ${label}${ext}`;
  if (!input.taken(first)) return first;

  // Same file, same second, same device: number the copies rather than
  // overwrite one - losing an edit here would defeat the whole point.
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base} ${label} #${n}${ext}`;
    if (!input.taken(candidate)) return candidate;
  }
  // Pathological: fall back to something unique rather than returning a name
  // known to be taken.
  return `${base} ${label} #${Date.now()}${ext}`;
}
