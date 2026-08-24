import type { PlanOp, BaseView, LocalView, RemoteView } from "./planner";
import type { SyncFileRecord } from "./types";

/**
 * A virtual world (local disk + server + base tree) for property-testing the
 * planner.
 *
 * THIS FILE IS THE TRUST BOUNDARY OF THE ENTIRE PROOF. The properties are only
 * as meaningful as this executor's fidelity: if `executeOps` models something
 * the real executors do not do, the tests go green while shipping a bug. So
 * the contract is written down HERE first, and both this simulator and the
 * real executors (Phase 3) are derived from it. Any disagreement is a bug in
 * whichever one drifted.
 *
 * ── EXECUTOR CONTRACT ──────────────────────────────────────────────────────
 *
 * A precondition marked THROW means: if it does not hold, the PLANNER emitted
 * an operation it had no business emitting. The simulator throws rather than
 * coping, because coping is how a real engine quietly destroys data.
 *
 * | op                   | precondition (else THROW)                    | local            | remote                       | base                       |
 * |----------------------|----------------------------------------------|------------------|------------------------------|----------------------------|
 * | create-remote-folder | (out of scope - flat namespace)              | -                | -                            | -                          |
 * | create-local-folder  | (out of scope - flat namespace)              | -                | -                            | -                          |
 * | upload-new           | path exists locally                          | unchanged        | NEW id, v1, content := local | old row (if any) replaced  |
 * | upload-update        | remote row exists; path exists locally        | unchanged        | content := local, version++  | row := local + new remote  |
 * | check-content        | base row exists                              | unchanged        | if content differs: as above | differs? as above : mtime  |
 * | download-new         | remote row exists                            | content := remote| unchanged                    | row inserted               |
 * | download-update      | remote row exists AND (base row absent =      | content := remote| unchanged                    | row := remote              |
 * |                      | adoption, or local matches base exactly)      |                  |                              |                            |
 * |                      | - either exception needs last-write-wins      |                  |                              |                            |
 * | delete-remote        | base row exists AND path absent locally (I1) | unchanged        | row removed                  | row removed                |
 * | delete-local         | base row exists AND local matches base (I1)  | file removed     | unchanged                    | row removed                |
 * | move-local           | base row exists                              | renamed          | unchanged                    | row.localPath := new path  |
 * | move-remote          | base row exists; NO bytes may move           | unchanged        | row.relPath := new path      | row.localPath := new path  |
 * | conflict             | none                                         | unchanged        | unchanged                    | unchanged (recorded only)  |
 *
 * The two I1 preconditions are the heart of it: the engine may never delete or
 * overwrite local bytes that the base tree does not confirm it already has -
 * with exactly one exception, last-write-wins, where the user has explicitly
 * chosen that the newer side wins. Those overwrites are recorded in
 * `acknowledgedLosses` so a property can assert they happen ONLY under that
 * strategy.
 *
 * Scope limits, stated honestly: the namespace is flat (no subfolders), so
 * folder operations are asserted never to appear rather than being modelled,
 * and content is a short string whose identity doubles as its hash.
 */

interface SimLocalFile {
  content: string;
  mtimeMs: number;
}

interface SimRemoteFile {
  remoteId: string;
  relPath: string;
  content: string;
  updatedAt: number; // seconds
  version: number;
}

/** Deterministic PRNG (xorshift32) - same approach as chunker.ts's gear table. */
export function makeRng(seed: number): () => number {
  let x = seed >>> 0 || 0x9e3779b9;
  return () => {
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5; x >>>= 0;
    return x / 0x100000000;
  };
}

export type Strategy = "last-write-wins" | "keep-both";

export class SimWorld {
  /** Monotonic logical clock: seconds for the server, milliseconds locally. */
  private tick = 100;
  private nextId = 1;
  readonly local = new Map<string, SimLocalFile>();
  readonly remote = new Map<string, SimRemoteFile>();
  readonly base = new Map<string, SyncFileRecord>();
  /** Overwrites of locally-changed bytes - legal ONLY under last-write-wins. */
  readonly acknowledgedLosses: string[] = [];
  readonly conflicts: string[] = [];

  // Declared explicitly: `node --test` strips types without transforming,
  // and constructor parameter properties are unsupported there.
  readonly strategy: Strategy;

  constructor(strategy: Strategy) {
    this.strategy = strategy;
  }

  private advance(): number {
    return ++this.tick;
  }

  // ── Views handed to the planner ─────────────────────────────────

