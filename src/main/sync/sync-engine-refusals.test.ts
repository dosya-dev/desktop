// @vitest-environment node
//
// Runs on vitest (see vitest.config.ts) for the same reason the maintenance
// test does: index.ts uses bundler-style resolution Node's runner can't load.
//
// What the server REFUSES must not be recorded as done. Three paths used to
// do exactly that when a member without the delete/move permission synced:
//
//  - delete-remote swallowed the 403 and dropped the index row anyway, so the
//    still-present cloud file read as new on the next cycle and was
//    re-uploaded: a delete that quietly undid itself;
//  - deleteFilesBatch only checked 401, so a 403 was "success" to the folder
//    removal and mass-deletion paths and every row was dropped;
//  - a refused move fell back to delete + re-upload, creating a duplicate.
//
// These construct a real SyncEngine over a real (temporary) sync index, the
// way sync-engine-maintenance.test.ts does, and swap the RemoteClient methods
// for ones that answer with the server's 403.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "./index";
import { RemoteRefusedError } from "./remote-client";
import { closeSyncIndex } from "./config";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type SyncAction, type SyncFileRecord, type SyncPair } from "./types";
import type { SyncIndex } from "./index-db";

function fakePair(id: string): SyncPair {
  return {
    id,
    workspaceId: "ws1",
    workspaceName: "Workspace",
    remoteFolderId: null,
    remoteFolderName: "Folder",
    localPath: "/tmp/does-not-matter",
    selectiveFolders: [],
    excludedPatterns: [],
    region: "auto",
    pollIntervalMs: 60_000,
    syncMode: "two-way",
    conflictStrategy: "last-write-wins",
    enabled: true,
    createdAt: Date.now(),
  };
}

/** Minimal PairRuntime - same shape addPair builds, private to index.ts. */
function fakeRuntime(pair: SyncPair) {
  return {
    pair,
    state: EMPTY_PAIR_STATE(pair.id),
    watcher: null,
    poller: null,
    status: "idle" as string,
    errorMessage: null as string | null,
    syncing: false,
    queuedSync: false,
    queuedEvents: new Map(),
    queuedOverflow: false,
    rateLimitResumeTimer: null,
    rescanTimer: null,
    notices: new Map(),
    pendingDeletion: null as null | { files: { remoteId: string; localPath: string }[]; folders: string[]; heldAt: number },
    totalFilesInBatch: 0,
    completedFilesInBatch: 0,
    totalBytesInBatch: 0,
    completedBytesInBatch: 0,
    batchStartedAt: 0,
    phase: null,
    scannedFiles: 0,
    scannedFolders: 0,
    statusText: "",
    localDirty: true,
    lastFullLocalScanAt: 0,
    syncStartedAt: 0,
    lastProgressAt: 0,
    lastProgressLogAt: 0,
  };
}

function record(remoteId: string, localPath: string): SyncFileRecord {
  return {
    remoteId, remoteName: localPath.split("/").pop()!, remoteFolderId: null,
    remoteSizeBytes: 10, remoteUpdatedAt: 1, remoteVersion: 1,
    localPath, localSizeBytes: 10, localMtimeMs: 1000, syncedAt: 1000,
  };
}

type Rt = ReturnType<typeof fakeRuntime>;
type EngineInternals = {
  runtimes: Map<string, Rt>;
  index: SyncIndex;
  client: {
    deleteFile: (id: string) => Promise<void>;
    deleteFilesBatch: (ws: string, ids: string[]) => Promise<{ deleted: number; deletedIds: string[] }>;
    moveFile: (id: string, folderId: string | null) => Promise<void>;
    renameFile: (id: string, name: string) => Promise<void>;
  };
  executeActions: (rt: Rt, actions: SyncAction[]) => Promise<void>;
  executeQueuedOps: (rt: Rt, batch: unknown[]) => Promise<void>;
  resumeAfterDecision: (rt: Rt) => void;
  logs: { message: string }[];
  started: boolean;
};

const refused = (message: string) => new RemoteRefusedError(message, 403);

let dataDir: string;

