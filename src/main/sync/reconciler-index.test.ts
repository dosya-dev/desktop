// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncIndex } from "./index-db";
import { reconcile, reconcileRemoteOnly } from "./reconciler";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { RemotePoller } from "./remote-poller";
import type { BaseView } from "./planner";
import { EMPTY_PAIR_STATE, type RemoteFileInfo, type SyncPair } from "./types";

describe("reconciliation with persisted sync history", () => {
  let directory: string;
  let root: string;
  let index: SyncIndex;
  let pair: SyncPair;
  let file: RemoteFileInfo;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "dosya-reconcile-index-"));
    root = join(directory, "files");
    await mkdir(root);
    await writeFile(join(root, "notes.txt"), "original version");
    const local = await stat(join(root, "notes.txt"));
    index = SyncIndex.open(join(directory, "index.db"));
    pair = {
      id: "pair", workspaceId: "workspace", workspaceName: "Samples",
      remoteFolderId: "folder", remoteFolderName: "Samples", localPath: root,
      selectiveFolders: [], excludedPatterns: [], region: "auto", pollIntervalMs: 30000,
      syncMode: "two-way", conflictStrategy: "keep-both", enabled: true, createdAt: 1,
    };
    file = {
      id: "file", name: "notes.txt", folder_id: "folder", size_bytes: local.size,
      mime_type: "text/plain", extension: "txt", region: "auto", updated_at: 100,
      current_version: 1,
    };
    index.upsertFile(pair.id, {
      remoteId: file.id, remoteName: file.name, remoteFolderId: file.folder_id,
      remoteSizeBytes: file.size_bytes, remoteUpdatedAt: file.updated_at, remoteVersion: 1,
      localPath: "notes.txt", localSizeBytes: local.size, localMtimeMs: local.mtimeMs,
      syncedAt: 1,
    });
  });

  afterEach(async () => {
    index.close();
    await rm(directory, { recursive: true, force: true });
  });

  function base(): BaseView {
    return {
      fileById: id => index.getFileById(pair.id, id),
      fileByPath: path => index.getFileByPath(pair.id, path),
      files: () => index.iterFiles(pair.id),
      folderByPath: path => index.getFolder(pair.id, path),
      folders: () => index.iterFolders(pair.id),
    };
  }

  const snapshot = (file: RemoteFileInfo) => ({ files: new Map([[file.id, file]]), folders: new Map() });

  it("does not fork an unchanged file whose history is in SQLite", async () => {
    index.close();
    index = SyncIndex.open(join(directory, "index.db"));
    const actions = await reconcile(pair, snapshot(file), base());
    expect(actions).toEqual([]);
  });

  it("updates the tracked cloud file after a local edit instead of inventing a conflict", async () => {
    await writeFile(join(root, "notes.txt"), "a longer local revision");
    const actions = await reconcile(pair, snapshot(file), base());
    expect(actions.map(action => action.type)).toEqual(["upload-update"]);
    expect(actions[0]).toMatchObject({ existingRecord: { remoteId: "file", remoteVersion: 1 } });
  });

  it("still identifies a genuine edit on both sides", async () => {
    await writeFile(join(root, "notes.txt"), "a longer local revision");
    const actions = await reconcile(pair, snapshot({ ...file, current_version: 2, updated_at: 200, size_bytes: 40 }), base());
    expect(actions.map(action => action.type)).toEqual(["conflict"]);
    expect(actions[0]).toMatchObject({ conflict: { remoteId: "file", localSizeBytes: 23, remoteSizeBytes: 40 } });
  });

  it("does not redownload an unchanged tracked file on the remote-only path", async () => {
    const actions = await reconcileRemoteOnly(pair, snapshot(file), base());
    expect(actions).toEqual([]);
  });

  it("uses the existing version when a remote-only poll finds a cloud edit", async () => {
    const actions = await reconcileRemoteOnly(pair, snapshot({ ...file, current_version: 2, updated_at: 200 }), base());
    expect(actions.map(action => action.type)).toEqual(["download-update"]);
    expect(actions[0]).toMatchObject({ existingRecord: { remoteId: "file", remoteVersion: 1 } });
  });

  it("persists a remote rename so later edits use the new path", async () => {
    const moved = { ...file, name: "renamed.txt" };
    const actions = await reconcile(pair, snapshot(moved), base());
    expect(actions.map(action => action.type)).toEqual(["move-local"]);
    const engine = new SyncEngine("https://example.test", {
      ...NULL_ENV, userDataDir: join(directory, "appdata"),
    }) as any;
    Object.defineProperty(engine, "index", { value: index });
    engine.started = true;
    engine.emitStatus = () => {};
    const rt = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "idle", notices: new Map(),
      totalFilesInBatch: 0, completedFilesInBatch: 0,
      totalBytesInBatch: 0, completedBytesInBatch: 0,
    };
    await engine.executeActions(rt, actions);
    expect(index.getFileById(pair.id, file.id)?.localPath).toBe("renamed.txt");
    expect(await reconcile(pair, snapshot(moved), base())).toEqual([]);
    await writeFile(join(root, "renamed.txt"), "a longer local revision");
    expect((await reconcile(pair, snapshot(moved), base())).map(action => action.type)).toEqual(["upload-update"]);
  });

  it("prunes confirmed records absent on both sides before their path is reused", async () => {
    await rm(join(root, "notes.txt"));
    const empty = { files: new Map(), folders: new Map() };
    expect(await reconcile(pair, empty, base(), undefined, undefined, undefined, undefined,
      ids => ids.forEach(id => index.deleteFileById(pair.id, id)))).toEqual([]);
    expect(index.getFileById(pair.id, file.id)).toBeUndefined();
    await writeFile(join(root, "notes.txt"), "original version");
    expect((await reconcile(pair, snapshot({ ...file, id: "replacement" }), base())).map(action => action.type)).toEqual(["conflict"]);
  });

  it("does not let an obsolete remote id delete a path now occupied by a new remote id", async () => {
    const actions = await reconcile(pair, snapshot({ ...file, id: "replacement" }), base());
    expect(actions.map(action => action.type)).toEqual(["conflict"]);
  });

  it("preserves both versions when a remote-only poll sees a replacement id at a tracked path", async () => {
    const actions = await reconcileRemoteOnly(pair, snapshot({ ...file, id: "replacement" }), base());
    expect(actions.map(action => action.type)).toEqual(["conflict"]);
  });

  it("ignores an obsolete id even after the replacement has its own confirmed SQLite row", async () => {
    index.upsertFile(pair.id, { ...index.getFileById(pair.id, file.id)!, remoteId: "replacement", syncedAt: 2 });
    expect(base().fileByPath("notes.txt")?.remoteId).toBe("replacement");
    const actions = await reconcileRemoteOnly(pair, snapshot({ ...file, id: "replacement" }), base());
    expect(actions).toEqual([]);
  });

  it.each(["full", "remote-only"])("retains the mass-deletion safeguard with SQLite history on the %s path", async mode => {
    const original = index.getFileById(pair.id, file.id)!;
    for (let i = 1; i < 24; i++) {
      const localPath = `notes-${i}.txt`;
      await writeFile(join(root, localPath), "original version");
      const local = await stat(join(root, localPath));
      index.upsertFile(pair.id, {
        ...original, remoteId: `file-${i}`, remoteName: localPath, localPath,
        localMtimeMs: local.mtimeMs,
      });
    }
    const withheld: Array<{ count: number; reason: string }> = [];
    const report = (count: number, reason: string) => withheld.push({ count, reason });
    const empty = { files: new Map(), folders: new Map() };
    const actions = mode === "full"
      ? await reconcile(pair, empty, base(), undefined, undefined, undefined, report)
      : await reconcileRemoteOnly(pair, empty, base(), undefined, report);
    expect(actions.filter(action => action.type === "delete-local" || action.type === "delete-remote")).toEqual([]);
    expect(withheld).toEqual([{ count: 24, reason: "over-threshold" }]);
    expect(index.countFiles(pair.id)).toBe(24);
  });

  it("Retry transfers an untracked failed local file even when the watcher reports no new changes", async () => {
    await writeFile(join(root, "retry.txt"), "recovered sample");
    index.upsertError(pair.id, { filePath: "retry.txt", error: "EACCES", retryCount: 1, lastAttemptAt: 1, permanent: false });
    const engine = new SyncEngine("https://example.test", { ...NULL_ENV, userDataDir: join(directory, "appdata") }) as any;
    Object.defineProperty(engine, "index", { value: index });
    engine.started = true;
    engine.emitStatus = () => {};
    engine.log = () => {};
    engine.flushSyncFlags = async () => {};
    let scheduled: Promise<void> | undefined;
    const poller = new RemotePoller({
      fetchSnapshotFast: async () => ({ files: [file], folders: [], deleted: { files: [], folders: [] } }),
    } as any, pair);
    // Warm the real poller's snapshot cache before the local retry request.
    await (poller as any).poll();
    poller.on("snapshot", remote => { scheduled = engine.runReconcile(pair.id, remote); });
    const rt = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "idle", notices: new Map(), syncing: false,
      localDirty: false, lastFullLocalScanAt: Date.now(),
      poller,
    };
    engine.runtimes.set(pair.id, rt);
    const transfer = vi.fn(async () => { index.clearError(pair.id, "retry.txt"); });
    engine.uploadLocalFile = transfer;
    await engine.retryFileErrors(pair.id);
    await vi.waitFor(() => expect(scheduled).toBeDefined());
    await scheduled;
    expect(transfer).toHaveBeenCalledWith(rt, join(root, "retry.txt"), "retry.txt");
    expect(index.getError(pair.id, "retry.txt")).toBeUndefined();
  });

  it("skips unchanged idle polls but emits unchanged snapshots for explicit local requests", async () => {
    const poller = new RemotePoller({
      fetchSnapshotFast: async () => ({ files: [file], folders: [], deleted: { files: [], folders: [] } }),
    } as any, pair);
    const snapshots = vi.fn();
    poller.on("snapshot", snapshots);
    await (poller as any).poll();
    await (poller as any).poll();
    expect(snapshots).toHaveBeenCalledTimes(1);
    poller.triggerNow();
    await vi.waitFor(() => expect(snapshots).toHaveBeenCalledTimes(2));
    await (poller as any).poll();
    expect(snapshots).toHaveBeenCalledTimes(2);
  });

  it("retains a Retry requested while another transfer is still running", async () => {
    await writeFile(join(root, "active.txt"), "active sample");
    const engine = new SyncEngine("https://example.test", { ...NULL_ENV, userDataDir: join(directory, "appdata") }) as any;
    Object.defineProperty(engine, "index", { value: index });
    engine.started = true;
    engine.emitStatus = () => {};
    engine.log = () => {};
    engine.flushSyncFlags = async () => {};
    const poller = new RemotePoller({
      fetchSnapshotFast: async () => ({ files: [file], folders: [], deleted: { files: [], folders: [] } }),
    } as any, pair);
    await (poller as any).poll();
    poller.on("snapshot", remote => { void engine.runReconcile(pair.id, remote); });
    const rt = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "idle", notices: new Map(), syncing: false,
      localDirty: true, lastFullLocalScanAt: Date.now(), poller, queuedSync: false,
    };
    engine.runtimes.set(pair.id, rt);
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    const transfer = vi.fn(async (_rt, _absPath, relPath) => {
      if (relPath === "active.txt") await held;
      if (relPath === "retry.txt") index.clearError(pair.id, relPath);
    });
    engine.uploadLocalFile = transfer;
    const active = engine.runReconcile(pair.id, snapshot(file));
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledWith(rt, join(root, "active.txt"), "active.txt"));
    // This file was not in the already planned transfer batch.
    await writeFile(join(root, "retry.txt"), "recovered sample");
    index.upsertError(pair.id, { filePath: "retry.txt", error: "EACCES", retryCount: 1, lastAttemptAt: 1, permanent: false });
    await engine.retryFileErrors(pair.id);
    await vi.waitFor(() => expect((poller as any).snapshotRequested).toBe(false));
    release();
    await active;
    await vi.waitFor(() => expect(transfer).toHaveBeenCalledWith(rt, join(root, "retry.txt"), "retry.txt"));
    expect(index.getError(pair.id, "retry.txt")).toBeUndefined();
    await vi.waitFor(() => expect(rt.syncing).toBe(false));
  });
});
