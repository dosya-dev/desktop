// @vitest-environment node
//
// SyncEngine has the same TS parameter-property + extensionless-import shape
// as remote-client.ts and cannot load under Node's own type-stripping test
// runner (confirmed: `constructor(private max: number) {}` on Semaphore
// alone throws ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX). It runs on vitest instead,
// same as remote-client.maintenance.test.ts - see vitest.config.ts's include
// list and that file's header comment for the precedent.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type SyncPair } from "./types";
import type { SyncStatus } from "./types";

/**
 * Round 3 fixes for two bugs found in the maintenance-pause plumbing:
 *
 * 1. The engine-level `maintenance` flag was only cleared in clearOffline,
 *    but checkRecovery's periodic getWorkspaceRegion() probe - the DOMINANT
 *    recovery path - calls resumeAfterRecovery directly and never went
 *    through clearOffline, so the tray's "Sync paused - maintenance" could
 *    stay stuck until the app restarted even after the pair recovered.
 * 2. setMaintenance() had no idempotency guard (unlike setOffline), so every
 *    failed poll during a maintenance window re-logged and re-emitted.
 *
 * These construct a real SyncEngine (constructing one does no I/O - `index`
 * is a getter, lazily opened, and the fake PairRuntime's syncMode is
 * "pull-safe" so resumeAfterRecovery's runInitialScan branch never fires) and
 * exercise its private state-transition methods directly, the same way
 * remote-client.maintenance.test.ts reaches RemoteClient's private fetchOnce.
 *
 * getStatus() reads the SQLite error ledger via openSyncIndex() -> syncDir(),
 * which falls back to Electron's `app.getPath("userData")` since NULL_ENV
 * leaves `userDataDir` empty. Outside Electron that throws, and getStatus()'s
 * own try/catch ("a status read must never throw - the tray builds its menu
 * from it") logs it to stderr and carries on with fileErrorCount 0. Expected,
 * harmless noise in this test's output - not a failure.
 */

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
    // Deliberately NOT two-way/push/push-safe: resumeAfterRecovery only calls
    // runInitialScan for those modes, and this test has no real folder to scan.
    syncMode: "pull-safe",
    conflictStrategy: "last-write-wins",
    enabled: true,
    createdAt: Date.now(),
  };
}

/** Minimal PairRuntime - same shape addPair builds, private to index.ts so
 *  this duplicates only the fields these two code paths actually touch. */
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

/** Reach into the engine's private surface the way remote-client's test does. */
type EngineInternals = {
  runtimes: Map<string, ReturnType<typeof fakeRuntime>>;
  setMaintenance: (rt: ReturnType<typeof fakeRuntime>, message: string) => void;
  resumeAfterRecovery: (pairId: string, rt: ReturnType<typeof fakeRuntime>) => void;
  logs: { message: string }[];
  /** `stopped` is `!started`, and every mutator here guards on it - flip it
   *  without going through the real start() lifecycle (config load, index
   *  migration, watcher/poller wiring), none of which this test needs. */
  started: boolean;
};

function withEngine() {
  const engine = new SyncEngine("https://api.dosya.dev", NULL_ENV) as unknown as EngineInternals & SyncEngine;
  engine.started = true;
  const pair = fakePair("pair1");
  const rt = fakeRuntime(pair);
  engine.runtimes.set(pair.id, rt);
  return { engine, pair, rt };
}

describe("SyncEngine maintenance plumbing", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("resumeAfterRecovery clears the engine-level maintenance flag, not just clearOffline", () => {
    const { engine, pair, rt } = withEngine();
    engine.setMaintenance(rt, "brb");
    expect(rt.status).toBe("offline");
    // emitStatus() throttles bursts into one coalesced emission per 500ms;
    // let the entry pause's emission actually land before moving on, so the
    // recovery's own emission below is observed on a clean throttle window.
    vi.advanceTimersByTime(500);

    const emitted: SyncStatus[] = [];
    engine.on("status-changed", (s: SyncStatus) => emitted.push(s));

    engine.resumeAfterRecovery(pair.id, rt);
    vi.advanceTimersByTime(500); // flush the throttled emission

    expect(rt.status).toBe("idle");
    expect(rt.errorMessage).toBeNull();
    expect(emitted.length).toBeGreaterThan(0);
    expect(emitted[emitted.length - 1].maintenance).toBe(false);
    expect(engine.getStatus().maintenance).toBe(false);
  });

  it("a second setMaintenance with the same message logs and emits nothing new", () => {
    const { engine, rt } = withEngine();
    engine.setMaintenance(rt, "brb");
    const logsAfterFirst = engine.logs.length;

    let emissions = 0;
    engine.on("status-changed", () => { emissions++; });

    engine.setMaintenance(rt, "brb");

    expect(engine.logs.length).toBe(logsAfterFirst);
    expect(emissions).toBe(0);
    expect(rt.errorMessage).toBe("Paused for maintenance: brb");
  });

  it("a changed message during the same maintenance window updates once", () => {
    const { engine, rt } = withEngine();
    engine.setMaintenance(rt, "brb");
    const logsAfterFirst = engine.logs.length;

    engine.setMaintenance(rt, "back in 5");

    expect(engine.logs.length).toBe(logsAfterFirst + 1);
    expect(rt.errorMessage).toBe("Paused for maintenance: back in 5");
  });
});
