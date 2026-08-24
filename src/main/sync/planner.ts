import type { SyncFileRecord, SyncFolderRecord, SyncMode } from "./types";

/**
 * The planner: the one place that decides what sync should DO.
 *
 * Pure by construction - no filesystem, no network, no clock, no electron,
 * no mutation of its inputs. It takes three trees and returns a list of
 * operations:
 *
 *   remote (what the server has) + local (what the disk has) + base (what
 *   both sides agreed on at the last successful sync) → PlanOp[]
 *
 * Purity is the whole point: it makes the decision layer exhaustively
 * testable, which is what the property harness (planner.property.test.ts)
 * relies on to machine-check "never destroy data the base tree didn't
 * confirm". Every sync mode is a FILTER over this one output - there is no
 * second code path (the old engine had two, which is why a depth cap and an
 * EACCES report existed in one and not the other).
 *
 * Two things it deliberately cannot do, and why:
 *  - It cannot hash a file (that is I/O), so where content has to be checked
 *    it emits `check-content` and the executor resolves it into an
 *    `upload-update` or a no-op.
 *  - It cannot mint ids or timestamps (that would break determinism, which
 *    property P4 asserts), so a conflict op carries the facts and the caller
 *    stamps id/detectedAt.
 *
 * KEYS: every view is keyed by the SAME canonical relative path form - forward
 * slashes, NFC, and case-folded where the filesystem is case-insensitive. The
 * callers that build the views own that normalization (they are the I/O side);
 * the planner only compares keys it is given. Each entry still carries its
 * display path for the executors to use.
 */

// ── Views ───────────────────────────────────────────────────────────

export interface LocalFile {
  /** Display path (case/NFC preserved), relative to the pair root. */
  relPath: string;
  sizeBytes: number;
  mtimeMs: number;
  /**
   * Whole-file content hash, supplied ONLY for rename candidates - local
   * files with no base record whose size matches a base row that has gone
   * missing. Hashing is I/O, so the engine does it for that small set and
   * passes the result in; the planner stays pure.
   */
  contentHash?: string;
}

export interface RemoteFile {
  remoteId: string;
  relPath: string;
  name: string;
  folderId: string | null;
  sizeBytes: number;
  /** Server updated_at, in SECONDS (matches RemoteFileInfo.updated_at). */
  updatedAt: number;
  version: number;
}

export interface RemoteFolder {
  remoteId: string;
  relPath: string;
  name: string;
  parentId: string | null;
}

export interface LocalView {
  files: Map<string, LocalFile>;
  /** Keys of every directory found locally. */
  folders: Set<string>;
}

export interface RemoteView {
  filesByPath: Map<string, RemoteFile>;
  filesById: Map<string, RemoteFile>;
  foldersByPath: Map<string, RemoteFolder>;
}

/** Read-only window over the index (or a plain Map in tests). */
export interface BaseView {
  fileByPath(key: string): SyncFileRecord | undefined;
  fileById(remoteId: string): SyncFileRecord | undefined;
  files(): Iterable<SyncFileRecord>;
  folderByPath(key: string): SyncFolderRecord | undefined;
  folders(): Iterable<SyncFolderRecord>;
}

export interface PlanInputs {
  local: LocalView;
  /**
   * Null in push modes, which deliberately run without a snapshot fetch: the
   * planner then compares local against base only, which can only produce
   * upload/check/folder work plus the delete-remote ops push-safe filters out.
   */
  remote: RemoteView | null;
  base: BaseView;
  conflictStrategy: "last-write-wins" | "keep-both";
  /**
   * True when the local walk could not read everything (permission denied).
   * Suppresses every deletion: a file that only LOOKS absent must never cause
   * data to be removed on either side.
   */
  localScanIncomplete?: boolean;
}

// ── Operations ──────────────────────────────────────────────────────

