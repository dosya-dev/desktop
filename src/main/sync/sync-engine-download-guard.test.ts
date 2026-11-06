// @vitest-environment node
//
// A download-update decided from a scan must not land on a file the user
// saved after that scan. The fake client honours the client contract: it
// awaits `beforeReplace` right before renaming the temp file into place.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type RemoteFileInfo, type SyncAction, type SyncFileRecord, type SyncPair } from "./types";
import { syncDirectory } from "./dir-sync";

vi.mock("./dir-sync", () => ({ syncDirectory: vi.fn(async () => {}) }));

const remoteBytes = "server version v2";
const localEdit = "my unsaved masterpiece";
const preScanEdit = "an edit the planner already saw at scan time";

describe("download-update refuses to overwrite a local edit", () => {
  let base: string;
  let root: string;
  beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "dosya-dl-guard-"));
    root = join(base, "root");
    await mkdir(root);
  });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  interface FixtureOpts {
    strategy?: SyncPair["conflictStrategy"];
    /** The user edits the file BEFORE the scan; the action then carries the
     *  scan's view of it as `expectedLocal`, as reconcile() does. */
    editBeforeScan?: boolean;
    /** The user deletes the file mid-download instead of editing it. */
    deleteMidDownload?: boolean;
    /** An untracked file already sits at the path (pull path, no record). */
    untrackedLocal?: boolean;
  }

  async function fixture(
    interfere: boolean, syncMode: SyncPair["syncMode"] = "two-way", kind: "update" | "new" = "update",
    opts: FixtureOpts = {},
  ) {
    const abs = join(root, "report.txt");
    if (kind === "update") {
      await writeFile(abs, "server version v1");
      await utimes(abs, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    }
    if (opts.untrackedLocal) await writeFile(abs, localEdit);
    const before = kind === "update" ? await stat(abs) : { size: 0, mtimeMs: 0 };
    let expectedLocal: { sizeBytes: number; mtimeMs: number } | undefined;
    if (opts.editBeforeScan) {
      await writeFile(abs, preScanEdit);
      await utimes(abs, new Date(1_700_000_100_000), new Date(1_700_000_100_000));
      const scanned = await stat(abs);
      expectedLocal = { sizeBytes: scanned.size, mtimeMs: scanned.mtimeMs };
    }
    const pair: SyncPair = {
      id: "pair", workspaceId: "ws", workspaceName: "Workspace", remoteFolderId: null,
      remoteFolderName: "Root", localPath: root, selectiveFolders: [], excludedPatterns: [],
      region: "auto", pollIntervalMs: 60_000, syncMode,
      conflictStrategy: opts.strategy ?? "keep-both", enabled: true, createdAt: Date.now(),
    };
    const existingRecord: SyncFileRecord = {
      remoteId: "file", remoteName: "report.txt", remoteFolderId: null,
      remoteSizeBytes: before.size, remoteUpdatedAt: 1, remoteVersion: 1,
      localPath: "report.txt", localSizeBytes: before.size, localMtimeMs: before.mtimeMs, syncedAt: 1,
    };
    const remoteFile: RemoteFileInfo = {
      id: "file", name: "report.txt", size_bytes: remoteBytes.length, mime_type: "text/plain",
      extension: "txt", region: "auto", folder_id: null, updated_at: 2, current_version: 2,
    };
    const errors = new Map<string, any>();
    const files = new Map<string, any>(kind === "update" ? [["file", existingRecord]] : []);
    const index = {
      getError: (_p: string, path: string) => errors.get(path),
      iterErrors: () => [...errors.values()],
      upsertError: (_p: string, e: any) => { errors.set(e.filePath, e); },
      clearError: (_p: string, path: string) => { errors.delete(path); },
      getFileById: (_p: string, id: string) => files.get(id),
      getFileByPath: (_p: string, path: string) => [...files.values()].find((r) => r.localPath === path),
      iterFiles: () => files.values(),
      countFiles: () => files.size,
      upsertFile: (_p: string, r: any) => { files.set(r.remoteId, r); },
      deleteFileById: (_p: string, id: string) => { files.delete(id); },
      transaction: vi.fn((fn: () => unknown) => fn()),
    };
    const download = vi.fn(async (_url: string, target: string, _size: number, _p: unknown, _safe: unknown, beforeReplace?: () => Promise<void>) => {
      await writeFile(`${target}.dosya-sync-tmp`, remoteBytes);
      if (interfere) await writeFile(target, localEdit); // the user saves mid-download
      if (opts.deleteMidDownload) await rm(target, { force: true }); // the user deletes it
      try {
        await beforeReplace?.();
      } catch (err) {
        await rm(`${target}.dosya-sync-tmp`, { force: true }); // the real client discards the temp file
        throw err;
      }
      await rename(`${target}.dosya-sync-tmp`, target);
      return remoteBytes.length;
    });
    const client = {
      clearCookieCache: () => {},
      requestDownloadManifest: vi.fn(async () => new Map([["file", { url: "https://r2.test/file", name: "report.txt", size: remoteBytes.length }]])),
      downloadFromPresignedUrl: download,
      downloadFile: download,
    };
    const engine = new SyncEngine("https://example.test", { ...NULL_ENV, userDataDir: join(base, "appdata") }) as any;
    engine.started = true;
    Object.defineProperty(engine, "index", { value: index });
    engine.client = client;
    engine.emitStatus = () => {};
    engine.ensureDiskSpace = async () => {};
    engine.putPairMeta = () => {};
    engine.resolveConflict = vi.fn(async () => {});
    const rt: any = {
      pair, state: EMPTY_PAIR_STATE(pair.id), status: "idle", syncing: false, errorMessage: null,
      notices: new Map(), phase: null, lastProgressAt: 0, lastProgressLogAt: 0,
      totalFilesInBatch: 0, completedFilesInBatch: 0, totalBytesInBatch: 0, completedBytesInBatch: 0,
    };
    engine.runtimes.set(pair.id, rt);
    const action: SyncAction = kind === "update"
      ? { type: "download-update", remoteFile, localPath: abs, existingRecord, ...(expectedLocal ? { expectedLocal } : {}) }
      : { type: "download-new", remoteFile, localDir: root };
    return { engine, rt, action, abs, files, errors, remoteFile, client, index };
  }

  it("keeps the edit and raises a conflict instead of renaming over it", async () => {
    const { engine, rt, action, abs, files, errors } = await fixture(true);
    await engine.executeActions(rt, [action]);
    expect(await readFile(abs, "utf8")).toBe(localEdit);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBeGreaterThan(0);
    expect(files.get("file").remoteVersion).toBe(1); // record not advanced
    expect(errors.get("report.txt")).toBeUndefined(); // a conflict, not a retry
    await expect(stat(`${abs}.dosya-sync-tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replaces an unchanged file as before", async () => {
    const { engine, rt, action, abs, files } = await fixture(false);
    await engine.executeActions(rt, [action]);
    expect(await readFile(abs, "utf8")).toBe(remoteBytes);
    expect(files.get("file").remoteVersion).toBe(2);
  });

  it("download-new onto an unexpected local file raises a conflict", async () => {
    const { engine, rt, action, abs, files, errors } = await fixture(true, "two-way", "new");
    await engine.executeActions(rt, [action]);
    expect(await readFile(abs, "utf8")).toBe(localEdit);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBeGreaterThan(0);
    expect(files.size).toBe(0); // no record written for bytes we did not place
    expect(errors.get("report.txt")).toBeUndefined();
    await expect(stat(`${abs}.dosya-sync-tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("download-new with no local file still lands", async () => {
    const { engine, rt, action, abs, files } = await fixture(false, "two-way", "new");
    await engine.executeActions(rt, [action]);
    expect(await readFile(abs, "utf8")).toBe(remoteBytes);
    expect(files.get("file").remoteVersion).toBe(2);
  });

  it("handleRemoteChanges (watcher path) also keeps a local edit and raises a conflict", async () => {
    const { engine, abs, files, errors, remoteFile } = await fixture(true, "pull");
    await engine.handleRemoteChanges("pair", { files: new Map([["file", remoteFile]]), folders: new Map() });
    expect(await readFile(abs, "utf8")).toBe(localEdit);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBeGreaterThan(0);
    expect(files.get("file").remoteVersion).toBe(1);
    expect(errors.get("report.txt")).toBeUndefined();
    await expect(stat(`${abs}.dosya-sync-tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("last-write-wins replaces a file edited before the scan", async () => {
    const { engine, rt, action, abs, files, errors } = await fixture(false, "two-way", "update", {
      strategy: "last-write-wins", editBeforeScan: true,
    });
    await engine.executeActions(rt, [action]);
    expect(await readFile(abs, "utf8")).toBe(remoteBytes);
    expect(files.get("file").remoteVersion).toBe(2);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBe(0);
    expect(errors.get("report.txt")).toBeUndefined();
  });

  it("last-write-wins still refuses an edit made after the scan", async () => {
    const { engine, rt, action, abs, files, errors } = await fixture(true, "two-way", "update", {
      strategy: "last-write-wins", editBeforeScan: true,
    });
    await engine.executeActions(rt, [action]);
    expect(await readFile(abs, "utf8")).toBe(localEdit);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBeGreaterThan(0);
    expect(files.get("file").remoteVersion).toBe(1);
    expect(errors.get("report.txt")).toBeUndefined();
  });

  it("download-update onto a path the user deleted lands the server copy", async () => {
    const { engine, rt, action, abs, files, errors } = await fixture(false, "two-way", "update", {
      deleteMidDownload: true,
    });
    await engine.executeActions(rt, [action]);
    expect(await readFile(abs, "utf8")).toBe(remoteBytes);
    expect(files.get("file").remoteVersion).toBe(2);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBe(0);
    expect(errors.get("report.txt")).toBeUndefined();
  });

  it("handleRemoteChanges onto a path the user deleted lands the server copy", async () => {
    const { engine, abs, files, remoteFile } = await fixture(false, "pull", "update", { deleteMidDownload: true });
    await engine.handleRemoteChanges("pair", { files: new Map([["file", remoteFile]]), folders: new Map() });
    expect(await readFile(abs, "utf8")).toBe(remoteBytes);
    expect(files.get("file").remoteVersion).toBe(2);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBe(0);
  });

  it("handleRemoteChanges under last-write-wins replaces a file edited before the poll decided", async () => {
    const { engine, abs, files, remoteFile } = await fixture(false, "pull", "update", {
      editBeforeScan: true, strategy: "last-write-wins",
    });
    await engine.handleRemoteChanges("pair", { files: new Map([["file", remoteFile]]), folders: new Map() });
    expect(await readFile(abs, "utf8")).toBe(remoteBytes);
    expect(files.get("file").remoteVersion).toBe(2);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBe(0);
  });

  it("handleRemoteChanges under keep-both raises a conflict for a file edited since the last sync and downloads nothing", async () => {
    const { engine, abs, files, errors, remoteFile, client } = await fixture(false, "pull", "update", { editBeforeScan: true });
    await engine.handleRemoteChanges("pair", { files: new Map([["file", remoteFile]]), folders: new Map() });
    expect(await readFile(abs, "utf8")).toBe(preScanEdit);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBeGreaterThan(0);
    expect(client.downloadFile).not.toHaveBeenCalled();
    expect(client.downloadFromPresignedUrl).not.toHaveBeenCalled();
    expect(files.get("file").remoteVersion).toBe(1);
    expect(errors.get("report.txt")).toBeUndefined();
  });

  it("pull path refuses to overwrite an untracked local file", async () => {
    const { engine, abs, files, errors, remoteFile } = await fixture(false, "pull", "new", { untrackedLocal: true });
    await engine.handleRemoteChanges("pair", { files: new Map([["file", remoteFile]]), folders: new Map() });
    expect(await readFile(abs, "utf8")).toBe(localEdit);
    expect(engine.conflicts.length + engine.resolveConflict.mock.calls.length).toBeGreaterThan(0);
    expect(files.size).toBe(0);
    expect(errors.get("report.txt")).toBeUndefined();
    await expect(stat(`${abs}.dosya-sync-tmp`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.skipIf(process.platform !== "darwin" && process.platform !== "win32")(
    "pull path skips case-colliding remote names",
    async () => {
      const { engine, files, errors, remoteFile, client } = await fixture(false, "pull", "new");
      const upper = { ...remoteFile, id: "upper", name: "Report.txt" };
      const lower = { ...remoteFile, id: "lower", name: "report.txt" };
      const other = { ...remoteFile, id: "other", name: "other.txt" };
      await engine.handleRemoteChanges("pair", {
        files: new Map([[upper.id, upper], [lower.id, lower], [other.id, other]]),
        folders: new Map(),
      });
      const targets = client.downloadFile.mock.calls.map((c: unknown[]) => String(c[1]));
      expect(targets.some((t: string) => /report\.txt$/i.test(t))).toBe(false);
      expect(await readFile(join(root, "other.txt"), "utf8")).toBe(remoteBytes);
      await expect(stat(join(root, "report.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect(files.has("upper") || files.has("lower")).toBe(false);
      expect(errors.get("Report.txt")?.permanent).toBe(true);
      expect(errors.get("report.txt")?.permanent).toBe(true);
      expect(errors.get("report.txt")?.error).toMatch(/differ only by letter case/);
    },
  );

  it.each(["pull", "pull-safe"] as const)(
    "keep-both in %s mode keeps the conflict copy locally without uploading",
    async (mode) => {
      const { engine, abs, remoteFile, rt } = await fixture(true, mode);
      engine.resolveConflict = SyncEngine.prototype.resolveConflict.bind(engine);
      const uploads = { uploadLocalFile: vi.fn(async () => {}) };
      engine.uploadLocalFile = uploads.uploadLocalFile;
      const triggerNow = vi.fn();
      rt.poller = { triggerNow };
      await engine.handleRemoteChanges("pair", { files: new Map([["file", remoteFile]]), folders: new Map() });
      expect(uploads.uploadLocalFile).not.toHaveBeenCalled();
      // The edit survives as a conflict copy beside the vacated original.
      const { readdir } = await import("node:fs/promises");
      const names = await readdir(root);
      const copy = names.find((n) => n !== "report.txt" && !n.endsWith(".dosya-sync-tmp"));
      expect(copy).toBeDefined();
      expect(await readFile(join(root, copy!), "utf8")).toBe(localEdit);
      await expect(stat(abs)).rejects.toMatchObject({ code: "ENOENT" });
      expect(engine.conflicts.length).toBe(0);
      // The vacated path is filled by a fresh poll once this run ends.
      expect(triggerNow).toHaveBeenCalled();
    },
  );

  it("a batch of downloads into one directory syncs that directory once, after the batch", async () => {
    const { engine, rt, remoteFile, client, files } = await fixture(false, "two-way", "new");
    vi.mocked(syncDirectory).mockClear();
    // Durability order: the directory is synced BEFORE any row says synced.
    let rowsAtSync = -1;
    vi.mocked(syncDirectory).mockImplementationOnce(async () => { rowsAtSync = files.size; });
    const actions: SyncAction[] = ["a", "b", "c", "d"].map((n) => ({
      type: "download-new", remoteFile: { ...remoteFile, id: n, name: `${n}.txt` }, localDir: root,
    }));
    let landed = 0;
    const inner = client.downloadFile.getMockImplementation()!;
    client.downloadFile.mockImplementation(async (...args: any[]) => {
      // No directory sync may happen while files are still landing.
      expect(vi.mocked(syncDirectory)).not.toHaveBeenCalled();
      const n = await (inner as any)(...args);
      landed++;
      return n;
    });
    await engine.executeActions(rt, actions);
    expect(landed).toBe(4);
    expect(vi.mocked(syncDirectory)).toHaveBeenCalledTimes(1);
    expect(String(vi.mocked(syncDirectory).mock.calls[0][0]).endsWith("root")).toBe(true);
    expect(rowsAtSync).toBe(0);
    expect(files.size).toBe(4);
  });

  it("a long download phase records its landings in bounded slices, one directory sync per slice", async () => {
    const { engine, rt, remoteFile, client, files, index } = await fixture(false, "two-way", "new");
    vi.mocked(syncDirectory).mockClear();
    const total = 450;
    const actions: SyncAction[] = Array.from({ length: total }, (_, i) => ({
      type: "download-new", remoteFile: { ...remoteFile, id: `f${i}`, name: `f${i}.txt` }, localDir: root,
    }));
    let landed = 0;
    let flushesBeforeLast = -1;
    const inner = client.downloadFile.getMockImplementation()!;
    client.downloadFile.mockImplementation(async (...args: any[]) => {
      const n = await (inner as any)(...args);
      if (++landed === total) flushesBeforeLast = index.transaction.mock.calls.length;
      return n;
    });
    await engine.executeActions(rt, actions);
    expect(files.size).toBe(total);
    // 200-record slices: at least two were written while the phase ran.
    expect(flushesBeforeLast).toBeGreaterThanOrEqual(2);
    // Each slice syncs its directory once; never once per file.
    const flushes = index.transaction.mock.calls.length;
    expect(vi.mocked(syncDirectory).mock.calls.length).toBe(flushes);
    expect(flushes).toBeLessThan(total / 10);
  });

  it("stop flushes landed records", async () => {
    const { engine, rt, remoteFile, client, files } = await fixture(false, "two-way", "new");
    const landedFirst = 3;
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let started = 0;
    let landed = 0;
    const landedIds: string[] = [];
    const inner = client.downloadFile.getMockImplementation()!;
    client.downloadFile.mockImplementation(async (...args: any[]) => {
      // Which files reach the client first depends on scheduling; the first
      // three to arrive land, the rest hang mid-transfer.
      if (++started > landedFirst) await gate;
      const n = await (inner as any)(...args);
      landedIds.push(String(args[0]));
      landed++;
      return n;
    });
    const actions: SyncAction[] = ["a", "b", "c", "d", "e"].map((n) => ({
      type: "download-new", remoteFile: { ...remoteFile, id: n, name: `${n}.txt` }, localDir: root,
    }));
    const phase = engine.executeActions(rt, actions);
    while (landed < landedFirst) await new Promise((r) => setTimeout(r, 5));
    await new Promise((r) => setTimeout(r, 20)); // let the landings be noted
    expect(files.size).toBe(0); // still pending: under the slice size and age
    await engine.stop();
    expect(landedIds.length).toBe(landedFirst);
    expect([...files.keys()].sort()).toEqual([...landedIds].sort());
    release();
    await phase.catch(() => {});
  });

  it("the pull path also syncs each landed directory once", async () => {
    const { engine, remoteFile } = await fixture(false, "pull", "new");
    vi.mocked(syncDirectory).mockClear();
    const files = new Map(["a", "b"].map((n) => [n, { ...remoteFile, id: n, name: `${n}.txt` }] as const));
    await engine.handleRemoteChanges("pair", { files, folders: new Map() });
    expect(await readFile(join(root, "a.txt"), "utf8")).toBe(remoteBytes);
    expect(vi.mocked(syncDirectory)).toHaveBeenCalledTimes(1);
  });

  it("handleRemoteChanges still replaces an unchanged tracked file", async () => {
    const { engine, abs, files, remoteFile } = await fixture(false, "pull");
    await engine.handleRemoteChanges("pair", { files: new Map([["file", remoteFile]]), folders: new Map() });
    expect(await readFile(abs, "utf8")).toBe(remoteBytes);
    expect(files.get("file").remoteVersion).toBe(2);
  });
});