function withEngine() {
  const engine = new SyncEngine("https://api.dosya.dev", { ...NULL_ENV, userDataDir: dataDir }) as unknown as EngineInternals & SyncEngine;
  engine.started = true;
  const pair = fakePair("pair1");
  const rt = fakeRuntime(pair);
  engine.runtimes.set(pair.id, rt);
  return { engine, pair, rt };
}

describe("SyncEngine keeps refused remote deletes and moves visible", () => {
  beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), "dosya-sync-refusals-")); });
  afterEach(() => { closeSyncIndex(); rmSync(dataDir, { recursive: true, force: true }); });

  it("a 403 on delete-remote keeps the index row and records a permanent file error", async () => {
    const { engine, pair, rt } = withEngine();
    const rec = record("f1", "docs/report.pdf");
    engine.index.upsertFile(pair.id, rec);
    let calls = 0;
    engine.client.deleteFile = async () => { calls++; throw refused("You don't have permission to delete this file"); };

    await engine.executeActions(rt, [{ type: "delete-remote", remoteId: "f1", record: rec }]);

    expect(engine.index.getFileById(pair.id, "f1")).toBeDefined();
    const err = engine.index.getError(pair.id, "docs/report.pdf");
    expect(err?.permanent).toBe(true);
    expect(err?.error).toMatch(/You don't have permission to delete this file/);
    expect(engine.logs.some((l) => /docs\/report\.pdf/.test(l.message) && /permission/.test(l.message))).toBe(true);

    // The refusal is permanent: the next cycle does not ask the server again.
    await engine.executeActions(rt, [{ type: "delete-remote", remoteId: "f1", record: rec }]);
    expect(calls).toBe(1);
  });

  it("a successful delete-remote still drops the row", async () => {
    const { engine, pair, rt } = withEngine();
    const rec = record("f1", "a.txt");
    engine.index.upsertFile(pair.id, rec);
    engine.client.deleteFile = async () => {};

    await engine.executeActions(rt, [{ type: "delete-remote", remoteId: "f1", record: rec }]);

    expect(engine.index.getFileById(pair.id, "f1")).toBeUndefined();
  });

  it("a 403 on the mass-deletion confirm restores the hold and never claims files were deleted", async () => {
    const { engine, pair, rt } = withEngine();
    engine.index.upsertFile(pair.id, record("f1", "a.txt"));
    engine.index.upsertFile(pair.id, record("f2", "b.txt"));
    const held = { files: [{ remoteId: "f1", localPath: "a.txt" }, { remoteId: "f2", localPath: "b.txt" }], folders: [], heldAt: 1 };
    rt.pendingDeletion = held;
    rt.status = "needs-confirmation";
    engine.client.deleteFilesBatch = async () => { throw refused("No delete permission"); };
    engine.resumeAfterDecision = () => { throw new Error("must not resume after a refusal"); };

    await expect(engine.confirmPendingDeletion(pair.id)).rejects.toThrow("No delete permission");

    expect(rt.pendingDeletion).toBe(held);
    expect(rt.status).toBe("needs-confirmation");
    expect(engine.index.getFileById(pair.id, "f1")).toBeDefined();
    expect(engine.index.getFileById(pair.id, "f2")).toBeDefined();
    expect(engine.logs.some((l) => /^Deleted \d/.test(l.message))).toBe(false);
    expect(engine.logs.some((l) => /No delete permission/.test(l.message))).toBe(true);
  });

  it("a 2xx shortfall on confirm drops only the ids the server listed and ledgers the rest", async () => {
    const { engine, pair, rt } = withEngine();
    engine.index.upsertFile(pair.id, record("f1", "a.txt"));
    engine.index.upsertFile(pair.id, record("f2", "b.txt"));
    rt.pendingDeletion = { files: [{ remoteId: "f1", localPath: "a.txt" }, { remoteId: "f2", localPath: "b.txt" }], folders: [], heldAt: 1 };
    // Two requested; the server trashed one (the other was someone else's
    // under delete_own_files, or already gone) and says which.
    engine.client.deleteFilesBatch = async () => ({ deleted: 1, deletedIds: ["f1"] });
    engine.resumeAfterDecision = () => {};

    await engine.confirmPendingDeletion(pair.id);

    expect(engine.index.getFileById(pair.id, "f1")).toBeUndefined();
    expect(engine.index.getFileById(pair.id, "f2")).toBeDefined();
    const err = engine.index.getError(pair.id, "b.txt");
    expect(err?.permanent).toBe(true);
    expect(err?.error).toMatch(/refused/);
    expect(engine.index.getError(pair.id, "a.txt")).toBeUndefined();
    expect(engine.logs.some((l) => /Deleted 2 files/.test(l.message))).toBe(false);
    expect(engine.logs.some((l) => /1 of 2/.test(l.message))).toBe(true);
  });

  it("a full confirm drops every row and claims the full count", async () => {
    const { engine, pair, rt } = withEngine();
    engine.index.upsertFile(pair.id, record("f1", "a.txt"));
    engine.index.upsertFile(pair.id, record("f2", "b.txt"));
    rt.pendingDeletion = { files: [{ remoteId: "f1", localPath: "a.txt" }, { remoteId: "f2", localPath: "b.txt" }], folders: [], heldAt: 1 };
    engine.client.deleteFilesBatch = async () => ({ deleted: 2, deletedIds: ["f1", "f2"] });
    engine.resumeAfterDecision = () => {};

    await engine.confirmPendingDeletion(pair.id);

    expect(engine.index.getFileById(pair.id, "f1")).toBeUndefined();
    expect(engine.index.getFileById(pair.id, "f2")).toBeUndefined();
    expect(engine.logs.some((l) => /Deleted 2 files from the cloud/.test(l.message))).toBe(true);
  });

  it("a 403 on a queued move is permanent: no delete + re-upload fallback, no retry, error on both paths", async () => {
    const { engine, pair, rt } = withEngine();
    const rec = record("f1", "old.txt");
    engine.index.upsertFile(pair.id, rec);
    let moves = 0;
    engine.client.moveFile = async () => { moves++; throw refused("You don't have permission to move files"); };
    engine.client.renameFile = async () => { moves++; throw refused("You don't have permission to rename files"); };
    const op = { kind: "move-remote", fromRelPath: "old.txt", toRelPath: "sub/new.txt", remoteId: "f1" };
    engine.index.upsertFolder(pair.id, { remoteId: "folder-sub", remoteName: "sub", remoteParentId: null, localPath: "sub", syncedAt: 1 });

    engine.index.enqueueOps(pair.id, [{ kind: op.kind, payload: op }], Date.now());
    await engine.executeQueuedOps(rt, engine.index.popPendingOps(pair.id, 10, Date.now()));

    // The row still says the server copy is at old.txt, because it is.
    expect(engine.index.getFileById(pair.id, "f1")?.localPath).toBe("old.txt");
    // Kept, visible, not requeued.
    expect(engine.index.countOpsByState(pair.id, "failed")).toBe(1);
    expect(engine.index.countOpsByState(pair.id, "pending")).toBe(0);
    // Both paths carry the refusal: the new one so the file is not re-uploaded
    // as a duplicate, the old one so the server copy is not deleted.
    for (const rel of ["sub/new.txt", "old.txt"]) {
      const err = engine.index.getError(pair.id, rel);
      expect(err?.permanent).toBe(true);
      expect(err?.error).toMatch(/permission to move files/);
    }

    // Re-planned next cycle, the move is skipped before it reaches the server.
    engine.index.enqueueOps(pair.id, [{ kind: op.kind, payload: op }], Date.now());
    await engine.executeQueuedOps(rt, engine.index.popPendingOps(pair.id, 10, Date.now()));
    expect(moves).toBe(1);
  });

  it("a transient move failure still goes back on the queue", async () => {
    const { engine, pair, rt } = withEngine();
    engine.index.upsertFile(pair.id, record("f1", "old.txt"));
    // Same folder, new name: only the rename call is made.
    engine.client.renameFile = async () => { throw new Error("socket hang up"); };
    const op = { kind: "move-remote", fromRelPath: "old.txt", toRelPath: "new.txt", remoteId: "f1" };

    engine.index.enqueueOps(pair.id, [{ kind: op.kind, payload: op }], Date.now());
    await engine.executeQueuedOps(rt, engine.index.popPendingOps(pair.id, 10, Date.now()));

    expect(engine.index.countOpsByState(pair.id, "pending")).toBe(1);
    expect(engine.index.getError(pair.id, "new.txt")).toBeUndefined();
  });
});