export type PlanOp =
  | { kind: "create-remote-folder"; relPath: string }
  | { kind: "create-local-folder"; relPath: string; remoteFolderId: string }
  | { kind: "upload-new"; relPath: string; sizeBytes: number }
  /** baseRemoteId is the remote file this update targets - usually the base
   *  record's id, or the colliding remote file's id when adopting (case 1b). */
  | { kind: "upload-update"; relPath: string; sizeBytes: number; baseRemoteId: string }
  /** Same size, different mtime: the executor hashes and drops or promotes it. */
  | { kind: "check-content"; relPath: string; sizeBytes: number; baseRemoteId: string }
  | { kind: "download-new"; relPath: string; remoteId: string; sizeBytes: number }
  | { kind: "download-update"; relPath: string; remoteId: string; sizeBytes: number }
  | { kind: "delete-remote"; remoteId: string; relPath: string }
  | { kind: "delete-local"; relPath: string; baseRemoteId: string }
  | { kind: "move-local"; fromRelPath: string; toRelPath: string; remoteId: string }
  /** The same bytes at a new local path: move the server copy, send nothing. */
  | { kind: "move-remote"; fromRelPath: string; toRelPath: string; remoteId: string }
  | {
      kind: "conflict";
      relPath: string;
      remoteId: string;
      localMtimeMs: number;
      localSizeBytes: number;
      remoteUpdatedAt: number;
      remoteSizeBytes: number;
      remoteName: string;
    };

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * The single definition of "the bytes on disk are not the bytes we last
 * synced". Every path that could destroy a local file consults this, so the
 * engine has exactly one notion of "locally changed".
 */
function isLocallyChanged(base: SyncFileRecord, local: LocalFile): boolean {
  // localMtimeMs === 0 is the pre-population sentinel: state adopted from a
  // remote snapshot after a reinstall, where only the size is known. A size
  // match means the local copy IS the synced one - treating it as changed
  // would re-upload an entire tree after every reinstall.
  if (base.localMtimeMs === 0 && local.sizeBytes === base.localSizeBytes) return false;
  return local.mtimeMs !== base.localMtimeMs || local.sizeBytes !== base.localSizeBytes;
}

function isRemotelyChanged(base: SyncFileRecord, remote: RemoteFile): boolean {
  return (
    remote.updatedAt !== base.remoteUpdatedAt ||
    remote.sizeBytes !== base.remoteSizeBytes ||
    remote.version !== base.remoteVersion
  );
}

function parentOf(relPath: string): string {
  const cut = relPath.lastIndexOf("/");
  return cut === -1 ? "" : relPath.slice(0, cut);
}

function conflictOp(
  relPath: string,
  remoteId: string,
  local: LocalFile,
  remoteName: string,
  remoteUpdatedAt: number,
  remoteSizeBytes: number,
): PlanOp {
  return {
    kind: "conflict",
    relPath,
    remoteId,
    localMtimeMs: local.mtimeMs,
    localSizeBytes: local.sizeBytes,
    remoteUpdatedAt,
    remoteSizeBytes,
    remoteName,
  };
}

// ── The planner ─────────────────────────────────────────────────────

export function plan(inputs: PlanInputs): PlanOp[] {
  return inputs.remote === null ? planPushOnly(inputs) : planThreeWay(inputs);
}

/**
 * Push modes without a remote snapshot: local vs base only.
 *
 * Per-window planning is exactly as correct as whole-tree planning here,
 * because every decision depends only on one (local entry, base entry) pair -
 * there is no cross-file coupling to lose by planning 5,000 files at a time.
 */
