import { test } from "node:test";
import assert from "node:assert/strict";
import {
  foldName, hasProtectedSegment, ignoreReason, isProtectedName, isRemotePathIgnored,
  shouldIgnoreEntry, windowsUnsafePath, windowsUnsafeSegment,
} from "./ignore-rules.ts";

// The 2026-08 /usr report: the engine used to hard-code Linux system names
// (bin, lib, tmp, ...) matched at ANY depth, so syncing /usr silently dropped
// /usr/bin and friends, and a project's own bin/ folder never synced. Those
// names now live in the pair's visible excludedPatterns as "/bin"-style
// absolute entries; the engine keeps only technical rules.

test("system directory names are no longer ignored by bare name", () => {
  for (const name of ["bin", "sbin", "lib", "lib32", "lib64", "tmp", "boot", "snap", "mnt"]) {
    assert.equal(shouldIgnoreEntry(name, true, [], `/usr/${name}`), false, name);
  }
});

test("absolute patterns match only their exact path", () => {
  assert.equal(shouldIgnoreEntry("bin", true, ["/bin"], "/bin"), true);
  assert.equal(shouldIgnoreEntry("bin", true, ["/bin"], "/usr/bin"), false);
  assert.equal(shouldIgnoreEntry("bin", true, ["/bin/"], "/bin"), true);
  // Without an absolute path to compare (defensive callers), never matches.
  assert.equal(shouldIgnoreEntry("bin", true, ["/bin"]), false);
});

test("virtual filesystems are always skipped, at their real mount point only", () => {
  assert.equal(ignoreReason("proc", true, [], "/proc"), "virtual filesystem (always skipped)");
  assert.equal(ignoreReason("sys", true, [], "/sys"), "virtual filesystem (always skipped)");
  assert.equal(ignoreReason("proc", true, [], "/home/u/proc"), null);
  // A FILE named like one is not a mount point.
  assert.equal(ignoreReason("proc", false, [], "/proc"), null);
});

test("the modal's chips are the single source of truth", () => {
  // No hidden engine duplicate: removing the chip really syncs the folder.
  assert.equal(shouldIgnoreEntry("node_modules", true, [], "/p/node_modules"), false);
  assert.equal(shouldIgnoreEntry(".DS_Store", false, [], "/p/.DS_Store"), false);
  // With the chip present, name patterns still match at any depth.
  assert.equal(shouldIgnoreEntry("node_modules", true, ["node_modules"], "/p/a/b/node_modules"), true);
});

test("technical rules stay engine-level and carry their reason", () => {
  assert.equal(ignoreReason("photo.jpg.dosya-sync-tmp", false, []), "internal temp file");
  assert.equal(ignoreReason("~$report.docx", false, []), "transient lock file");
  assert.equal(ignoreReason(".~lock.report.odt#", false, []), "transient lock file");
  assert.equal(ignoreReason("notes.txt~", false, []), "editor backup file");
  // Directory names ending in ~ are real folders, same rule as before.
  assert.equal(ignoreReason("archive~", true, []), null);
});

test("pattern skips name the pattern, for the Activity log", () => {
  assert.equal(ignoreReason("app.log", false, ["*.log"], "/p/app.log"), 'excluded by pattern "*.log"');
  assert.equal(ignoreReason("bin", true, ["/bin"], "/bin"), 'excluded by pattern "/bin"');
});

test("AppleDouble sidecars (._*) are ignored by default - they are metadata, not the user's files", () => {
  // Field report 2026-09-02 (desktop #10): macOS writes "._photo.jpg" beside
  // files on non-HFS volumes (SMB, FAT, exFAT). Syncing them clutters every
  // other device with unreadable 4 KB files and they change on every touch.
  assert.equal(ignoreReason("._photo.jpg", false, []), "AppleDouble metadata file");
  assert.equal(shouldIgnoreEntry("._.DS_Store", false, [], "/Volumes/usb/._.DS_Store"), true);
  // A real file that merely starts with a dot and underscore elsewhere is fine.
  assert.equal(ignoreReason("_.txt", false, []), null);
  assert.equal(ignoreReason(".hidden", false, []), null);
  // Directories named that way are real folders.
  assert.equal(ignoreReason("._cache", true, []), null);
});

