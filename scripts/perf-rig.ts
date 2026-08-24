/**
 * Performance rig for the sync index and planner.
 *
 * The 2026-08-20 stress test is the reason this exists: nobody had ever run
 * the engine against a tree the size of the one that killed it, so the first
 * measurement of its memory behaviour was a user losing twelve hours of sync.
 * This makes that measurement cheap and repeatable.
 *
 * It drives the REAL SyncIndex and the REAL planner - no mocks in the parts
 * being measured - over a synthetic tree, and prints the numbers from spec
 * section 1.6. It deliberately does NOT transfer bytes: the network path is
 * separately covered, and what is under test here is whether planning and
 * bookkeeping stay bounded as the tree grows.
 *
 * Run it (from apps/desktop):
 *   npm run perf:sync -- [files] [folders]
 *
 * Defaults to 500,000 files in 30,000 folders. Start smaller (50000 3000) to
 * check the rig itself; the full run takes several minutes and about 1 GB of
 * scratch disk for the database.
 *
 * Electron-free by construction so it runs under plain node.
 */

import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { SyncIndex } from "../src/main/sync/index-db.ts";
import { plan, filterOpsForMode, type BaseView, type LocalFile, type LocalView } from "../src/main/sync/planner.ts";
import type { SyncFileRecord } from "../src/main/sync/types.ts";

const FILES = Number(process.argv[2] ?? 500_000);
const FOLDERS = Number(process.argv[3] ?? 30_000);
const WINDOW = 5_000;

/** Deterministic sizes: log-normal-ish, 1 KB to 10 MB, no RNG dependency. */
function sizeFor(i: number): number {
  const bucket = i % 100;
  if (bucket < 70) return 1_024 + (i % 64) * 512;          // small: 1 KB - 33 KB
  if (bucket < 95) return 256 * 1_024 + (i % 32) * 8_192;  // medium: ~256 KB
  return 4 * 1_024 * 1_024 + (i % 8) * 512 * 1_024;        // large: 4 - 8 MB
}

function relPathFor(i: number): string {
  const folder = i % FOLDERS;
  return `d${folder % 100}/d${folder}/file${i}.bin`;
}

function mb(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(0)} MB`;
}

function peakTracker(): { sample: () => void; peak: () => number } {
  let peak = 0;
  return {
    sample: () => { peak = Math.max(peak, process.memoryUsage().rss); },
    peak: () => peak,
  };
}

function baseViewFor(db: SyncIndex, pairId: string): BaseView {
  return {
    fileByPath: (key) => db.getFileByPath(pairId, key),
    fileById: (id) => db.getFileById(pairId, id),
    files: () => db.iterFiles(pairId),
    folderByPath: (key) => db.getFolder(pairId, key),
    folders: () => db.iterFolders(pairId),
  };
}

function windowOf(start: number, count: number): LocalView {
  const files = new Map<string, LocalFile>();
  for (let i = start; i < start + count && i < FILES; i++) {
    const relPath = relPathFor(i);
    files.set(relPath, { relPath, sizeBytes: sizeFor(i), mtimeMs: 1_700_000_000_000 + i });
  }
  return { files, folders: new Set<string>() };
}

async function main(): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "dosya-perf-"));
  const db = SyncIndex.open(join(dir, "index.db"));
  const pairId = "perf";
  const mem = peakTracker();
  const t0 = Date.now();

  console.log(`Tree: ${FILES.toLocaleString()} files in ${FOLDERS.toLocaleString()} folders, window ${WINDOW.toLocaleString()}\n`);

  // ── Phase 1: cold plan + record, one window at a time ──
  let planned = 0;
  const coldStart = Date.now();
  for (let start = 0; start < FILES; start += WINDOW) {
    const local = windowOf(start, WINDOW);
    const ops = filterOpsForMode(
      plan({ local, remote: null, base: baseViewFor(db, pairId), conflictStrategy: "last-write-wins", localScanIncomplete: true }),
      "push-safe",
    );
    planned += ops.length;
    // Stand in for the executors: record every planned upload as synced.
    db.transaction(() => {
      for (const op of ops) {
        if (op.kind !== "upload-new" && op.kind !== "upload-update") continue;
        const record: SyncFileRecord = {
          remoteId: `r_${op.relPath}`, remoteName: op.relPath.split("/").pop()!, remoteFolderId: null,
          remoteSizeBytes: op.sizeBytes, remoteUpdatedAt: 1_700_000_000, remoteVersion: 1,
          localPath: op.relPath, localSizeBytes: op.sizeBytes,
          localMtimeMs: local.files.get(op.relPath)!.mtimeMs, syncedAt: 1_700_000_000,
        };
        db.upsertFile(pairId, record);
      }
    });
    mem.sample();
    if ((start / WINDOW) % 20 === 0 && start > 0) {
      process.stdout.write(`  planned ${start.toLocaleString()} / ${FILES.toLocaleString()}  rss ${mb(process.memoryUsage().rss)}\r`);
    }
  }
  const coldMs = Date.now() - coldStart;
  console.log(`\nCold pass:      ${(coldMs / 1000).toFixed(1)}s, ${planned.toLocaleString()} ops planned, indexed ${db.countFiles(pairId).toLocaleString()}`);

  // ── Phase 2: no-op rescan of a converged tree (spec target <= 90s, 0 ops) ──
  const rescanStart = Date.now();
  let rescanOps = 0;
  for (let start = 0; start < FILES; start += WINDOW) {
    const ops = filterOpsForMode(
      plan({ local: windowOf(start, WINDOW), remote: null, base: baseViewFor(db, pairId), conflictStrategy: "last-write-wins", localScanIncomplete: true }),
      "push-safe",
    );
    rescanOps += ops.length;
    mem.sample();
  }
  const rescanMs = Date.now() - rescanStart;

  // ── Phase 3: queue throughput at depth ──
  const qStart = Date.now();
  db.transaction(() => db.enqueueOps(pairId, Array.from({ length: 20_000 }, (_, i) => ({ kind: "upload-new", payload: { i } })), Date.now()));
  const enqueueMs = Date.now() - qStart;
  const popStart = process.hrtime.bigint();
  const popped = db.popPendingOps(pairId, 100, Date.now());
  const popMs = Number(process.hrtime.bigint() - popStart) / 1e6;
  mem.sample();

  const peakRss = mem.peak();
  console.log(`No-op rescan:   ${(rescanMs / 1000).toFixed(1)}s, ${rescanOps} ops   ${rescanOps === 0 ? "PASS" : "FAIL - a converged tree must plan nothing"}`);
  console.log(`                target <= 90s   ${rescanMs <= 90_000 ? "PASS" : "FAIL"}`);
  console.log(`Enqueue 20K:    ${enqueueMs}ms`);
  console.log(`Pop 100 @ 20K:  ${popMs.toFixed(2)}ms   ${popMs < 50 ? "PASS" : "FAIL - ops_pending index unused"}`);
  console.log(`Peak RSS:       ${mb(peakRss)}   target < 500 MB   ${peakRss < 500 * 1024 * 1024 ? "PASS" : "FAIL"}`);
  console.log(`Popped:         ${popped.length}`);
  console.log(`Total:          ${((Date.now() - t0) / 1000).toFixed(1)}s`);

  db.close();
  await rm(dir, { recursive: true, force: true });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
