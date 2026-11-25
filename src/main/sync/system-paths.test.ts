import { test } from "node:test";
import assert from "node:assert/strict";
import { forbiddenSyncRootReason } from "./system-paths.ts";

// The 2026-08-20 stress test synced /usr on Linux: ~500K root-owned files,
// EACCES churn, and an OOM-killed session. The 2026-08 ignore-rules rework
// deliberately removed system names from the engine's ignore list (so a
// project's own bin/ folder syncs), which means the guard has to live at
// pair-add time instead: refuse system trees as sync ROOTS.

const HOME_MAC = "/Users/firat";
const HOME_LINUX = "/home/firat";
const HOME_WIN = "C:\\Users\\firat";

test("darwin denies system trees, root, and ~/Library", () => {
  for (const p of ["/usr", "/usr/share", "/", "/System/Library", "/etc", "/var/log", `${HOME_MAC}/Library/Preferences`]) {
    assert.notEqual(forbiddenSyncRootReason(p, "darwin", HOME_MAC), null, p);
  }
});

test("darwin denies the home folder itself but allows folders inside it", () => {
  assert.notEqual(forbiddenSyncRootReason(HOME_MAC, "darwin", HOME_MAC), null);
  assert.equal(forbiddenSyncRootReason(`${HOME_MAC}/Downloads`, "darwin", HOME_MAC), null);
  assert.equal(forbiddenSyncRootReason("/Users/firat/Projects", "darwin", HOME_MAC), null);
});

test("linux denies /usr and friends", () => {
  for (const p of ["/usr", "/usr/bin", "/etc", "/", "/var", "/boot", "/root"]) {
    assert.notEqual(forbiddenSyncRootReason(p, "linux", HOME_LINUX), null, p);
  }
});

test("linux allows user data, including folders NAMED like system dirs", () => {
  assert.equal(forbiddenSyncRootReason("/home/firat/data", "linux", HOME_LINUX), null);
  // A project folder called usr/ is the user's own - only absolute system
  // roots are forbidden (same principle as the ignore-rules rework).
  assert.equal(forbiddenSyncRootReason("/home/firat/usr", "linux", HOME_LINUX), null);
  assert.equal(forbiddenSyncRootReason("/mnt/backup/photos", "linux", HOME_LINUX), null);
});

test("win32 denies Windows, Program Files, drive roots, and AppData - case-insensitive, any slashes", () => {
  for (const p of ["C:\\Windows\\System32", "c:/program files/foo", "C:\\", "C:\\ProgramData", `${HOME_WIN}\\AppData\\Roaming`]) {
    assert.notEqual(forbiddenSyncRootReason(p, "win32", HOME_WIN), null, p);
  }
});

test("win32 allows normal user folders", () => {
  assert.equal(forbiddenSyncRootReason("C:\\Users\\firat\\Documents", "win32", HOME_WIN), null);
  assert.equal(forbiddenSyncRootReason("D:\\Media\\Photos", "win32", HOME_WIN), null);
});

test("macOS case-insensitivity: /USR is still /usr", () => {
  assert.notEqual(forbiddenSyncRootReason("/USR/share", "darwin", HOME_MAC), null);
});

test("external drives and network shares are ALLOWED - backing up to one is the point", () => {
  // Caught by the desktop e2e suite: /Volumes was on the darwin denylist,
  // which would have refused every USB stick and external SSD - blocking the
  // main use case of a backup app to guard against nothing.
  assert.equal(forbiddenSyncRootReason("/Volumes/Backup SSD/photos", "darwin", HOME_MAC), null);
  assert.equal(forbiddenSyncRootReason("/Volumes/Backup SSD", "darwin", HOME_MAC), null);
  assert.equal(forbiddenSyncRootReason("/mnt/nas/media", "linux", HOME_LINUX), null);
  assert.equal(forbiddenSyncRootReason("/media/usb0/docs", "linux", HOME_LINUX), null);
});

test("the OS scratch directory is allowed even when it sits inside a denied tree", () => {
  // macOS puts $TMPDIR under /var/folders, which is inside the denied /var.
  // It is per-user scratch space, not the operating system.
  const tmp = "/var/folders/3b/abc/T";
  assert.equal(forbiddenSyncRootReason(`${tmp}/dosya-e2e/photos`, "darwin", HOME_MAC, tmp), null);
  // Without the exemption it stays denied, so the rule is the exemption and
  // not a hole in the denylist.
  assert.notEqual(forbiddenSyncRootReason(`${tmp}/dosya-e2e/photos`, "darwin", HOME_MAC), null);
  // The exemption cannot be abused to unlock a real system tree.
  assert.notEqual(forbiddenSyncRootReason("/usr/share", "darwin", HOME_MAC, tmp), null);
});

test("reasons are human-readable sentences", () => {
  const reason = forbiddenSyncRootReason("/usr", "linux", HOME_LINUX);
  assert.match(reason ?? "", /system folder/);
  const root = forbiddenSyncRootReason("/", "linux", HOME_LINUX);
  assert.match(root ?? "", /entire drive/);
  const home = forbiddenSyncRootReason(HOME_LINUX, "linux", HOME_LINUX);
  assert.match(home ?? "", /home folder/);
});

// Bounty (desktop 3.1.10): a pair on ~/.ssh uploaded private keys; a pull pair
// on ~/.config wrote ~/.config/autostart/*.desktop and ~/.config/git/config.
test("credential and autostart folders are refused on every platform, at any depth", () => {
  for (const [platform, home] of [["linux", HOME_LINUX], ["darwin", HOME_MAC], ["win32", HOME_WIN]] as const) {
    const sep = platform === "win32" ? "\\" : "/";
    for (const rel of [".ssh", ".ssh/keys", ".gnupg", ".aws", ".azure", ".config", ".config/autostart", ".kube", ".docker", ".password-store"]) {
      const p = home + sep + rel.split("/").join(sep);
      assert.match(forbiddenSyncRootReason(p, platform, home) ?? "", /credentials|system folder/, `${platform} ${p}`);
    }
  }
  assert.notEqual(forbiddenSyncRootReason(`${HOME_MAC}/Library/LaunchAgents`, "darwin", HOME_MAC), null);
  // The Windows Startup folder lives under %APPDATA%.
  assert.notEqual(
    forbiddenSyncRootReason(`${HOME_WIN}\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs\\Startup`, "win32", HOME_WIN),
    null,
  );
});

test("credential names are only refused directly under home, not as project folders elsewhere", () => {
  assert.equal(forbiddenSyncRootReason(`${HOME_LINUX}/code/dotfiles/.config-backup`, "linux", HOME_LINUX), null);
  assert.equal(forbiddenSyncRootReason(`${HOME_LINUX}/code/.configs`, "linux", HOME_LINUX), null);
  assert.equal(forbiddenSyncRootReason(`${HOME_LINUX}/.configs`, "linux", HOME_LINUX), null);
});

test("a folder that contains the home folder is refused (/home, /Users, C:\\Users)", () => {
  assert.match(forbiddenSyncRootReason("/home", "linux", HOME_LINUX) ?? "", /home folder/);
  assert.match(forbiddenSyncRootReason("/Users", "darwin", HOME_MAC) ?? "", /home folder/);
  assert.match(forbiddenSyncRootReason("C:\\Users", "win32", HOME_WIN) ?? "", /home folder/);
  // A sibling that merely shares a prefix is fine.
  assert.equal(forbiddenSyncRootReason("/home/firat-shared", "linux", HOME_LINUX), null);
});