function planPushOnly(inputs: PlanInputs): PlanOp[] {
  const { local, base } = inputs;
  const ops: PlanOp[] = [];

  for (const key of local.folders) {
    if (!base.folderByPath(key)) ops.push({ kind: "create-remote-folder", relPath: key });
  }

  // Rename detection. A local file with no base record, carrying a hash that
  // matches a base row whose own path is gone, is the SAME bytes at a new
  // path - so move the server copy instead of uploading it again. Matching
  // only ever happens inside a group of identical (size, hash), which is why
  // the lexicographic pairing below is a deterministic tiebreak rather than a
  // correctness decision: any pairing produces the same final tree, and a
  // "wrong" one costs transfer, never data.
  const movedFrom = new Set<string>();
  const renameTargets = new Map<string, SyncFileRecord>();
  for (const [key, file] of local.files) {
    if (!file.contentHash || base.fileByPath(key)) continue;
    const candidates: SyncFileRecord[] = [];
    for (const stored of base.files()) {
      if (stored.contentHash !== file.contentHash) continue;
      if (stored.localSizeBytes !== file.sizeBytes) continue;
      if (movedFrom.has(stored.remoteId)) continue;
      if (local.files.has(stored.localPath)) continue; // its old path still exists - a copy, not a move
      candidates.push(stored);
    }
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => (a.localPath < b.localPath ? -1 : a.localPath > b.localPath ? 1 : 0));
    const match = candidates[0];
    movedFrom.add(match.remoteId);
    renameTargets.set(key, match);
    ops.push({ kind: "move-remote", fromRelPath: match.localPath, toRelPath: file.relPath, remoteId: match.remoteId });
  }

  for (const [key, file] of local.files) {
    if (renameTargets.has(key)) continue; // handled as a move
    const stored = base.fileByPath(key);
    if (!stored) {
      ops.push({ kind: "upload-new", relPath: file.relPath, sizeBytes: file.sizeBytes });
      continue;
    }
    if (file.sizeBytes !== stored.localSizeBytes) {
      ops.push({ kind: "upload-update", relPath: file.relPath, sizeBytes: file.sizeBytes, baseRemoteId: stored.remoteId });
      continue;
    }
    if (isLocallyChanged(stored, file)) {
      // Same size, different mtime - could be a real edit or just a touched
      // timestamp. Only the content hash can tell, and that is I/O.
      ops.push({ kind: "check-content", relPath: file.relPath, sizeBytes: file.sizeBytes, baseRemoteId: stored.remoteId });
    }
  }

  // Tracked files that are gone locally. Planned even in push-safe (where the
  // mode filter drops them) so the filter itself stays testable.
  if (!inputs.localScanIncomplete) {
    for (const stored of base.files()) {
      if (movedFrom.has(stored.remoteId)) continue; // its bytes live on at a new path
      if (!local.files.has(keyOfBaseRecord(stored, local))) {
        ops.push({ kind: "delete-remote", remoteId: stored.remoteId, relPath: stored.localPath });
      }
    }
  }

  return ops;
}

/**
 * A base record's key in the local view. The views are pre-normalized by
 * their builders, and base records store the display path, so this looks the
 * record up the same way the builder keyed it: exact match first, then a
 * case-folded fallback for the case-insensitive filesystems where the two can
 * differ.
 */
function keyOfBaseRecord(stored: SyncFileRecord, local: LocalView): string {
  if (local.files.has(stored.localPath)) return stored.localPath;
  const folded = stored.localPath.normalize("NFC").toLowerCase();
  return local.files.has(folded) ? folded : stored.localPath;
}