  views(): { local: LocalView; remote: RemoteView; base: BaseView } {
    const localFiles = new Map(
      [...this.local].map(([relPath, f]) => [relPath, { relPath, sizeBytes: f.content.length, mtimeMs: f.mtimeMs }]),
    );
    const remoteList = [...this.remote.values()].map((r) => ({
      remoteId: r.remoteId, relPath: r.relPath, name: r.relPath,
      folderId: null, sizeBytes: r.content.length, updatedAt: r.updatedAt, version: r.version,
    }));
    const baseList = [...this.base.values()];
    return {
      local: { files: localFiles, folders: new Set<string>() },
      remote: {
        filesByPath: new Map(remoteList.map((r) => [r.relPath, r])),
        filesById: new Map(remoteList.map((r) => [r.remoteId, r])),
        foldersByPath: new Map(),
      },
      base: {
        fileByPath: (k) => baseList.find((b) => b.localPath === k),
        fileById: (id) => this.base.get(id),
        files: () => baseList,
        folderByPath: () => undefined,
        folders: () => [],
      },
    };
  }

  // ── Random history generation ───────────────────────────────────

  applyRandomEvents(rng: () => number, count: number, pool = ["f0", "f1", "f2", "f3", "f4"]): void {
    const pick = () => pool[Math.floor(rng() * pool.length)];
    for (let i = 0; i < count; i++) {
      const name = pick();
      const roll = Math.floor(rng() * 7);
      switch (roll) {
        case 0: // create or overwrite locally
          this.local.set(name, { content: `L${this.advance()}`, mtimeMs: this.tick * 1000 });
          break;
        case 1: // edit locally (only if present)
          if (this.local.has(name)) this.local.set(name, { content: `L${this.advance()}`, mtimeMs: this.tick * 1000 });
          break;
        case 2: // delete locally
          this.local.delete(name);
          break;
        case 3: { // create remotely
          const existing = [...this.remote.values()].find((r) => r.relPath === name);
          if (!existing) {
            const id = `r${this.nextId++}`;
            this.remote.set(id, { remoteId: id, relPath: name, content: `R${this.advance()}`, updatedAt: this.tick, version: 1 });
          }
          break;
        }
        case 4: { // edit remotely
          const existing = [...this.remote.values()].find((r) => r.relPath === name);
          if (existing) {
            existing.content = `R${this.advance()}`;
            existing.updatedAt = this.tick;
            existing.version++;
          }
          break;
        }
        case 5: { // delete remotely
          const existing = [...this.remote.values()].find((r) => r.relPath === name);
          if (existing) this.remote.delete(existing.remoteId);
          break;
        }
        default: { // rename remotely (exercises move-local)
          const existing = [...this.remote.values()].find((r) => r.relPath === name);
          const target = pick();
          if (existing && target !== name && ![...this.remote.values()].some((r) => r.relPath === target)) {
            existing.relPath = target;
          }
          break;
        }
      }
    }
  }

  // ── The executor ────────────────────────────────────────────────

  private fail(op: PlanOp, why: string): never {
    throw new Error(`PLANNER BUG: ${op.kind} ${JSON.stringify(op)} - ${why}`);
  }

  private baseRowFor(relPath: string): SyncFileRecord | undefined {
    return [...this.base.values()].find((b) => b.localPath === relPath);
  }

  private localMatchesBase(relPath: string, row: SyncFileRecord): boolean {
    const l = this.local.get(relPath);
    if (!l) return false;
    if (row.localMtimeMs === 0 && l.content.length === row.localSizeBytes) return true;
    return l.mtimeMs === row.localMtimeMs && l.content.length === row.localSizeBytes;
  }

  private recordBase(remoteId: string, relPath: string, content: string, updatedAt: number, version: number, mtimeMs: number): void {
    this.base.set(remoteId, {
      remoteId, remoteName: relPath, remoteFolderId: null,
      remoteSizeBytes: content.length, remoteUpdatedAt: updatedAt, remoteVersion: version,
      localPath: relPath, localSizeBytes: content.length, localMtimeMs: mtimeMs,
      syncedAt: this.tick, contentHash: content,
    });
  }

