// @vitest-environment node
//
// The batched presigned door used to stat each file AFTER its PUT and write
// that as the synced state. A save during the PUT was then "synced" without
// ever being sent. The record must carry the stat from BEFORE the PUT, so a
// later scan sees the edit and re-uploads.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFile, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type SyncPair } from "./types";

describe("batched upload records the pre-PUT stat", () => {
  let base: string;
  let root: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "dosya-ul-prestat-"));
    root = join(base, "root");
    await mkdir(root);
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  it("stores the size and mtime from before the PUT, not after", async () => {
    const abs = join(root, "notes.txt");
    await writeFile(abs, "draft one");
    await utimes(abs, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const before = await stat(abs);

    const pair: SyncPair = {
      id: "pair", workspaceId: "ws", workspaceName: "Workspace", remoteFolderId: null,
      remoteFolderName: "Root", localPath: root, selectiveFolders: [], excludedPatterns: [],
      region: "auto", pollIntervalMs: 60_000, syncMode: "two-way",
      conflictStrategy: "keep-both", enabled: true, createdAt: Date.now(),
    };
    const files = new Map<string, any>();
    const errors = new Map<string, any>();
    // The commit loop's rows go in one index transaction (synchronous=FULL
    // makes each autocommitted row an fsync).
    let txDepth = 0;
    const depthAtUpsert: number[] = [];
    const index = {
      getError: (_p: string, path: string) => errors.get(path),
      iterErrors: () => [...errors.values()],
      upsertError: (_p: string, e: any) => { errors.set(e.filePath, e); },
      clearError: (_p: string, path: string) => { errors.delete(path); },
      getFileById: (_p: string, id: string) => files.get(id),
      getFileByPath: (_p: string, path: string) => [...files.values()].find((r) => r.localPath === path),
      getFolder: () => undefined,
      iterFiles: () => files.values(),
      countFiles: () => files.size,
      upsertFile: (_p: string, r: any) => { depthAtUpsert.push(txDepth); files.set(r.remoteId, r); },
      deleteFileById: (_p: string, id: string) => { files.delete(id); },
      transaction: (fn: () => unknown) => { txDepth++; try { return fn(); } finally { txDepth--; } },
    };
    const client = {
      requestManifest: vi.fn(async () => ({
        uploads: [{ relPath: "notes.txt", fileId: "f1", r2Key: "k", name: "notes.txt", url: "https://r2.test/put", size: before.size, folderId: null, contentType: "text/plain", ext: "txt" }],
        skipped: 0,
      })),
      // The "PUT" appends to the file after sending, the way an editor's save
      // lands mid-transfer. The real client would reject; this fake resolves
      // to prove the ENGINE's bookkeeping is right regardless.
      uploadToPresignedUrl: vi.fn(async (_u: string, path: string) => { await appendFile(path, " and more"); return { md5: "abc" }; }),
      commitUploads: vi.fn(async () => ({
        committed: 1, results: new Map([["f1", { version: 1, updatedAt: 2 }]]), refused: new Map(), conflicts: new Map(),
      })),
      setFileSyncFlags: vi.fn(async () => {}),
      setFileSyncFlag: vi.fn(async () => {}),
    };
    const engine = new SyncEngine("https://example.test", { ...NULL_ENV, userDataDir: join(base, "appdata") }) as any;
    engine.started = true;
    Object.defineProperty(engine, "index", { value: index });
    engine.client = client;
    engine.emitStatus = () => {};
    engine.putPairMeta = () => {};
    const rt: any = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "syncing", syncing: true, errorMessage: null,
      notices: new Map(), phase: null, lastProgressAt: 0, lastProgressLogAt: 0,
      totalFilesInBatch: 0, completedFilesInBatch: 0, totalBytesInBatch: 0, completedBytesInBatch: 0,
    };
    engine.runtimes.set(pair.id, rt);

    await engine.uploadSmallFiles(rt, [{ absPath: abs, relPath: "notes.txt", isNew: true, sizeBytes: before.size }], []);

    const rec = files.get("f1");
    expect(rec).toBeDefined();
    expect(rec.localSizeBytes).toBe(before.size);
    expect(rec.localMtimeMs).toBe(before.mtimeMs);
    expect(rec.contentHash).toBe("abc");
    expect(depthAtUpsert).toEqual([1]);
    // The pre-PUT stat was handed to the transport so it can refuse a torn upload.
    expect(client.uploadToPresignedUrl.mock.calls[0][4]).toEqual({ expect: { size: before.size, mtimeMs: before.mtimeMs } });
  });

  it("uploadLocalFile records the stat from before the upload, and no hash of the later edit", async () => {
    const abs = join(root, "notes.txt");
    await writeFile(abs, "draft one");
    await utimes(abs, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    const before = await stat(abs);

    const pair: SyncPair = {
      id: "pair", workspaceId: "ws", workspaceName: "Workspace", remoteFolderId: null,
      remoteFolderName: "Root", localPath: root, selectiveFolders: [], excludedPatterns: [],
      region: "auto", pollIntervalMs: 60_000, syncMode: "two-way",
      conflictStrategy: "keep-both", enabled: true, createdAt: Date.now(),
    };
    const files = new Map<string, any>();
    const errors = new Map<string, any>();
    const index = {
      getError: (_p: string, path: string) => errors.get(path),
      iterErrors: () => [...errors.values()],
      upsertError: (_p: string, e: any) => { errors.set(e.filePath, e); },
      clearError: (_p: string, path: string) => { errors.delete(path); },
      getFileById: (_p: string, id: string) => files.get(id),
      getFileByPath: (_p: string, path: string) => [...files.values()].find((r) => r.localPath === path),
      getFolder: () => undefined,
      iterFiles: () => files.values(),
      countFiles: () => files.size,
      upsertFile: (_p: string, r: any) => { files.set(r.remoteId, r); },
      deleteFileById: (_p: string, id: string) => { files.delete(id); },
    };
    const client = {
      // The upload resolves after the user's save has landed on disk: the
      // server holds "draft one", the disk holds more.
      uploadFile: vi.fn(async (path: string) => {
        await appendFile(path, " and more");
        return { fileId: "f1", name: "notes.txt", version: 1, updatedAt: 2 };
      }),
      setFileSyncFlag: vi.fn(async () => {}),
    };
    const engine = new SyncEngine("https://example.test", { ...NULL_ENV, userDataDir: join(base, "appdata") }) as any;
    engine.started = true;
    Object.defineProperty(engine, "index", { value: index });
    engine.client = client;
    engine.emitStatus = () => {};
    engine.putPairMeta = () => {};
    engine.tryDeltaUpload = vi.fn(async () => null);
    engine.recordBlocks = vi.fn(async () => {});
    const rt: any = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "syncing", syncing: true, errorMessage: null,
      notices: new Map(), phase: null, lastProgressAt: 0, lastProgressLogAt: 0,
      totalFilesInBatch: 0, completedFilesInBatch: 0, totalBytesInBatch: 0, completedBytesInBatch: 0,
    };
    engine.runtimes.set(pair.id, rt);

    await engine.uploadLocalFile(rt, abs, "notes.txt");

    expect(client.uploadFile).toHaveBeenCalledTimes(1);
    const rec = files.get("f1");
    expect(rec).toBeDefined();
    expect(rec.localSizeBytes).toBe(before.size);
    expect(rec.localMtimeMs).toBe(before.mtimeMs);
    // A hash of the edited bytes would let the next scan's content check
    // call the unsent edit "already synced".
    const { hashFile } = await import("./hash");
    expect(rec.contentHash).not.toBe(await hashFile(abs));
  });
});