/** Full three-way reconciliation (two-way and pull modes). */
function planThreeWay(inputs: PlanInputs): PlanOp[] {
  const { local, base, conflictStrategy } = inputs;
  const remote = inputs.remote!;
  const ops: PlanOp[] = [];
  const suppressDeletes = inputs.localScanIncomplete === true;

  // ── Folders ──
  for (const [key, folder] of remote.foldersByPath) {
    if (!local.folders.has(key)) {
      ops.push({ kind: "create-local-folder", relPath: folder.relPath, remoteFolderId: folder.remoteId });
    }
  }
  for (const key of local.folders) {
    if (!remote.foldersByPath.has(key) && !base.folderByPath(key)) {
      ops.push({ kind: "create-remote-folder", relPath: key });
    }
  }

  // ── Files, keyed by remote id ∪ base ids ──
  const ids = new Set<string>();
  for (const id of remote.filesById.keys()) ids.add(id);
  for (const stored of base.files()) ids.add(stored.remoteId);

  const handledKeys = new Set<string>();

  for (const remoteId of ids) {
    const remoteFile = remote.filesById.get(remoteId);
    const stored = base.fileById(remoteId);
    const key = remoteFile ? remoteFile.relPath : stored?.localPath;
    if (!key) continue;
    const localFile = local.files.get(key) ?? (stored ? local.files.get(keyOfBaseRecord(stored, local)) : undefined);
    if (localFile) handledKeys.add(key);
    if (stored) handledKeys.add(keyOfBaseRecord(stored, local));

    // 1. Remote only → download it.
    if (remoteFile && !stored && !localFile) {
      ops.push({ kind: "download-new", relPath: remoteFile.relPath, remoteId, sizeBytes: remoteFile.sizeBytes });
      continue;
    }

    // 1b. Present on BOTH sides with no shared history. There is no common
    // ancestor to diff against, so nothing can prove which copy is "right".
    // Found by the property harness (seed 3): the old reconciler had no case
    // for this and silently emitted nothing, so the two copies stayed
    // different forever - the user saw one file on the desktop and another on
    // the web, with sync reporting success. It happens whenever the same path
    // is created independently on both sides, and after any event that loses
    // the base tree (a failed state migration, a reinstall).
    if (remoteFile && !stored && localFile) {
      if (conflictStrategy === "last-write-wins") {
        if (remoteFile.updatedAt > localFile.mtimeMs / 1000) {
          ops.push({ kind: "download-update", relPath: remoteFile.relPath, remoteId, sizeBytes: remoteFile.sizeBytes });
        } else {
          ops.push({ kind: "upload-update", relPath: localFile.relPath, sizeBytes: localFile.sizeBytes, baseRemoteId: remoteId });
        }
      } else {
        // keep-both refuses to pick for the user: surface it and touch nothing.
        ops.push(conflictOp(localFile.relPath, remoteId, localFile, remoteFile.name, remoteFile.updatedAt, remoteFile.sizeBytes));
      }
      continue;
    }

    // 2. Local only (with no base record) → upload it.
    if (!remoteFile && !stored && localFile) {
      ops.push({ kind: "upload-new", relPath: localFile.relPath, sizeBytes: localFile.sizeBytes });
      continue;
    }

    // 3. Deleted locally, still on the server.
    if (remoteFile && stored && !localFile) {
      if (isRemotelyChanged(stored, remoteFile)) {
        // The server copy moved on since we last synced, so the local
        // deletion is not the whole story - take the newer bytes rather than
        // destroying them.
        ops.push({ kind: "download-new", relPath: remoteFile.relPath, remoteId, sizeBytes: remoteFile.sizeBytes });
      } else if (!suppressDeletes) {
        ops.push({ kind: "delete-remote", remoteId, relPath: stored.localPath });
      }
      continue;
    }

    // 4. Deleted on the server, still local.
    if (!remoteFile && stored && localFile) {
      if (isLocallyChanged(stored, localFile)) {
        const parentKey = parentOf(localFile.relPath);
        const parentGone = parentKey !== "" && !remote.foldersByPath.has(parentKey);
        if (parentGone) {
          // The file AND its folder both vanished from the snapshot. That is
          // also what the server does when access is withdrawn, and it is
          // indistinguishable from a real deletion - re-uploading would
          // recreate the file stripped of whatever protection removed it.
          // Raise it instead of writing to either side.
          ops.push(conflictOp(localFile.relPath, stored.remoteId, localFile, stored.remoteName, stored.remoteUpdatedAt, stored.remoteSizeBytes));
        } else {
          ops.push({ kind: "upload-new", relPath: localFile.relPath, sizeBytes: localFile.sizeBytes });
        }
      } else if (!suppressDeletes) {
        ops.push({ kind: "delete-local", relPath: stored.localPath, baseRemoteId: stored.remoteId });
      }
      continue;
    }

    // 4.5. Same file, new remote path → mirror the move locally.
    if (remoteFile && stored && stored.localPath !== remoteFile.relPath) {
      ops.push({ kind: "move-local", fromRelPath: stored.localPath, toRelPath: remoteFile.relPath, remoteId });
      continue;
    }

    // 5. Present everywhere → compare both sides against the base.
    if (remoteFile && stored && localFile) {
      const remoteChanged = isRemotelyChanged(stored, remoteFile);
      const localChanged = isLocallyChanged(stored, localFile);
      if (!remoteChanged && !localChanged) continue;

      if (remoteChanged && !localChanged) {
        ops.push({ kind: "download-update", relPath: remoteFile.relPath, remoteId, sizeBytes: remoteFile.sizeBytes });
      } else if (!remoteChanged && localChanged) {
        ops.push({ kind: "upload-update", relPath: localFile.relPath, sizeBytes: localFile.sizeBytes, baseRemoteId: stored.remoteId });
      } else if (conflictStrategy === "last-write-wins") {
        // updatedAt is seconds, mtimeMs is milliseconds.
        if (remoteFile.updatedAt > localFile.mtimeMs / 1000) {
          ops.push({ kind: "download-update", relPath: remoteFile.relPath, remoteId, sizeBytes: remoteFile.sizeBytes });
        } else {
          ops.push({ kind: "upload-update", relPath: localFile.relPath, sizeBytes: localFile.sizeBytes, baseRemoteId: stored.remoteId });
        }
      } else {
        ops.push(conflictOp(localFile.relPath, remoteId, localFile, remoteFile.name, remoteFile.updatedAt, remoteFile.sizeBytes));
      }
      continue;
    }

    // 6. Gone from both sides: nothing to do. The caller prunes the record.
  }

  // Brand-new local files have neither a remote id nor a base record, so the
  // id-keyed loop above never visits them.
  for (const [key, file] of local.files) {
    if (handledKeys.has(key)) continue;
    if (remote.filesByPath.has(key) || base.fileByPath(key)) continue;
    ops.push({ kind: "upload-new", relPath: file.relPath, sizeBytes: file.sizeBytes });
  }

  return ops;
}

