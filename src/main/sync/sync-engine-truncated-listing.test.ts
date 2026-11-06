// @vitest-environment node
//
// A truncated full listing must never reach the reconciler on the initial
// sync path: with a populated base it would turn every file that did not
// arrive into a delete-local, and with an empty base it would seed rows from
// a partial tree.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type SyncPair } from "./types";

describe("initial reconcile refuses a truncated listing", () => {
  let base: string;
  let root: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "dosya-trunc-"));
    root = join(base, "root");
    await mkdir(root);
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  async function fixture(tracked: boolean) {
    const abs = join(root, "keep.txt");
    await writeFile(abs, "precious");
    const pair: SyncPair = {
      id: "pair", workspaceId: "ws", workspaceName: "Workspace", remoteFolderId: "root-folder",
      remoteFolderName: "Root", localPath: root, selectiveFolders: [], excludedPatterns: [],
      region: "auto", pollIntervalMs: 60_000, syncMode: "two-way",
      conflictStrategy: "keep-both", enabled: true, createdAt: Date.now(),
    } as SyncPair;
    const files = new Map<string, any>();
    if (tracked) {
      files.set("file", {
        remoteId: "file", remoteName: "keep.txt", remoteFolderId: null, remoteSizeBytes: 8,
        remoteUpdatedAt: 1, remoteVersion: 1, localPath: "keep.txt", localSizeBytes: 8, localMtimeMs: 1, syncedAt: 1,
      });
    }
    const index = {
      countFiles: () => files.size,
      iterFiles: () => files.values(),
      getFileById: (_p: string, id: string) => files.get(id),
      getFileByPath: (_p: string, path: string) => [...files.values()].find((r) => r.localPath === path),
      upsertFile: vi.fn((_p: string, r: any) => { files.set(r.remoteId, r); }),
      upsertFolder: vi.fn(),
      deleteFileById: vi.fn((_p: string, id: string) => { files.delete(id); }),
      iterErrors: () => [],
      getError: () => undefined,
      txDepth: 0,
      transactions: 0,
      transaction(fn: () => unknown) {
        this.transactions++;
        this.txDepth++;
        try { return fn(); } finally { this.txDepth--; }
      },
    };
    const client = {
      fetchSnapshotFast: vi.fn(async () => ({ files: [], folders: [], deleted: { files: [], folders: [] }, truncated: true })),
    };
    const engine = new SyncEngine("https://example.test", { ...NULL_ENV, userDataDir: join(base, "appdata") }) as any;
    engine.started = true;
    Object.defineProperty(engine, "index", { value: index });
    engine.client = client;
    engine.emitStatus = () => {};
    engine.putPairMeta = vi.fn();
    engine.putFile = vi.fn();
    engine.putFolder = vi.fn();
    engine.dropFile = vi.fn();
    engine.executeActions = vi.fn(async () => {});
    engine.beginSyncCycle = () => {};
    engine.requestQueuedReconcile = () => {};
    const rt: any = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "idle", syncing: false, errorMessage: null,
      notices: new Map(), phase: null, lastProgressAt: 0, lastProgressLogAt: 0,
      totalFilesInBatch: 0, completedFilesInBatch: 0, totalBytesInBatch: 0, completedBytesInBatch: 0,
    };
    engine.runtimes.set(pair.id, rt);
    return { engine, rt, abs, index, client };
  }

  it("populated base: no delete-local, file stays, nothing stamped, incomplete logged", async () => {
    const { engine, rt, abs, index } = await fixture(true);
    await engine.runInitialReconcile("pair");
    expect(await readFile(abs, "utf8")).toBe("precious");
    expect(engine.executeActions).not.toHaveBeenCalled();
    expect(engine.dropFile).not.toHaveBeenCalled();
    expect(index.deleteFileById).not.toHaveBeenCalled();
    expect(engine.putPairMeta).not.toHaveBeenCalled();
    expect(engine.logs.some((l: any) => /incomplete/i.test(l.message))).toBe(true);
    expect(rt.status).toBe("idle");
    expect(rt.syncing).toBe(false);
  });

  it("empty base (pre-populate path): no base rows are written", async () => {
    const { engine, rt, client } = await fixture(false);
    await engine.runInitialReconcile("pair");
    expect(client.fetchSnapshotFast).toHaveBeenCalledTimes(1);
    expect(engine.putFile).not.toHaveBeenCalled();
    expect(engine.putFolder).not.toHaveBeenCalled();
    expect(engine.executeActions).not.toHaveBeenCalled();
    expect(engine.putPairMeta).not.toHaveBeenCalled();
    expect(engine.logs.some((l: any) => /incomplete/i.test(l.message))).toBe(true);
    expect(rt.status).toBe("idle");
  });

  it("a complete listing seeds its base rows inside one index transaction", async () => {
    // synchronous=FULL makes every autocommitted row an fsync; 20k rows cost
    // seconds on the main thread. The seed is written as one transaction.
    const { engine, rt, index, client } = await fixture(false);
    engine.putFile = SyncEngine.prototype["putFile" as keyof SyncEngine];
    engine.putFolder = SyncEngine.prototype["putFolder" as keyof SyncEngine];
    const depthAtWrite: number[] = [];
    index.upsertFile.mockImplementation(() => { depthAtWrite.push(index.txDepth); });
    index.upsertFolder.mockImplementation(() => { depthAtWrite.push(index.txDepth); });
    const file = (id: string) => ({
      id, name: `${id}.txt`, folder_id: "sub", size_bytes: 1, mime_type: "text/plain", extension: "txt",
      region: "auto", updated_at: 1, current_version: 1,
    });
    client.fetchSnapshotFast.mockImplementation(async () => ({
      files: [file("a"), file("b"), file("c")],
      folders: [{ id: "sub", name: "sub", parent_id: "root-folder", file_count: 3 }],
      deleted: { files: [], folders: [] }, truncated: false,
    }) as any);
    const snapshot = await engine.prePopulateStateFromRemote(rt);
    expect(snapshot?.files.size).toBe(3);
    expect(depthAtWrite.length).toBe(4);
    expect(depthAtWrite.every((d) => d > 0)).toBe(true);
    expect(index.transactions).toBe(1);
  });
});
