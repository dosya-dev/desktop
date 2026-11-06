// Ported from apps/web/src/lib/lock-mode.ts - keep in sync with the web copy.
//
// The lock dialog's model: everything the dialog says, decided in one place so
// the three clients describe the same lock_mode the same way. Only relative
// `.ts` imports (no `@/` alias), so `node --test` can load it without a bundler.
// Text goes through `tl` at call time, in the language current at that moment.

import { tl } from "./locale-state.ts";
import type { MessageKey } from "../../i18n/keys.ts";

export type LockMode = "none" | "view_only" | "full_lock";
export type LockKind = "file" | "folder";

/** The server rejects anything shorter (POST /api/files/:id/lock). */
export const MIN_LOCK_PASSWORD_LENGTH = 8;

/** One mode. `label` is read at render, so it is always in the current language. */
function option(value: LockMode, key: MessageKey): { value: LockMode; readonly label: string } {
  return { value, get label() { return tl(key); } };
}

export const LOCK_MODE_OPTIONS: readonly { value: LockMode; readonly label: string }[] = [
  option("none", "file-security.label.unlocked"),
  option("view_only", "common.status.viewOnly"),
  option("full_lock", "common.label.password"),
];

// Each sentence maps to shipped behaviour in the API's download-guard and
// share lock-gate: view_only denies the bytes but not the preview; full_lock
// hands out one-hour unlock tokens, seals a folder against additions, and
// refuses share links to the item.
const DESCRIPTIONS: Record<LockKind, Record<LockMode, MessageKey>> = {
  file: {
    none: "file-security.label.anyoneWithAccessToItCanOpenDownloadAnd",
    view_only: "file-security.label.membersCanPreviewItInTheViewerButNot",
    full_lock: "file-security.description.opensOnlyWithAPasswordAnUnlockLastsAn",
  },
  folder: {
    none: "file-security.label.anyoneWithAccessToItCanOpenItAnd",
    view_only: "file-security.label.membersCanBrowseAndPreviewWhatIsInsideBut",
    full_lock: "file-security.description.opensOnlyWithAPasswordWhileItIsLocked",
  },
};

export function describeLockMode(kind: LockKind, mode: LockMode): string {
  return tl(DESCRIPTIONS[kind][mode]);
}

/** What the primary button will do. Neutral while the current mode is unknown. */
export function lockActionLabel(input: { selected: LockMode; current: LockMode; loading?: boolean }): string {
  if (input.loading) return tl("file-security.apply");
  if (input.selected === "none") return tl("file-security.action.removeLock");
  if (input.selected === "view_only") return tl("file-security.action.setViewOnly");
  return tl(input.current === "full_lock" ? "file-security.action.updatePassword" : "file-security.action.lockWithPassword");
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
  return tl(current === "full_lock" ? "common.label.newPassword" : "common.label.password");
}

export function passwordHint(current: LockMode): string {
  const values = { minLockPasswordLength: MIN_LOCK_PASSWORD_LENGTH };
  return current === "full_lock"
    ? tl("file-security.label.atLeastMinLockPasswordLengthCharactersReplacesTheCurrentOne", values)
    : tl("file-security.label.atLeastMinLockPasswordLengthCharacters", values);
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
  if (!by && !when) return tl(mode === "full_lock" ? "file-security.label.currentlyPasswordLocked" : "file-security.label.currentlyViewOnly");
  // One message per shape, with the mode as a select, so each language words the whole line.
  const which = mode === "full_lock" ? "password" : "viewOnly";
  if (by && when) return tl("file-security.label.passwordLockSetByByWhen", { mode: which, by, when });
  if (by) return tl("file-security.label.passwordLockSetByBy", { mode: which, by });
  return tl("file-security.label.passwordLockSetWhen", { mode: which, when: when ?? "" });
}

/** The chip under the title. `size` is pre-formatted; unknown parts are left out. */
export function describeLockTarget(input: { kind: LockKind; extension?: string | null; size?: string | null; file_count?: number | null }): string {
  const parts: string[] = [];
  if (input.kind === "folder") {
    parts.push(tl("common.label.folder"));
    if (typeof input.file_count === "number") parts.push(tl("common.label.fileSentenceCase", { fileCount: input.file_count }));
  } else {
    const ext = input.extension?.trim();
    parts.push(ext ? ext.toUpperCase() : tl("common.label.fileTitleCase"));
  }
  if (input.size) parts.push(input.size);
  return parts.join(" · ");
}
