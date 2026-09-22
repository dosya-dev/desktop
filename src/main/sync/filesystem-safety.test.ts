// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareSafeSyncPath, UnsafeSyncPathError } from "./filesystem-safety";

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
});
