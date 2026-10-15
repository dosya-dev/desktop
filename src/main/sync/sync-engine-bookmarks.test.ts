import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "./index";
import { closeSyncIndex } from "./config";
import { NULL_ENV, type EnvProvider } from "./env-provider";
import { EMPTY_PAIR_STATE, type SyncPair } from "./types";

/**
 * The sandbox grant is taken BEFORE the engine touches the folder, so a
 * missing grant reads as "needs permission" and never as "folder not found";
 * and it is released exactly when the runtime is disposed, not on the pauses
 * that keep a watcher's folder.
 */

function pair(localPath: string): SyncPair {
  return {
    id: "p1",
    workspaceId: "ws1",
    workspaceName: "Workspace",
    remoteFolderId: null,
    remoteFolderName: "Folder",
    localPath,
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

/**
 * Minimal PairRuntime - same shape startPair builds, private to index.ts.
 * Used only by the pause-vs-stop test below, which exercises pausePair and
 * stop() directly rather than going through startPair (which would need a
 * real watcher/poller and a reachable server to reach "idle" normally).
 */
function fakeRuntime(p: SyncPair, releaseFolderAccess: () => void) {
  return {
    pair: p,
    state: EMPTY_PAIR_STATE(p.id),
    watcher: null,
    poller: null,
    releaseFolderAccess,
    status: "idle" as string,
    errorMessage: null as string | null,
    syncing: false,
    queuedSync: false,
    queuedEvents: new Map(),
    queuedOverflow: false,
    rateLimitResumeTimer: null,
    rescanTimer: null,
    notices: new Map(),
    pendingDeletion: null,
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

describe("SyncEngine folder grants", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "engine-bm-"));
  });
  afterEach(async () => {
    await closeSyncIndex();
    rmSync(dir, { recursive: true, force: true });
  });

  function engineWith(folderAccess: EnvProvider["folderAccess"]) {
    const env: EnvProvider = { ...NULL_ENV, userDataDir: dir, folderAccess };
    const engine = new SyncEngine("https://api.invalid", env) as any;
    engine.started = true;
    return engine;
  }

  it("a pair without a grant lands in needs-permission, not error", async () => {
    const engine = engineWith(() => ({ ok: false, reason: "no-bookmark" }));
    await engine.startPair(pair(join(dir, "does-not-exist")));
    const rt = engine.runtimes.get("p1");
    expect(rt.status).toBe("needs-permission");
    expect(rt.errorMessage).toMatch(/permission/i);
    expect(rt.watcher).toBeNull();
  });

  it("a stale grant reads the same way", async () => {
    const engine = engineWith(() => ({ ok: false, reason: "stale" }));
    await engine.startPair(pair(join(dir, "does-not-exist")));
    expect(engine.runtimes.get("p1").status).toBe("needs-permission");
  });

  it("a granted pair whose folder is missing still reports the missing folder, and releases on stop", async () => {
    const release = vi.fn();
    const engine = engineWith(() => ({ ok: true, release }));
    await engine.startPair(pair(join(dir, "does-not-exist")));
    const rt = engine.runtimes.get("p1");
    expect(rt.status).toBe("error");
    expect(rt.errorMessage).toMatch(/not found/);
    expect(release).not.toHaveBeenCalled();
    await engine.stopPair("p1");
    expect(release).toHaveBeenCalledTimes(1);
    expect(engine.runtimes.has("p1")).toBe(false);
  });

  it("a host without a sandbox grants everything", async () => {
    const engine = engineWith(undefined);
    await engine.startPair(pair(join(dir, "does-not-exist")));
    expect(engine.runtimes.get("p1").status).toBe("error");
  });

  it("release runs on stop(), not on a pause - a paused pair keeps its folder", async () => {
    const release = vi.fn();
    const engine = engineWith(undefined);
    engine.runtimes.set("p1", fakeRuntime(pair(dir), release));

    await engine.pausePair("p1");
    expect(release).not.toHaveBeenCalled();
    expect(engine.runtimes.get("p1").status).toBe("paused");
    expect(engine.runtimes.has("p1")).toBe(true);

    await engine.stop();
    expect(release).toHaveBeenCalledTimes(1);
    expect(engine.runtimes.has("p1")).toBe(false);
  });
});
