// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type RemoteFileInfo, type SyncAction, type SyncConflict, type SyncFileRecord, type SyncPair } from "./types";

const bytes = "remote bytes";

describe("remote-derived sync paths", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "dosya-engine-path-"));
    root = join(base, "root");
    outside = join(base, "outside");
    await mkdir(root);
    await mkdir(outside);
    await symlink(outside, join(root, "shared"), process.platform === "win32" ? "junction" : "dir");
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  function fixture(mode: "two-way" | "pull" | "pull-safe", presigned: boolean) {
    const pair: SyncPair = {
      id: "pair", workspaceId: "ws", workspaceName: "Workspace", remoteFolderId: null,
      remoteFolderName: "Root", localPath: root, selectiveFolders: [], excludedPatterns: [],
      region: "auto", pollIntervalMs: 60_000, syncMode: mode,
      conflictStrategy: "last-write-wins", enabled: true, createdAt: Date.now(),
    };
    const file: RemoteFileInfo = {
      id: "file", name: "proof.txt", size_bytes: bytes.length, mime_type: "text/plain",
      extension: "txt", region: "auto", folder_id: "folder", updated_at: 1,
      current_version: 1,
    };
    const errors = new Map<string, { error: string; retryCount: number; permanent: boolean }>();
    const files = new Map<string, unknown>();
    const index = {
      getError: (_pairId: string, path: string) => errors.get(path),
      iterErrors: () => [...errors.values()],
      upsertError: (_pairId: string, error: { filePath: string; error: string; retryCount: number; permanent: boolean }) => { errors.set(error.filePath, error); },
      clearError: (_pairId: string, path: string) => { errors.delete(path); },
      getFileById: (_pairId: string, id: string) => files.get(id),
      iterFiles: () => files.values(),
      countFiles: () => files.size,
      upsertFile: (_pairId: string, record: { remoteId: string }) => { files.set(record.remoteId, record); },
      deleteFileById: (_pairId: string, id: string) => { files.delete(id); },
    };
    const writeDownload = vi.fn(async (_idOrUrl: string, target: string) => {
      await writeFile(`${target}.dosya-sync-tmp`, bytes);
      await rename(`${target}.dosya-sync-tmp`, target);
      return bytes.length;
    });
    const client = {
      requestDownloadManifest: vi.fn(async () => presigned
        ? new Map([["file", { url: "https://example.test/file", name: "proof.txt", size: bytes.length }]])
        : new Map()),
      downloadFromPresignedUrl: writeDownload,
      downloadFile: writeDownload,
    };
    const trash = vi.fn(async (path: string) => { await rm(path); });
    const engine = new SyncEngine("https://example.test", {
      ...NULL_ENV, userDataDir: join(base, "appdata"), trashItem: trash,
    }) as any;
    engine.started = true;
    Object.defineProperty(engine, "index", { value: index });
    engine.client = client;
    engine.emitStatus = () => {};
    engine.ensureDiskSpace = async () => {};
    engine.putPairMeta = () => {};
    const rt: any = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "idle", syncing: false,
      errorMessage: null, notices: new Map(), phase: null,
      lastProgressAt: 0, lastProgressLogAt: 0,
      totalFilesInBatch: 0, completedFilesInBatch: 0,
      totalBytesInBatch: 0, completedBytesInBatch: 0,
    };
    engine.runtimes.set(pair.id, rt);
    return { engine, rt, file, errors, files, client, trash };
  }

  function record(localPath: string): SyncFileRecord {
    return {
      remoteId: "file", remoteName: "proof.txt", remoteFolderId: "folder",
      remoteSizeBytes: bytes.length, remoteUpdatedAt: 1, remoteVersion: 1,
      localPath, localSizeBytes: bytes.length, localMtimeMs: 0, syncedAt: 0,
    };
  }

  function conflict(localPath: string): SyncConflict {
    return {
      id: "conflict", pairId: "pair", localPath: join(root, localPath),
      remoteName: "proof.txt", remoteId: "file", localMtimeMs: 0,
      remoteUpdatedAt: 1, localSizeBytes: bytes.length,
      remoteSizeBytes: bytes.length, detectedAt: Date.now(),
    };
  }

  it.each([false, true])("blocks a two-way %s download through a symlink", async (presigned) => {
    const { engine, rt, file, errors, client } = fixture("two-way", presigned);
    const actions: SyncAction[] = [{ type: "download-new", remoteFile: file, localDir: join(root, "shared") }];
    await engine.executeActions(rt, actions);
    await expect(readFile(join(outside, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.downloadFile.mock.calls.length + client.downloadFromPresignedUrl.mock.calls.length).toBe(0);
    expect(errors.get("shared/proof.txt")?.error).toMatch(/unsafe|symbolic link/i);
  });

  it("keeps the tracked version when a remote update targets a symlinked path", async () => {
    const { engine, rt, file, errors, files, client } = fixture("two-way", false);
    const existing = record("shared/proof.txt");
    files.set(file.id, existing);
    await writeFile(join(outside, "proof.txt"), "sentinel");
    await engine.executeActions(rt, [{
      type: "download-update", remoteFile: { ...file, current_version: 2 },
      localPath: join(root, existing.localPath), existingRecord: existing,
    }]);
    expect(await readFile(join(outside, "proof.txt"), "utf8")).toBe("sentinel");
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(files.get(file.id)).toBe(existing);
    expect(errors.get(existing.localPath)?.error).toMatch(/unsafe|symbolic link/i);
  });

  it("blocks the separate pull download path through a symlink", async () => {
    const { engine, rt, file, errors, client } = fixture("pull-safe", false);
    await engine.handleRemoteChanges("pair", {
      files: new Map([[file.id, file]]),
      folders: new Map([["folder", { id: "folder", name: "shared", parent_id: null, file_count: 1 }]]),
    });
    await expect(readFile(join(outside, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(errors.get("shared/proof.txt")?.error).toMatch(/unsafe|symbolic link/i);
    expect(rt.status).toBe("idle");
  });

  it("does not create a remote folder beneath a local symlink", async () => {
    const { engine, rt, errors } = fixture("two-way", false);
    await engine.executeActions(rt, [{ type: "create-local-folder", remoteFolderId: "new", localDir: root, name: "shared/new" }]);
    await expect(lstat(join(outside, "new"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(errors.get("shared/new")?.error).toMatch(/unsafe|symbolic link/i);
  });

  it("does not move a local file into a symlinked destination", async () => {
    const { engine, rt, file, errors, client } = fixture("two-way", false);
    await writeFile(join(root, "source.txt"), "sentinel");
    const action: SyncAction = {
      type: "move-local", oldLocalPath: join(root, "source.txt"),
      newLocalPath: join(root, "shared", "moved.txt"), remoteFile: file,
      record: record("source.txt"),
    };
    await engine.executeActions(rt, [action]);
    expect(await readFile(join(root, "source.txt"), "utf8")).toBe("sentinel");
    await expect(readFile(join(outside, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(errors.get("shared/moved.txt")?.error).toMatch(/unsafe|symbolic link/i);
  });

  it("does not move an outside file through a symlinked source", async () => {
    const { engine, rt, file, errors, client } = fixture("two-way", false);
    await writeFile(join(outside, "source.txt"), "sentinel");
    await engine.executeActions(rt, [{
      type: "move-local", oldLocalPath: join(root, "shared", "source.txt"),
      newLocalPath: join(root, "moved.txt"), remoteFile: file,
      record: record("shared/source.txt"),
    }]);
    expect(await readFile(join(outside, "source.txt"), "utf8")).toBe("sentinel");
    await expect(readFile(join(root, "moved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(errors.get("shared/source.txt")?.error).toMatch(/unsafe|symbolic link/i);
  });

  it.each(["keep-local", "keep-remote", "keep-both"] as const)(
    "keeps an outside file untouched during %s conflict resolution",
    async resolution => {
      const { engine, files, errors } = fixture("two-way", false);
      await writeFile(join(outside, "proof.txt"), "sentinel");
      files.set("file", record("shared/proof.txt"));
      engine.conflicts.push(conflict("shared/proof.txt"));
      const upload = vi.fn(async () => {});
      engine.uploadLocalFile = upload;
      await engine.resolveConflict("conflict", resolution);
      expect(await readFile(join(outside, "proof.txt"), "utf8")).toBe("sentinel");
      expect(engine.conflicts).toHaveLength(1);
      expect(upload).not.toHaveBeenCalled();
      expect(errors.get("shared/proof.txt")?.error).toMatch(/unsafe|symbolic link/i);
    },
  );

  it.each(["two-way", "pull"] as const)(
    "retains a tracked file when %s deletion crosses a symlink, then deletes it after repair",
    async mode => {
      const { engine, rt, errors, files, trash } = fixture(mode, false);
      const victim = record("shared/victim.txt");
      files.set(victim.remoteId, victim);
      await writeFile(join(outside, "victim.txt"), "sentinel");
      const deleteOnce = async () => {
        if (mode === "two-way") {
          await engine.executeActions(rt, [{
            type: "delete-local", localPath: join(root, victim.localPath), record: victim,
          }]);
        } else {
          await engine.handleRemoteChanges("pair", { files: new Map(), folders: new Map() });
        }
      };

      await deleteOnce();
      expect(trash).not.toHaveBeenCalled();
      expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("sentinel");
      expect(files.get(victim.remoteId)).toBe(victim);
      expect(errors.get(victim.localPath)?.error).toMatch(/unsafe|symbolic link/i);
      expect(errors.get(victim.localPath)?.permanent).toBe(false);

      await rm(join(root, "shared"));
      await mkdir(join(root, "shared"));
      await writeFile(join(root, victim.localPath), "local copy");
      await deleteOnce();
      expect(trash).toHaveBeenCalledWith(join(await realpath(root), victim.localPath));
      await expect(readFile(join(root, victim.localPath))).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(outside, "victim.txt"), "utf8")).toBe("sentinel");
      expect(files.has(victim.remoteId)).toBe(false);
    },
  );

  it.each(["two-way", "pull"] as const)(
    "drops an already absent %s file without calling trash",
    async mode => {
      await rm(join(root, "shared"));
      const { engine, rt, files, errors, trash } = fixture(mode, false);
      const victim = record("shared/victim.txt");
      files.set(victim.remoteId, victim);
      if (mode === "two-way") {
        await engine.executeActions(rt, [{
          type: "delete-local", localPath: join(root, victim.localPath), record: victim,
        }]);
      } else {
        await engine.handleRemoteChanges("pair", { files: new Map(), folders: new Map() });
      }
      expect(trash).not.toHaveBeenCalled();
      expect(files.has(victim.remoteId)).toBe(false);
      expect(errors.has(victim.localPath)).toBe(false);
    },
  );

  it("resolves keep-remote when the configured sync root is a symlink", async () => {
    await rm(join(root, "shared"));
    await mkdir(join(root, "shared"));
    await writeFile(join(root, "shared", "proof.txt"), "local copy");
    const actualRoot = root;
    root = join(base, "root-alias");
    await symlink(actualRoot, root, process.platform === "win32" ? "junction" : "dir");
    const { engine, files, trash } = fixture("two-way", false);
    files.set("file", record("shared/proof.txt"));
    engine.conflicts.push(conflict("shared/proof.txt"));

    await engine.resolveConflict("conflict", "keep-remote");
    expect(engine.conflicts).toHaveLength(0);
    expect(files.has("file")).toBe(false);
    expect(trash).toHaveBeenCalledWith(join(await realpath(actualRoot), "shared", "proof.txt"));
    await expect(readFile(join(actualRoot, "shared", "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
