import { test } from "node:test";
import assert from "node:assert/strict";
import { ignoreReason, shouldIgnoreEntry } from "./ignore-rules.ts";

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
  assert.equal(shouldIgnoreEntry(".git", true, [], "/p/.git"), false);
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