  executeOps(ops: PlanOp[]): void {
    for (const op of ops) {
      switch (op.kind) {
        case "create-remote-folder":
        case "create-local-folder":
          this.fail(op, "folder ops are out of the simulator's scope (flat namespace)");
          break;

        case "upload-new": {
          const l = this.local.get(op.relPath);
          if (!l) this.fail(op, "no local file at that path");
          // A stale base row for this path (its remote copy was deleted) is
          // replaced, not orphaned.
          const stale = this.baseRowFor(op.relPath);
          if (stale) this.base.delete(stale.remoteId);
          const id = `r${this.nextId++}`;
          const at = this.advance();
          this.remote.set(id, { remoteId: id, relPath: op.relPath, content: l.content, updatedAt: at, version: 1 });
          this.recordBase(id, op.relPath, l.content, at, 1, l.mtimeMs);
          break;
        }

        case "upload-update": {
          const l = this.local.get(op.relPath);
          if (!l) this.fail(op, "no local file at that path");
          // No base row is legal here: case 1b adopts a colliding remote file
          // by overwriting it with the local copy, which loses nothing local.
          const r = this.remote.get(op.baseRemoteId);
          if (!r) this.fail(op, "no remote file to update");
          r.content = l.content;
          r.updatedAt = this.advance();
          r.version++;
          this.recordBase(r.remoteId, op.relPath, l.content, r.updatedAt, r.version, l.mtimeMs);
          break;
        }

        case "check-content": {
          const row = this.base.get(op.baseRemoteId);
          if (!row) this.fail(op, "no base row");
          const l = this.local.get(op.relPath);
          if (!l) break; // vanished between plan and execute - benign
          if (l.content !== row.contentHash) {
            const r = this.remote.get(op.baseRemoteId);
            if (r) {
              r.content = l.content;
              r.updatedAt = this.advance();
              r.version++;
              this.recordBase(r.remoteId, op.relPath, l.content, r.updatedAt, r.version, l.mtimeMs);
            }
          } else {
            // Same bytes, new timestamp: adopt the mtime so the next scan
            // does not re-check it forever.
            row.localMtimeMs = l.mtimeMs;
          }
          break;
        }

        case "download-new": {
          const r = this.remote.get(op.remoteId);
          if (!r) this.fail(op, "no remote file");
          const mtime = this.advance() * 1000;
          this.local.set(r.relPath, { content: r.content, mtimeMs: mtime });
          const stale = this.baseRowFor(r.relPath);
          if (stale && stale.remoteId !== r.remoteId) this.base.delete(stale.remoteId);
          this.recordBase(r.remoteId, r.relPath, r.content, r.updatedAt, r.version, mtime);
          break;
        }

        case "download-update": {
          const r = this.remote.get(op.remoteId);
          if (!r) this.fail(op, "no remote file");
          const row = this.base.get(op.remoteId);
          // I1: overwriting bytes the base tree does not vouch for - whether
          // because they were edited since, or because there is no base row at
          // all (case 1b adoption) - is legal ONLY when the user chose
          // last-write-wins. Everything else must reach the user as a conflict.
          const vouchedFor = row !== undefined && this.localMatchesBase(op.relPath, row);
          if (!vouchedFor && this.local.has(op.relPath)) {
            if (this.strategy !== "last-write-wins") {
              this.fail(op, "would overwrite local bytes the base tree does not vouch for (I1)");
            }
            this.acknowledgedLosses.push(op.relPath);
          }
          const mtime = this.advance() * 1000;
          this.local.set(r.relPath, { content: r.content, mtimeMs: mtime });
          this.recordBase(r.remoteId, r.relPath, r.content, r.updatedAt, r.version, mtime);
          break;
        }

        case "delete-remote": {
          const row = this.base.get(op.remoteId);
          if (!row) this.fail(op, "no base row");
          if (this.local.has(row.localPath)) this.fail(op, "file still exists locally (I1)");
          this.remote.delete(op.remoteId);
          this.base.delete(op.remoteId);
          break;
        }

        case "delete-local": {
          const row = this.base.get(op.baseRemoteId);
          if (!row) this.fail(op, "no base row");
          if (!this.localMatchesBase(op.relPath, row)) {
            this.fail(op, "would delete locally-changed bytes (I1)");
          }
          this.local.delete(op.relPath);
          this.base.delete(op.baseRemoteId);
          break;
        }

        case "move-local": {
          const row = this.base.get(op.remoteId);
          if (!row) this.fail(op, "no base row");
          const l = this.local.get(op.fromRelPath);
          if (l) {
            this.local.delete(op.fromRelPath);
            this.local.set(op.toRelPath, l);
          }
          const r = this.remote.get(op.remoteId);
          this.recordBase(op.remoteId, op.toRelPath, r?.content ?? row.contentHash ?? "", r?.updatedAt ?? row.remoteUpdatedAt, r?.version ?? row.remoteVersion, l?.mtimeMs ?? row.localMtimeMs);
          break;
        }

        case "move-remote": {
          const row = this.base.get(op.remoteId);
          if (!row) this.fail(op, "no base row");
          const r = this.remote.get(op.remoteId);
          if (!r) this.fail(op, "no remote file to move");
          // Metadata only - asserted by never reading or writing content here.
          r.relPath = op.toRelPath;
          const l = this.local.get(op.toRelPath);
          this.recordBase(op.remoteId, op.toRelPath, r.content, r.updatedAt, r.version, l?.mtimeMs ?? row.localMtimeMs);
          break;
        }

        case "conflict":
          this.conflicts.push(op.relPath);
          break;
      }
    }
  }

  /** relPath → content, for comparing the two sides. */
  localSnapshot(): Map<string, string> {
    return new Map([...this.local].map(([k, v]) => [k, v.content]));
  }

  remoteSnapshot(): Map<string, string> {
    return new Map([...this.remote.values()].map((r) => [r.relPath, r.content]));
  }
}