// ── Mode filters ────────────────────────────────────────────────────

const UPLOAD_KINDS = new Set(["upload-new", "upload-update", "check-content", "create-remote-folder", "move-remote"]);
const DOWNLOAD_KINDS = new Set(["download-new", "download-update", "create-local-folder", "move-local"]);

/**
 * Sync modes are filters over one plan, not separate code paths.
 *
 *   two-way    everything
 *   push       uploads + remote deletions
 *   push-safe  uploads only, never deletes on the server
 *   pull       downloads + local deletions
 *   pull-safe  downloads only, never deletes locally
 *
 * One-directional modes keep `conflict` ops: they never resolve a conflict by
 * destroying something, but the user still needs to be told.
 */
export function filterOpsForMode(ops: PlanOp[], mode: SyncMode): PlanOp[] {
  if (mode === "two-way") return ops;
  return ops.filter((op) => {
    if (op.kind === "conflict") return true;
    switch (mode) {
      case "push":
        return UPLOAD_KINDS.has(op.kind) || op.kind === "delete-remote";
      case "push-safe":
        return UPLOAD_KINDS.has(op.kind);
      case "pull":
        return DOWNLOAD_KINDS.has(op.kind) || op.kind === "delete-local";
      case "pull-safe":
        return DOWNLOAD_KINDS.has(op.kind);
      default:
        return true;
    }
  });
}
