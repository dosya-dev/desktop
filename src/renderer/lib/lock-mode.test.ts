import { test } from "node:test";
import assert from "node:assert/strict";

import {
  LOCK_MODE_OPTIONS, MIN_LOCK_PASSWORD_LENGTH,
  canApplyLock, describeLockMode, describeLockStatus, describeLockTarget,
  lockActionLabel, passwordFieldLabel, passwordHint,
} from "./lock-mode.ts";

test("offers the three modes in order, with the user-facing labels", () => {
  assert.deepEqual(LOCK_MODE_OPTIONS.map((o) => [o.value, o.label]), [
    ["none", "Unlocked"], ["view_only", "View only"], ["full_lock", "Password"],
  ]);
});

test("describes what each mode allows, per kind", () => {
  assert.equal(describeLockMode("file", "none"), "Anyone with access to it can open, download and edit it.");
  assert.equal(describeLockMode("file", "view_only"), "Members can preview it in the viewer, but not download or edit it.");
  assert.equal(describeLockMode("file", "full_lock"), "Opens only with a password. An unlock lasts an hour, and share links to it stop working while it is locked.");
  assert.equal(describeLockMode("folder", "none"), "Anyone with access to it can open it and work with everything inside.");
  assert.equal(describeLockMode("folder", "view_only"), "Members can browse and preview what is inside, but not download it.");
  assert.equal(describeLockMode("folder", "full_lock"), "Opens only with a password. While it is locked nothing can be added inside and share links to its contents stop working. An unlock lasts an hour.");
});

test("the action label names the change the button will make", () => {
  assert.equal(lockActionLabel({ selected: "none", current: "full_lock" }), "Remove lock");
  assert.equal(lockActionLabel({ selected: "view_only", current: "none" }), "Set view only");
  assert.equal(lockActionLabel({ selected: "full_lock", current: "none" }), "Lock with password");
  assert.equal(lockActionLabel({ selected: "full_lock", current: "full_lock" }), "Update password");
  assert.equal(lockActionLabel({ selected: "none", current: "none", loading: true }), "Apply");
});

test("the button is off until something would change", () => {
  assert.equal(canApplyLock({ selected: "none", current: "none", password: "" }), false);
  assert.equal(canApplyLock({ selected: "view_only", current: "view_only", password: "" }), false);
  assert.equal(canApplyLock({ selected: "none", current: "view_only", password: "" }), true);
  assert.equal(canApplyLock({ selected: "view_only", current: "none", password: "" }), true);
});

test("a password lock needs a password of the minimum length, even as a change", () => {
  assert.equal(MIN_LOCK_PASSWORD_LENGTH, 4);
  assert.equal(canApplyLock({ selected: "full_lock", current: "none", password: "abc" }), false);
  assert.equal(canApplyLock({ selected: "full_lock", current: "none", password: "   abc " }), false);
  assert.equal(canApplyLock({ selected: "full_lock", current: "none", password: "abcd" }), true);
  assert.equal(canApplyLock({ selected: "full_lock", current: "full_lock", password: "" }), false);
  assert.equal(canApplyLock({ selected: "full_lock", current: "full_lock", password: "new-one" }), true);
});

test("nothing can be applied while the current mode is loading", () => {
  assert.equal(canApplyLock({ selected: "none", current: "full_lock", password: "", loading: true }), false);
  assert.equal(canApplyLock({ selected: "full_lock", current: "none", password: "abcd", loading: true }), false);
});

test("the password field asks for a new password only when one already exists", () => {
  assert.equal(passwordFieldLabel("none"), "Password");
  assert.equal(passwordFieldLabel("view_only"), "Password");
  assert.equal(passwordFieldLabel("full_lock"), "New password");
  assert.equal(passwordHint("none"), "At least 4 characters.");
  assert.equal(passwordHint("full_lock"), "At least 4 characters. Replaces the current one.");
});

test("the status line reports the lock's provenance and degrades gracefully", () => {
  assert.equal(describeLockStatus({ lock_mode: "none", locked_by_name: "Firat Kaya", lockedWhen: "2d ago" }), null);
  assert.equal(describeLockStatus({ lock_mode: "full_lock", locked_by_name: "Firat Kaya", lockedWhen: "2d ago" }), "Password lock · set by Firat Kaya, 2d ago");
  assert.equal(describeLockStatus({ lock_mode: "view_only", locked_by_name: "Firat Kaya", lockedWhen: "2d ago" }), "View only · set by Firat Kaya, 2d ago");
  assert.equal(describeLockStatus({ lock_mode: "full_lock", locked_by_name: "Firat Kaya" }), "Password lock · set by Firat Kaya");
  assert.equal(describeLockStatus({ lock_mode: "full_lock", lockedWhen: "2d ago" }), "Password lock · set 2d ago");
  assert.equal(describeLockStatus({ lock_mode: "full_lock" }), "Currently password-locked");
  assert.equal(describeLockStatus({ lock_mode: "view_only", locked_by_name: null, lockedWhen: null }), "Currently view only");
});

test("the target chip summarises folders by contents and files by type", () => {
  assert.equal(describeLockTarget({ kind: "folder", file_count: 128, size: "1.9 GB" }), "Folder · 128 files · 1.9 GB");
  assert.equal(describeLockTarget({ kind: "folder", file_count: 1, size: "12 KB" }), "Folder · 1 file · 12 KB");
  assert.equal(describeLockTarget({ kind: "folder", file_count: 0 }), "Folder · 0 files");
  assert.equal(describeLockTarget({ kind: "folder" }), "Folder");
  assert.equal(describeLockTarget({ kind: "file", extension: "pdf", size: "2.4 MB" }), "PDF · 2.4 MB");
  assert.equal(describeLockTarget({ kind: "file", extension: "", size: "2.4 MB" }), "File · 2.4 MB");
  assert.equal(describeLockTarget({ kind: "file", extension: "jpg" }), "JPG");
  assert.equal(describeLockTarget({ kind: "file" }), "File");
});
