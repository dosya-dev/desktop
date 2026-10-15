import { test } from "node:test";
import assert from "node:assert/strict";
import { conflictCopyName, conflictStamp, isConflictCopyName, mayAutoKeepBoth, AUTO_KEEP_BOTH_COOLDOWN_MS } from "./conflict-name.ts";

const AT = new Date(2026, 7, 21, 14, 33, 5); // 2026-08-21 14:33:05 local
const never = () => false;

test("the stamp is filename-safe and sorts chronologically", () => {
  assert.equal(conflictStamp(AT), "2026-08-21 14-33-05");
  assert.equal(conflictStamp(new Date(2026, 0, 2, 3, 4, 5)), "2026-01-02 03-04-05");
});

test("a copy keeps its extension so it still opens in the same app", () => {
  assert.equal(
    conflictCopyName({ fileName: "report.docx", at: AT, device: "MacBook", taken: never }),
    "report (conflict copy 2026-08-21 14-33-05 from MacBook).docx",
  );
});

test("an extensionless file gets the label appended, not a mangled name", () => {
  assert.equal(
    conflictCopyName({ fileName: "Makefile", at: AT, device: "MacBook", taken: never }),
    "Makefile (conflict copy 2026-08-21 14-33-05 from MacBook)",
  );
});

test("a dotfile keeps its leading dot and is not split at it", () => {
  assert.equal(
    conflictCopyName({ fileName: ".env", at: AT, device: "MacBook", taken: never }),
    ".env (conflict copy 2026-08-21 14-33-05 from MacBook)",
  );
});

test("only the LAST dot separates the extension", () => {
  assert.equal(
    conflictCopyName({ fileName: "archive.tar.gz", at: AT, device: "MacBook", taken: never }),
    "archive.tar (conflict copy 2026-08-21 14-33-05 from MacBook).gz",
  );
});

test("a second conflict in the same second is numbered, never overwritten", () => {
  // Overwriting here would destroy the edit the conflict copy exists to save.
  const first = "notes (conflict copy 2026-08-21 14-33-05 from MacBook).txt";
  const name = conflictCopyName({
    fileName: "notes.txt", at: AT, device: "MacBook",
    taken: (c) => c === first,
  });
  assert.equal(name, "notes (conflict copy 2026-08-21 14-33-05 from MacBook) #2.txt");
});

test("numbering keeps climbing past several collisions", () => {
  const takenSet = new Set([
    "notes (conflict copy 2026-08-21 14-33-05 from MacBook).txt",
    "notes (conflict copy 2026-08-21 14-33-05 from MacBook) #2.txt",
    "notes (conflict copy 2026-08-21 14-33-05 from MacBook) #3.txt",
  ]);
  const name = conflictCopyName({
    fileName: "notes.txt", at: AT, device: "MacBook", taken: (c) => takenSet.has(c),
  });
  assert.equal(name, "notes (conflict copy 2026-08-21 14-33-05 from MacBook) #4.txt");
});

test("device names that would break a path are cleaned up", () => {
  const name = conflictCopyName({
    fileName: "a.txt", at: AT, device: 'Fi/rat\\s:Mac*?"<>|', taken: never,
  });
  assert.match(name, /from FiratsMac\)\.txt$/);
  assert.equal(name.includes("/"), false);
  assert.equal(name.includes("\\"), false);
});

test("an empty or whitespace device still yields a usable name", () => {
  assert.match(
    conflictCopyName({ fileName: "a.txt", at: AT, device: "   ", taken: never }),
    /from another device\)\.txt$/,
  );
});

test("an absurdly long device name is truncated rather than blowing the path limit", () => {
  const name = conflictCopyName({ fileName: "a.txt", at: AT, device: "M".repeat(300), taken: never });
  assert.ok(name.length < 120, `name was ${name.length} chars`);
});

test("the result is never a name that is already taken", () => {
  // The one property that actually matters: whatever comes back is free.
  const taken = new Set<string>();
  for (let i = 0; i < 20; i++) {
    const name = conflictCopyName({
      fileName: "dup.bin", at: AT, device: "Mac", taken: (c) => taken.has(c),
    });
    assert.equal(taken.has(name), false);
    taken.add(name);
  }
  assert.equal(taken.size, 20);
});

test("conflict copies are recognised, with or without a tie-break number", () => {
  const copy = conflictCopyName({ fileName: "p777.jpg", at: AT, device: "Frats-MacBook-Air.local", taken: never });
  assert.equal(isConflictCopyName(copy), true);
  assert.equal(isConflictCopyName("report (conflict copy 2026-08-21 14-33-05 from MacBook) #2.docx"), true);
  assert.equal(isConflictCopyName("p777.jpg"), false);
  assert.equal(isConflictCopyName("notes on (conflict copy) naming.txt"), false);
});

test("a conflict copy is never copied again automatically", () => {
  const copy = conflictCopyName({ fileName: "p777.jpg", at: AT, device: "MacBook", taken: never });
  assert.equal(mayAutoKeepBoth({ fileName: copy, lastAutoAt: undefined, now: 0 }), false);
});

test("a path kept-both within the cooldown waits for the user instead", () => {
  const now = 10 * AUTO_KEEP_BOTH_COOLDOWN_MS;
  assert.equal(mayAutoKeepBoth({ fileName: "p777.jpg", lastAutoAt: undefined, now }), true);
  assert.equal(mayAutoKeepBoth({ fileName: "p777.jpg", lastAutoAt: now - 1000, now }), false);
  assert.equal(mayAutoKeepBoth({ fileName: "p777.jpg", lastAutoAt: now - AUTO_KEEP_BOTH_COOLDOWN_MS, now }), true);
});