// Bounty 2026-11-07, recheck 2026-11-11: removing the ".git" chip (or a remote
// pass that never consulted it) let a workspace member write
// .git/hooks/pre-commit into a local repository. Git metadata is now a
// built-in rule that no exclude list can lift.
test(".git is always ignored, as a folder or a file, in any spelling", () => {
  assert.equal(ignoreReason(".git", true, [], "/p/.git"), "Git metadata (never synced)");
  // A .git FILE redirects Git to another metadata directory.
  assert.equal(shouldIgnoreEntry(".git", false, [], "/p/.git"), true);
  for (const alias of [".GIT", ".Git", ".g\u200Bit", ".git\uFEFF"]) {
    assert.equal(isProtectedName(alias), true, JSON.stringify(alias));
    assert.equal(shouldIgnoreEntry(alias, true, []), true, JSON.stringify(alias));
  }
  assert.equal(isProtectedName(".github"), false);
  assert.equal(isProtectedName("git"), false);
  assert.equal(hasProtectedSegment("src/.git/hooks/pre-commit"), true);
  assert.equal(hasProtectedSegment("src\\.GIT\\config"), true);
  assert.equal(hasProtectedSegment(".github/workflows/ci.yml"), false);
});

test("remote paths under .git are ignored with an empty exclude list", () => {
  assert.equal(isRemotePathIgnored(".git/hooks/pre-commit", false, [], "/root", false), true);
  assert.equal(isRemotePathIgnored("repo/.Git/config", false, [], "/root", false), true);
  assert.equal(isRemotePathIgnored("repo/src/main.ts", false, [], "/root", false), false);
});

test("case-folded excludes use NFC and full case folding", () => {
  // U+212A KELVIN SIGN lower-cases to k; U+017F LONG S only folds via upper case.
  assert.equal(foldName("\u212Aey"), "key");
  assert.equal(foldName("\u017Fecret"), "secret");
  assert.equal(shouldIgnoreEntry("\u212Aeys", true, ["keys"], "/p/\u212Aeys", true), true);
  assert.equal(shouldIgnoreEntry("\u017Fecrets", true, ["secrets"], "/p/x", true), true);
  // An NFD name meets an NFC pattern whether or not the filesystem folds case.
  const nfd = "cafe\u0301";
  assert.equal(shouldIgnoreEntry(nfd, true, ["caf\u00E9"], "/p/x", true), true);
  assert.equal(shouldIgnoreEntry(nfd, true, ["caf\u00E9"], "/p/x", false), true);
  // Case-sensitive filesystems keep case distinct for user patterns.
  assert.equal(shouldIgnoreEntry("Keys", true, ["keys"], "/p/x", false), false);
});

test("Windows alias spellings are refused on win32 only", () => {
  const refused = ["GIT~1", "PROGRA~1", "a:b.txt", ".git::$INDEX_ALLOCATION", ".git.", ".git ", "CON", "con.txt", "NUL.tar.gz", "COM1", "lpt9.log", "AUX "];
  for (const segment of refused) {
    assert.notEqual(windowsUnsafeSegment(segment, "win32"), null, segment);
    assert.equal(windowsUnsafeSegment(segment, "darwin"), null, segment);
    assert.equal(windowsUnsafeSegment(segment, "linux"), null, segment);
  }
  for (const segment of ["report.txt", "backup~2024.txt", "console.log", "COM10", ".gitignore", "notes~"]) {
    assert.equal(windowsUnsafeSegment(segment, "win32"), null, segment);
  }
  assert.match(windowsUnsafePath("GIT~1/hooks/pre-commit", "win32") ?? "", /GIT~1.*short/);
  assert.match(windowsUnsafePath("docs\\a:b.txt", "win32") ?? "", /reserves/);
  assert.equal(windowsUnsafePath("GIT~1/hooks/pre-commit", "darwin"), null);
});
