// Ported from apps/web/src/lib/lock-mode.ts - keep in sync with the web copy.
//
// The lock dialog's model: everything the dialog says, decided in one place so
// the three clients describe the same lock_mode the same way. Self-contained on
// purpose (no imports) so `node --test` can load it without a bundler.

export type LockMode = "none" | "view_only" | "full_lock";
export type LockKind = "file" | "folder";

/** The server rejects anything shorter (POST /api/files/:id/lock). */
export const MIN_LOCK_PASSWORD_LENGTH = 4;

export const LOCK_MODE_OPTIONS: readonly { value: LockMode; label: string }[] = [
  { value: "none", label: "Unlocked" },
  { value: "view_only", label: "View only" },
  { value: "full_lock", label: "Password" },
];

// Each sentence maps to shipped behaviour in the API's download-guard and
// share lock-gate: view_only denies the bytes but not the preview; full_lock
// hands out one-hour unlock tokens, seals a folder against additions, and
// refuses share links to the item.
const DESCRIPTIONS: Record<LockKind, Record<LockMode, string>> = {
  file: {
    none: "Anyone with access to it can open, download and edit it.",
    view_only: "Members can preview it in the viewer, but not download or edit it.",
    full_lock: "Opens only with a password. An unlock lasts an hour, and share links to it stop working while it is locked.",
  },
  folder: {
    none: "Anyone with access to it can open it and work with everything inside.",
    view_only: "Members can browse and preview what is inside, but not download it.",
    full_lock: "Opens only with a password. While it is locked nothing can be added inside and share links to its contents stop working. An unlock lasts an hour.",
  },
};

export function describeLockMode(kind: LockKind, mode: LockMode): string {
  return DESCRIPTIONS[kind][mode];
}

/** What the primary button will do. Neutral while the current mode is unknown. */
export function lockActionLabel(input: { selected: LockMode; current: LockMode; loading?: boolean }): string {
  if (input.loading) return "Apply";
  if (input.selected === "none") return "Remove lock";
  if (input.selected === "view_only") return "Set view only";
  return input.current === "full_lock" ? "Update password" : "Lock with password";
}

/**
 * Whether pressing the button would do anything the server accepts. A password
 * lock always needs a password - the server has no "keep the old one" path -
 * so re-choosing Password on a locked item is a password change, not a no-op.
 */
export function canApplyLock(input: { selected: LockMode; current: LockMode; password: string; loading?: boolean }): boolean {
  if (input.loading) return false;
  if (input.selected === "full_lock") return input.password.trim().length >= MIN_LOCK_PASSWORD_LENGTH;
  return input.selected !== input.current;
}

export function passwordFieldLabel(current: LockMode): string {
  return current === "full_lock" ? "New password" : "Password";
}

export function passwordHint(current: LockMode): string {
  const base = `At least ${MIN_LOCK_PASSWORD_LENGTH} characters.`;
  return current === "full_lock" ? `${base} Replaces the current one.` : base;
}

/**
 * The "already locked" line. `lockedWhen` is pre-formatted by the caller
 * (each client has its own relative-time helper). Null when there is no lock.
 */
export function describeLockStatus(input: { lock_mode: string; locked_by_name?: string | null; lockedWhen?: string | null }): string | null {
  const mode = input.lock_mode;
  if (mode !== "full_lock" && mode !== "view_only") return null;
  const by = input.locked_by_name?.trim();
  const when = input.lockedWhen?.trim();
  if (!by && !when) return mode === "full_lock" ? "Currently password-locked" : "Currently view only";
  const base = mode === "full_lock" ? "Password lock" : "View only";
  if (by && when) return `${base} · set by ${by}, ${when}`;
  if (by) return `${base} · set by ${by}`;
  return `${base} · set ${when}`;
}

/** The chip under the title. `size` is pre-formatted; unknown parts are left out. */
export function describeLockTarget(input: { kind: LockKind; extension?: string | null; size?: string | null; file_count?: number | null }): string {
  const parts: string[] = [];
  if (input.kind === "folder") {
    parts.push("Folder");
    if (typeof input.file_count === "number") parts.push(`${input.file_count} ${input.file_count === 1 ? "file" : "files"}`);
  } else {
    const ext = input.extension?.trim();
    parts.push(ext ? ext.toUpperCase() : "File");
  }
  if (input.size) parts.push(input.size);
  return parts.join(" · ");
}
