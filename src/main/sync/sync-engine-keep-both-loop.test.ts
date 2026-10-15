// @vitest-environment node
//
// 2026-10-15, live on a Mac App Store build: a two-way keep-both pair over a
// 16-file folder grew to 10,600 files of "x (conflict copy ...) (conflict
// copy ...)" in three hours, every one uploaded to the cloud. The same paths
// came back as conflicts cycle after cycle and keep-both copied them each
// time, then copied the copies. The circuit breaker in raiseConflict stops
// the automatic copy for a conflict copy, and for a path it just kept-both;
// the conflict stays listed for the user instead.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncEngine } from "./index";
import { NULL_ENV } from "./env-provider";
import { EMPTY_PAIR_STATE, type SyncConflict, type SyncPair } from "./types";

describe("keep-both never loops", () => {
  let base: string;
  beforeEach(async () => { base = await mkdtemp(join(tmpdir(), "dosya-keep-both-")); });
  afterEach(async () => { await rm(base, { recursive: true, force: true }); });

  function fixture() {
    const pair: SyncPair = {
      id: "pair", workspaceId: "ws", workspaceName: "Workspace", remoteFolderId: null,
      remoteFolderName: "Root", localPath: join(base, "root"), selectiveFolders: [], excludedPatterns: [],
      region: "auto", pollIntervalMs: 60_000, syncMode: "two-way",
      conflictStrategy: "keep-both", enabled: true, createdAt: Date.now(),
    };
    const engine = new SyncEngine("https://example.test", { ...NULL_ENV, userDataDir: join(base, "appdata") }) as any;
    engine.started = true;
    engine.emitStatus = () => {};
    engine.log = vi.fn();
    // Stand-in for the real rename + upload: take the card off the list, as
    // resolveConflict does on success.
    const resolve = vi.fn(async (id: string) => {
      engine.conflicts = engine.conflicts.filter((c: SyncConflict) => c.id !== id);
    });
    engine.resolveConflict = resolve;
    const rt: any = { pair, state: EMPTY_PAIR_STATE(pair.id), notices: new Map() };
    engine.runtimes.set(pair.id, rt);
    return { engine, rt, resolve, pair };
  }

  let seq = 0;
  function conflict(pair: SyncPair, name: string): SyncConflict {
    return {
      id: `c${++seq}`, pairId: pair.id, localPath: join(pair.localPath, "png", name),
      remoteName: name, remoteId: `r${seq}`, localMtimeMs: 1, remoteUpdatedAt: 1,
      localSizeBytes: 1, remoteSizeBytes: 1, detectedAt: Date.now(),
    };
  }

  it("keeps both once, then leaves a path that comes straight back for the user", async () => {
    const { engine, rt, resolve, pair } = fixture();
    await engine.raiseConflict(rt, conflict(pair, "01-overview.png"));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(engine.conflicts).toHaveLength(0);

    // Next cycle: the same path is a conflict again.
    await engine.raiseConflict(rt, conflict(pair, "01-overview.png"));
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(engine.conflicts).toHaveLength(1);
    expect(rt.notices.get("conflict-copy")?.message).toMatch(/paused/);
  });

  it("never makes a conflict copy of a conflict copy", async () => {
    const { engine, rt, resolve, pair } = fixture();
    await engine.raiseConflict(rt, conflict(pair, "01-overview (conflict copy 2026-10-15 09-09-08 from Frats-MacBook-Air.local).png"));
    expect(resolve).not.toHaveBeenCalled();
    expect(engine.conflicts).toHaveLength(1);
  });

  it("still keeps both for different files in the same cycle", async () => {
    const { engine, rt, resolve, pair } = fixture();
    await engine.raiseConflict(rt, conflict(pair, "a.png"));
    await engine.raiseConflict(rt, conflict(pair, "b.png"));
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(engine.conflicts).toHaveLength(0);
  });

  it("pages the list and reports counts per pair in status", async () => {
    const { engine, pair } = fixture();
    for (let i = 0; i < 120; i++) engine.conflicts.push(conflict(pair, `f${i}.png`));
    const page = await engine.listConflicts({ pairIds: [pair.id], offset: 100, limit: 50 });
    expect(page.total).toBe(120);
    expect(page.conflicts).toHaveLength(20);
  });

  it("bulk resolve works through a snapshot and does not retry failures in a loop", async () => {
    const { engine, pair } = fixture();
    for (let i = 0; i < 5; i++) engine.conflicts.push(conflict(pair, `f${i}.png`));
    let calls = 0;
    // Every resolution fails and re-queues, like an unsafe path does.
    engine.resolveConflict = vi.fn(async (id: string) => {
      calls++;
      const idx = engine.conflicts.findIndex((c: SyncConflict) => c.id === id);
      const [c] = engine.conflicts.splice(idx, 1);
      engine.conflicts.push(c);
      throw new Error("Unsafe sync path");
    });
    const { queued } = await engine.resolveConflicts([pair.id], "keep-both");
    expect(queued).toBe(5);
    await vi.waitFor(() => expect(engine.bulkResolving).toBe(false));
    expect(calls).toBe(5);
    expect(engine.conflicts).toHaveLength(5);
  });
});
