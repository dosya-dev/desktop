// apps/desktop/src/main/sync/sync-engine-session-expired.test.ts
//
// Runs on vitest (see vitest.config.ts) for the same reason the maintenance
// test does: index.ts uses bundler-style resolution Node's runner can't load.
//
// When the server answers 401 to the sync engine, the engine already parks
// the pair with "Session expired. Please log in again." - but the window
// never heard about it, so a user whose session an admin had just revoked
// kept browsing a signed-in UI. The engine now raises a `session-expired`
// event that main/index.ts forwards to the renderer.
import { describe, expect, it } from "vitest";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type SyncPair } from "./types";

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
    syncMode: "pull-safe",
    conflictStrategy: "last-write-wins",
    enabled: true,
    createdAt: Date.now(),
  };
}

function fakeRuntime(pair: SyncPair) {
  return {
    pair,
    state: EMPTY_PAIR_STATE(pair.id),
    watcher: null,
    poller: null,
    status: "idle" as const,
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

type EngineInternals = {
  runtimes: Map<string, ReturnType<typeof fakeRuntime>>;
  sessionExpired: (rt: ReturnType<typeof fakeRuntime>) => void;
  started: boolean;
};

function withEngine() {
  const engine = new SyncEngine("https://api.dosya.dev", NULL_ENV) as unknown as EngineInternals & SyncEngine;
  engine.started = true;
  const pair = fakePair("pair1");
  const rt = fakeRuntime(pair);
  engine.runtimes.set(pair.id, rt);
  return { engine, rt };
}

describe("SyncEngine session expiry", () => {
  it("parks the pair with the session message and raises session-expired", () => {
    const { engine, rt } = withEngine();
    let raised = 0;
    engine.on("session-expired", () => { raised++; });

    engine.sessionExpired(rt);

    expect(rt.status).toBe("error");
    expect(rt.errorMessage).toMatch(/Session expired/);
    expect(raised).toBe(1);
  });

  it("raises once per pair even when several code paths report the same expiry", () => {
    const { engine, rt } = withEngine();
    let raised = 0;
    engine.on("session-expired", () => { raised++; });

    engine.sessionExpired(rt);
    engine.sessionExpired(rt);

    expect(raised).toBe(1);
  });
});
