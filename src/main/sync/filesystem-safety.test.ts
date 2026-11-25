// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { moveNoReplace, prepareSafeSyncPath, UnsafeSyncPathError } from "./filesystem-safety";

describe("prepareSafeSyncPath", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "dosya-sync-path-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it("creates ordinary nested parents and returns a path under the real root", async () => {
    const target = await prepareSafeSyncPath(root, "docs/2026/report.txt", { kind: "file", createParents: true });
    expect(target).toBe(join(await realpath(root), "docs", "2026", "report.txt"));
    expect((await lstat(join(root, "docs", "2026"))).isDirectory()).toBe(true);
  });

  it("allows a configured root alias while rejecting links below it", async () => {
    const alias = join(base, "root-alias");
    await symlink(root, alias, process.platform === "win32" ? "junction" : "dir");
    expect(await prepareSafeSyncPath(alias, "plain.txt", { kind: "file", createParents: false }))
      .toBe(join(await realpath(root), "plain.txt"));
    await symlink(outside, join(root, "shared"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareSafeSyncPath(alias, "shared/proof.txt", { kind: "file", createParents: true }))
      .rejects.toBeInstanceOf(UnsafeSyncPathError);
  });

  it("rejects the reported shared/proof.txt escape without touching outside", async () => {
    await symlink(outside, join(root, "shared"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareSafeSyncPath(root, "shared/proof.txt", { kind: "file", createParents: true }))
      .rejects.toBeInstanceOf(UnsafeSyncPathError);
    await expect(readFile(join(outside, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a descendant link even when it points back inside the root", async () => {
    await mkdir(join(root, "real"));
    await symlink(join(root, "real"), join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
    await expect(prepareSafeSyncPath(root, "alias/file.txt", { kind: "file", createParents: true }))
      .rejects.toBeInstanceOf(UnsafeSyncPathError);
  });

  it("rejects a final file symlink and a non-directory parent", async () => {
    await writeFile(join(outside, "victim.txt"), "sentinel");
    await symlink(join(outside, "victim.txt"), join(root, "victim.txt"));
    await expect(prepareSafeSyncPath(root, "victim.txt", { kind: "file", createParents: false }))
      .rejects.toBeInstanceOf(UnsafeSyncPathError);
    await writeFile(join(root, "not-a-dir"), "x");
    await expect(prepareSafeSyncPath(root, "not-a-dir/file.txt", { kind: "file", createParents: true }))
      .rejects.toBeInstanceOf(UnsafeSyncPathError);
    expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("sentinel");
  });

  it("does not create a missing parent when creation was not requested", async () => {
    await expect(prepareSafeSyncPath(root, "missing/file.txt", { kind: "file", createParents: false }))
      .rejects.toBeInstanceOf(UnsafeSyncPathError);
    await expect(lstat(join(root, "missing"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects lexical traversal before any filesystem creation", async () => {
    await expect(prepareSafeSyncPath(root, "../outside/proof.txt", { kind: "file", createParents: true }))
      .rejects.toBeInstanceOf(UnsafeSyncPathError);
    await expect(readFile(join(outside, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses Git metadata in any spelling, creating nothing", async () => {
    for (const rel of [".git/hooks/pre-commit", "repo/.GIT/config", ".git"]) {
      await expect(prepareSafeSyncPath(root, rel, { kind: "file", createParents: true }))
        .rejects.toBeInstanceOf(UnsafeSyncPathError);
    }
    await expect(lstat(join(root, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "repo"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses Windows alias spellings when running on win32", async () => {
    const original = Object.getOwnPropertyDescriptor(process, "platform")!;
    Object.defineProperty(process, "platform", { value: "win32" });
    try {
      for (const rel of ["GIT~1/hooks/pre-commit", "a:b.txt", "docs./x.txt", "CON.txt"]) {
        await expect(prepareSafeSyncPath(root, rel, { kind: "file", createParents: true }))
          .rejects.toBeInstanceOf(UnsafeSyncPathError);
      }
    } finally {
      Object.defineProperty(process, "platform", original);
    }
    await expect(lstat(join(root, "GIT~1"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(lstat(join(root, "docs."))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("moveNoReplace", () => {
  let base: string;

  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "dosya-move-")); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it("moves to a free name", async () => {
    await writeFile(join(base, "a.txt"), "A");
    await moveNoReplace(join(base, "a.txt"), join(base, "b.txt"));
    expect(await readFile(join(base, "b.txt"), "utf8")).toBe("A");
    await expect(lstat(join(base, "a.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("never replaces a file that holds the destination", async () => {
    await writeFile(join(base, "a.txt"), "A");
    await writeFile(join(base, "b.txt"), "LOCAL");
    await expect(moveNoReplace(join(base, "a.txt"), join(base, "b.txt"))).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(join(base, "b.txt"), "utf8")).toBe("LOCAL");
    expect(await readFile(join(base, "a.txt"), "utf8")).toBe("A");
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "lets a case-only rename of the same file through",
    async () => {
      await writeFile(join(base, "a.txt"), "A");
      await moveNoReplace(join(base, "a.txt"), join(base, "A.txt"));
      expect(await readdir(base)).toEqual(["A.txt"]);
    },
  );
});
