import { join } from "path";
import { readdir, stat } from "fs/promises";
import { shouldIgnoreEntry } from "./local-watcher";
import { toRelPath, normalizeRel, longPath } from "./paths";
import type {
  SyncPairState,
  SyncFileRecord,
  SyncFolderRecord,
  SyncAction,
  SyncConflict,
  RemoteFileInfo,
  RemoteFolderInfo,
  LocalFileStat,
  SyncPair,
} from "./types";
import type { RemoteSnapshot } from "./remote-poller";

function genId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const MAX_FOLDER_DEPTH = 50;

/**
 * The single definition of "the bytes on disk are no longer the bytes we last
 * synced". Every path that can destroy a local file routes through this, so
 * there is exactly one notion of "locally changed" in the engine: reconcile()
 * case 4 (remote gone, file on disk), reconcile() case 5 (present on both
 * sides) and reconcileRemoteOnly()'s delete guard.
 *
 * Note what it does NOT do: adopt the localMtimeMs === 0 pre-population
 * sentinel. That adoption is case 5's, and it stays there - it needs the
 * remote record to prove the local copy is the synced one, which is exactly
 * what the delete paths do not have.
 */
function isLocallyChanged(stored: SyncFileRecord, localStat: LocalFileStat): boolean {
  return (
    localStat.mtimeMs !== stored.localMtimeMs ||
    localStat.sizeBytes !== stored.localSizeBytes
  );
}

/**
 * Build a map of local files: relative path → stat.
 * Always uses forward slashes in paths regardless of OS.
 * Uses the shared shouldIgnoreEntry() filter so the scanner and watcher
 * have identical ignore semantics.
 */
const STAT_BATCH_SIZE = 50;
const YIELD_INTERVAL = 20; // yield every 20 batches (1000 files) to keep UI responsive

/** Reports scan progress so the two-way path isn't a silent black box. */
export type ScanProgress = (scannedFiles: number, scannedFolders: number) => void;

/**
 * Hard ceiling on a single file. Above this the upload cannot be expressed as
 * a multipart request (R2 caps a multipart upload at 10,000 parts), so the
 * scanner leaves the file out entirely rather than queueing work that must
 * fail. Skipped files are reported back to the caller - they used to vanish
 * from the sync set with no error and no message, so a user could believe a
 * disk image was backed up when it never was.
 */
const MAX_SYNCABLE_BYTES = 100 * 1024 * 1024 * 1024;

async function scanLocal(
  rootPath: string,
  userPatterns?: string[],
  onProgress?: ScanProgress,
): Promise<{ files: Map<string, LocalFileStat>; dirs: Set<string>; incomplete: boolean; skippedTooLarge: string[] }> {
  const files = new Map<string, LocalFileStat>();
  const dirs = new Set<string>();
  const skippedTooLarge: string[] = [];
  let yieldCounter = 0;
  // True if ANY directory failed to read. When set, the reconciler must NOT
  // treat locally-absent files as deletions - they may just be unreadable
  // (drive spun down, permission flip, AV lock), and deleting them from the
  // cloud would be catastrophic data loss for a backup.
  let incomplete = false;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_FOLDER_DEPTH) { incomplete = true; return; }

    let entries;
    try {
      entries = await readdir(longPath(dir), { withFileTypes: true });
    } catch {
      incomplete = true;
      return;
    }

    // Collect file entries for batch stat
    const fileEntries: { fullPath: string; relPath: string }[] = [];

    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (shouldIgnoreEntry(entry.name, entry.isDirectory(), userPatterns, fullPath)) continue;

      const relPath = toRelPath(rootPath, fullPath);

      if (entry.isDirectory()) {
        dirs.add(relPath);
        // Yield periodically to keep event loop responsive
        if (++yieldCounter % YIELD_INTERVAL === 0) {
          onProgress?.(files.size, dirs.size);
          await new Promise<void>(r => setImmediate(r));
        }
        await walk(fullPath, depth + 1);
      } else if (entry.isFile()) {
        fileEntries.push({ fullPath, relPath });
      }
    }

    // Stat files in parallel batches instead of one-at-a-time
    for (let i = 0; i < fileEntries.length; i += STAT_BATCH_SIZE) {
      const batch = fileEntries.slice(i, i + STAT_BATCH_SIZE);
      const stats = await Promise.all(
        batch.map(f => stat(longPath(f.fullPath)).catch(() => null)),
      );
      for (let j = 0; j < batch.length; j++) {
        const s = stats[j];
        if (!s || !s.isFile()) continue;
        if (s.size > MAX_SYNCABLE_BYTES) {
          skippedTooLarge.push(batch[j].relPath);
          continue;
        }
        files.set(batch[j].relPath, {
          sizeBytes: s.size,
          mtimeMs: s.mtimeMs,
          isDirectory: false,
        });
      }
      if (++yieldCounter % YIELD_INTERVAL === 0) {
        onProgress?.(files.size, dirs.size);
        await new Promise<void>(r => setImmediate(r));
      }
    }
  }

  await walk(rootPath, 0);
  onProgress?.(files.size, dirs.size);
  return { files, dirs, incomplete, skippedTooLarge };
}

/**
 * Build path maps from remote snapshot using the folder tree.
 * Includes cycle detection via visited set.
 */
function buildRemotePaths(
  remoteFiles: Map<string, RemoteFileInfo>,
  remoteFolders: Map<string, RemoteFolderInfo>,
  rootFolderId: string | null,
): {
  filePathMap: Map<string, string>;
  folderPathMap: Map<string, string>;
} {
  const folderPathMap = new Map<string, string>();
  const building = new Set<string>(); // cycle detection

  function folderPath(folderId: string): string {
    if (folderPathMap.has(folderId)) return folderPathMap.get(folderId)!;
    if (building.has(folderId)) return ""; // cycle detected
    building.add(folderId);

    const folder = remoteFolders.get(folderId);
    if (!folder) return "";
    const name = normalizeRel(folder.name);
    const parentId = folder.parent_id;
    if (!parentId || parentId === rootFolderId) {
      folderPathMap.set(folderId, name);
      return name;
    }
    const parentPath = folderPath(parentId);
    const p = parentPath ? `${parentPath}/${name}` : name;
    folderPathMap.set(folderId, p);
    return p;
  }

  for (const [id] of remoteFolders) {
    folderPath(id);
  }

  const filePathMap = new Map<string, string>();
  for (const [id, file] of remoteFiles) {
    const folderId = file.folder_id;
    const name = normalizeRel(file.name);
    if (!folderId || folderId === rootFolderId) {
      filePathMap.set(id, name);
    } else {
      const fp = folderPathMap.get(folderId);
      filePathMap.set(id, fp ? `${fp}/${name}` : name);
    }
  }

  return { filePathMap, folderPathMap };
}

/**
 * Three-way diff: compare stored state, remote snapshot, and local filesystem.
 */
export async function reconcile(
  pair: SyncPair,
  storedState: SyncPairState,
  remote: RemoteSnapshot,
  onScanProgress?: ScanProgress,
  /** Relative paths left out because they exceed MAX_SYNCABLE_BYTES. Reported
   *  so the engine can tell the user, rather than skipping them in silence. */
  onSkippedTooLarge?: (relPaths: string[]) => void,
): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];
  const { files: localFiles, dirs: localDirs, incomplete: localScanIncomplete, skippedTooLarge } = await scanLocal(pair.localPath, pair.excludedPatterns, onScanProgress);
  if (skippedTooLarge.length > 0) onSkippedTooLarge?.(skippedTooLarge);
  const { filePathMap, folderPathMap } = buildRemotePaths(
    remote.files,
    remote.folders,
    pair.remoteFolderId,
  );

  // Build reverse maps: relative path → remoteId
  const pathToRemoteFile = new Map<string, string>();
  for (const [id, path] of filePathMap) {
    pathToRemoteFile.set(path, id);
  }
  const pathToRemoteFolder = new Map<string, string>();
  for (const [id, path] of folderPathMap) {
    pathToRemoteFolder.set(path, id);
  }

  // Reverse index for stored state: localPath → remoteId (avoids O(n) finds)
  const storedPathToId = new Map<string, string>();
  for (const [id, record] of Object.entries(storedState.files)) {
    storedPathToId.set(record.localPath, id);
  }
  const storedFolderPaths = new Set<string>();
  for (const record of Object.values(storedState.folders)) {
    storedFolderPaths.add(record.localPath);
  }

  // ── Folder reconciliation ──────────────────────────────────────

  // New remote folders → create locally
  for (const [folderId] of remote.folders) {
    const relPath = folderPathMap.get(folderId);
    if (!relPath) continue;
    if (!localDirs.has(relPath) && !storedState.folders[folderId]) {
      actions.push({
        type: "create-local-folder",
        remoteFolderId: folderId,
        localDir: pair.localPath,
        name: relPath,
      });
    }
  }

  // New local folders → create remotely
  for (const relPath of localDirs) {
    if (!pathToRemoteFolder.has(relPath)) {
      if (!storedFolderPaths.has(relPath)) {
        const parts = relPath.split("/");
        const parentRelPath = parts.slice(0, -1).join("/");
        const parentRemoteId = parentRelPath ? (pathToRemoteFolder.get(parentRelPath) ?? pair.remoteFolderId) : pair.remoteFolderId;
        actions.push({
          type: "create-remote-folder",
          localPath: join(pair.localPath, relPath),
          parentRemoteId: parentRemoteId,
          name: parts[parts.length - 1],
        });
      }
    }
  }

  // ── File reconciliation (three-way) ────────────────────────────

  const allFileIds = new Set([
    ...remote.files.keys(),
    ...Object.keys(storedState.files),
  ]);

  // Also check local-only files (O(1) via reverse index instead of O(n) find)
  for (const [relPath] of localFiles) {
    if (!pathToRemoteFile.has(relPath)) {
      const storedId = storedPathToId.get(relPath);
      const storedByPath = storedId ? storedState.files[storedId] : undefined;
      if (storedByPath) {
        allFileIds.add(storedByPath.remoteId);
      }
    }
  }

  // Track which stored IDs we've processed, so we can clean up stale ones
  const processedIds = new Set<string>();
  let reconcileCount = 0;

  for (const remoteId of allFileIds) {
    // Yield to event loop every 500 entries to prevent UI freeze on large trees
    if (++reconcileCount % 500 === 0) {
      await new Promise<void>(r => setImmediate(r));
    }
    processedIds.add(remoteId);
    const remoteFile = remote.files.get(remoteId);
    const stored = storedState.files[remoteId];
    const relPath = remoteFile ? filePathMap.get(remoteId) : stored?.localPath;
    const localStat = relPath ? localFiles.get(relPath) : undefined;

    // Case 1: In remote, NOT stored, NOT local → download-new
    if (remoteFile && !stored && !localStat) {
      const dir = remoteFile.folder_id
        ? folderPathMap.get(remoteFile.folder_id) ?? ""
        : "";
      actions.push({
        type: "download-new",
        remoteFile,
        localDir: dir ? join(pair.localPath, dir) : pair.localPath,
      });
      continue;
    }

    // Case 2: NOT remote, NOT stored, In local → upload-new
    if (!remoteFile && !stored && localStat && relPath) {
      const parts = relPath.split("/");
      const dirPath = parts.slice(0, -1).join("/");
      const remoteFolderId = dirPath ? (pathToRemoteFolder.get(dirPath) ?? pair.remoteFolderId) : pair.remoteFolderId;
      actions.push({
        type: "upload-new",
        localPath: join(pair.localPath, relPath),
        remoteFolderId,
        stat: localStat,
        fileName: parts[parts.length - 1],
      });
      continue;
    }

    // Case 3: In remote, In stored, NOT local → locally deleted
    if (remoteFile && stored && !localStat) {
      const remoteChanged =
        remoteFile.updated_at !== stored.remoteUpdatedAt ||
        remoteFile.size_bytes !== stored.remoteSizeBytes ||
        remoteFile.current_version !== stored.remoteVersion;
      if (remoteChanged) {
        const dir = remoteFile.folder_id
          ? folderPathMap.get(remoteFile.folder_id) ?? ""
          : "";
        actions.push({
          type: "download-new",
          remoteFile,
          localDir: dir ? join(pair.localPath, dir) : pair.localPath,
        });
      } else {
        actions.push({ type: "delete-remote", remoteId, record: stored });
      }
      continue;
    }

    // Case 4: NOT remote, In stored, In local → remotely deleted
    if (!remoteFile && stored && localStat && relPath) {
      const localChanged = isLocallyChanged(stored, localStat);
      if (localChanged) {
        const parts = relPath.split("/");
        const dirPath = parts.slice(0, -1).join("/");
        // undefined here means exactly one thing: the file sat in a subfolder,
        // and that subfolder is no longer in the snapshot either.
        const remoteFolderId = dirPath ? pathToRemoteFolder.get(dirPath) : pair.remoteFolderId;
        if (remoteFolderId === undefined) {
          // The file AND its folder both vanished from the snapshot. That is
          // what the server does when access is withdrawn - a hidden,
          // permission-restricted or locked subtree simply stops being listed -
          // and it is indistinguishable from a real remote deletion. Uploading
          // would re-create the file at the sync root as a brand-new, unhidden,
          // unlocked object: the protections that removed it, stripped off.
          // Raise a conflict instead. Nothing is written on either side, the
          // local edit is left untouched, and the user picks: keep-remote drops
          // the local copy, keep-local/keep-both re-uploads it deliberately.
          actions.push({
            type: "conflict",
            conflict: {
              id: genId(),
              pairId: pair.id,
              localPath: join(pair.localPath, relPath),
              remoteName: stored.remoteName,
              remoteId: stored.remoteId,
              localMtimeMs: localStat.mtimeMs,
              remoteUpdatedAt: stored.remoteUpdatedAt,
              localSizeBytes: localStat.sizeBytes,
              remoteSizeBytes: stored.remoteSizeBytes,
              detectedAt: Date.now(),
            },
          });
        } else {
          actions.push({
            type: "upload-new",
            localPath: join(pair.localPath, relPath),
            remoteFolderId,
            stat: localStat,
            fileName: parts[parts.length - 1],
          });
        }
      } else {
        actions.push({
          type: "delete-local",
          localPath: join(pair.localPath, relPath),
          record: stored,
        });
      }
      continue;
    }

    // Case 4.5: Remote file moved (different path from stored)
    // Detect by comparing remote relPath vs stored localPath. If they differ
    // but the remoteId is the same, the file was moved/renamed on the server.
    if (remoteFile && stored && relPath && stored.localPath !== relPath) {
      const oldAbsPath = join(pair.localPath, stored.localPath);
      const newAbsPath = join(pair.localPath, relPath);
      actions.push({
        type: "move-local",
        oldLocalPath: oldAbsPath,
        newLocalPath: newAbsPath,
        remoteFile,
        record: stored,
      });
      continue;
    }

    // Case 5: In remote, In stored, In local → check for changes
    if (remoteFile && stored && localStat && relPath) {
      const remoteChanged =
        remoteFile.updated_at !== stored.remoteUpdatedAt ||
        remoteFile.size_bytes !== stored.remoteSizeBytes ||
        remoteFile.current_version !== stored.remoteVersion;

      // Pre-populated from a remote snapshot (reinstall): localMtimeMs === 0 is
      // a "match by size on next scan" sentinel. When the size matches, the
      // local file is byte-identical to what we recorded, so adopt its real
      // mtime into state and treat it as unchanged - otherwise every already-
      // identical file gets a spurious upload-update. Mirrors the same handling
      // in the engine's scanAndUpload.
      if (stored.localMtimeMs === 0 && localStat.sizeBytes === stored.localSizeBytes) {
        stored.localMtimeMs = localStat.mtimeMs;
      }

      const localChanged = isLocallyChanged(stored, localStat);

      if (!remoteChanged && !localChanged) continue;

      if (remoteChanged && !localChanged) {
        actions.push({
          type: "download-update",
          remoteFile,
          localPath: join(pair.localPath, relPath),
          existingRecord: stored,
        });
      } else if (!remoteChanged && localChanged) {
        actions.push({
          type: "upload-update",
          localPath: join(pair.localPath, relPath),
          existingRecord: stored,
          stat: localStat,
        });
      } else {
        // Both changed → conflict
        if (pair.conflictStrategy === "last-write-wins") {
          const remoteTime = remoteFile.updated_at;
          const localTime = localStat.mtimeMs / 1000;
          if (remoteTime > localTime) {
            actions.push({
              type: "download-update",
              remoteFile,
              localPath: join(pair.localPath, relPath),
              existingRecord: stored,
            });
          } else {
            actions.push({
              type: "upload-update",
              localPath: join(pair.localPath, relPath),
              existingRecord: stored,
              stat: localStat,
            });
          }
        } else {
          actions.push({
            type: "conflict",
            conflict: {
              id: genId(),
              pairId: pair.id,
              localPath: join(pair.localPath, relPath),
              remoteName: remoteFile.name,
              remoteId: remoteFile.id,
              localMtimeMs: localStat.mtimeMs,
              remoteUpdatedAt: remoteFile.updated_at,
              localSizeBytes: localStat.sizeBytes,
              remoteSizeBytes: remoteFile.size_bytes,
              detectedAt: Date.now(),
            },
          });
        }
      }
      continue;
    }

    // Case 6: NOT remote, In stored, NOT local → both deleted, clean up state
    // (no action needed - will be cleaned below)
  }

  // ── Brand-new local files (no remote id, no stored record) ─────────
  // The id-based loop above is keyed on remote ids ∪ stored records, so a
  // genuinely new local file - one with neither a remote id nor a stored
  // record - is never visited and the upload-new branch (Case 2) never fires
  // for it. Walk localFiles directly to catch these and queue them for upload.
  // Paths already covered by the loop (present in pathToRemoteFile or
  // storedPathToId) are skipped, so nothing is double-processed.
  let newLocalCount = 0;
  for (const [relPath, localStat] of localFiles) {
    // Yield to the event loop periodically, same as the main loop.
    if (++newLocalCount % 500 === 0) {
      await new Promise<void>(r => setImmediate(r));
    }
    if (pathToRemoteFile.has(relPath) || storedPathToId.has(relPath)) continue;
    const parts = relPath.split("/");
    const dirPath = parts.slice(0, -1).join("/");
    const remoteFolderId = dirPath ? (pathToRemoteFolder.get(dirPath) ?? pair.remoteFolderId) : pair.remoteFolderId;
    actions.push({
      type: "upload-new",
      localPath: join(pair.localPath, relPath),
      remoteFolderId,
      stat: localStat,
      fileName: parts[parts.length - 1],
    });
  }

  // Clean up stale records: files that exist in stored state but are gone from both
  // remote and local (Case 6). Skip when the local scan was incomplete - a file
  // that only *looks* absent this pass must not have its tracking dropped.
  if (!localScanIncomplete) {
    for (const id of Object.keys(storedState.files)) {
      if (!processedIds.has(id)) continue;
      const stored = storedState.files[id];
      const remoteFile = remote.files.get(id);
      const localStat = stored.localPath ? localFiles.get(stored.localPath) : undefined;
      if (!remoteFile && !localStat) {
        delete storedState.files[id];
      }
    }
  }

  // ── Deletion safety valve ──────────────────────────────────────────
  // Deleting user data (local files or cloud files) is the one irreversible
  // thing this engine does. Guard it: if the local scan failed to read some
  // directories, or if the number of deletions is an implausibly large share
  // of tracked files (symptom of a transient partial scan or an incomplete
  // remote snapshot), suppress ALL deletions this cycle. They will be applied
  // on a later, healthy pass. Mirrors the pull-path guard in the engine.
  const deleteCount = actions.reduce(
    (n, a) => n + (a.type === "delete-local" || a.type === "delete-remote" ? 1 : 0),
    0,
  );
  if (deleteCount > 0) {
    const storedCount = Object.keys(storedState.files).length;
    const massDelete = storedCount > 10 && deleteCount > 5 && deleteCount > storedCount * 0.5;
    if (localScanIncomplete || massDelete) {
      const reason = localScanIncomplete
        ? "local scan was incomplete (a directory could not be read)"
        : `${deleteCount}/${storedCount} deletions exceeds the safety threshold`;
      console.warn(`[sync] Suppressing ${deleteCount} deletion(s) this cycle - ${reason}. Will retry when healthy.`);
      return actions.filter((a) => a.type !== "delete-local" && a.type !== "delete-remote");
    }
  }

  return actions;
}

/**
 * Lightweight remote-only reconcile - no local filesystem scan.
 * Only detects remote changes (new, updated, deleted files) by comparing
 * the remote snapshot against stored state. Used when the watcher reports
 * no local changes since the last full reconcile.
 *
 * This saves 15+ seconds of I/O per poll cycle on large file trees (150K files).
 *
 * "No local scan" means no WALK. It does still stat the handful of files it is
 * about to delete - see the deletion block below for why that is not optional.
 */
export async function reconcileRemoteOnly(
  pair: SyncPair,
  storedState: SyncPairState,
  remote: RemoteSnapshot,
): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];
  const { filePathMap, folderPathMap } = buildRemotePaths(
    remote.files, remote.folders, pair.remoteFolderId,
  );

  // New remote folders → create locally
  for (const [folderId] of remote.folders) {
    const relPath = folderPathMap.get(folderId);
    if (!relPath) continue;
    if (!storedState.folders[folderId]) {
      actions.push({ type: "create-local-folder", remoteFolderId: folderId, localDir: pair.localPath, name: relPath });
    }
  }

  // Check each remote file against stored state
  for (const [remoteId, remoteFile] of remote.files) {
    const stored = storedState.files[remoteId];
    const relPath = filePathMap.get(remoteId);

    if (!stored) {
      // New remote file → download
      const dir = remoteFile.folder_id ? folderPathMap.get(remoteFile.folder_id) ?? "" : "";
      actions.push({
        type: "download-new", remoteFile,
        localDir: dir ? join(pair.localPath, dir) : pair.localPath,
      });
    } else if (relPath && stored.localPath !== relPath) {
      // Remote file moved → move locally
      actions.push({
        type: "move-local",
        oldLocalPath: join(pair.localPath, stored.localPath),
        newLocalPath: join(pair.localPath, relPath),
        remoteFile, record: stored,
      });
    } else if (
      remoteFile.updated_at !== stored.remoteUpdatedAt ||
      remoteFile.size_bytes !== stored.remoteSizeBytes ||
      remoteFile.current_version !== stored.remoteVersion
    ) {
      // Remote file changed → download update
      actions.push({
        type: "download-update", remoteFile,
        localPath: join(pair.localPath, stored.localPath),
        existingRecord: stored,
      });
    }
  }

  // ── Remote deletions ───────────────────────────────────────────────
  // A stored id missing from the snapshot means the remote copy is gone. That
  // is one observation with two causes we cannot tell apart: the file really
  // was deleted, or access to it was withdrawn (hidden, permission-restricted
  // or locked subtrees simply stop being listed).
  //
  // This block used to emit delete-local for every one of them and the
  // executor unlinks unconditionally, so a file the user had edited since the
  // last sync was destroyed without a single comparison - and the edit existed
  // nowhere else, because the upload that would have preserved it is exactly
  // what the missing remote record suppresses. So stat the delete candidates
  // (ONLY those - the walk is still skipped, which is what makes this the fast
  // path) and apply reconcile()'s case-4 rule: same situation, same rule. A
  // file that still matches its record is safe to remove; one that does not
  // stays on disk and becomes a conflict for the user to resolve.
  const deleteCandidates: SyncFileRecord[] = [];
  for (const [id, stored] of Object.entries(storedState.files)) {
    if (!remote.files.has(id)) deleteCandidates.push(stored);
  }

  let deleteCount = 0;
  const guardConflictIds = new Set<string>();
  for (let i = 0; i < deleteCandidates.length; i += STAT_BATCH_SIZE) {
    const batch = deleteCandidates.slice(i, i + STAT_BATCH_SIZE);
    const stats = await Promise.all(
      batch.map((stored) =>
        stat(longPath(join(pair.localPath, stored.localPath))).then(
          (s) => ({ stat: s, err: null as NodeJS.ErrnoException | null }),
          (err: NodeJS.ErrnoException) => ({ stat: null, err }),
        ),
      ),
    );

    for (let j = 0; j < batch.length; j++) {
      const stored = batch[j];
      const absPath = join(pair.localPath, stored.localPath);
      const { stat: s, err } = stats[j];

      if (!s) {
        if (err?.code === "ENOENT") {
          // Already gone from disk. The delete unlinks nothing and only drops
          // the tracking record, which is what we want.
          actions.push({ type: "delete-local", localPath: absPath, record: stored });
          deleteCount++;
        } else {
          // Unreadable is NOT absent (drive spun down, permission flip, AV
          // lock). Same fail-safe the full scan takes with an unreadable
          // directory: change nothing, retry on a healthy pass.
          console.warn(`[sync] Skipping local delete of ${stored.localPath} - cannot stat it (${err?.code ?? "unknown error"}). Will retry.`);
        }
        continue;
      }

      if (!s.isFile()) {
        console.warn(`[sync] Skipping local delete of ${stored.localPath} - it is no longer a regular file.`);
        continue;
      }

      const localStat: LocalFileStat = { sizeBytes: s.size, mtimeMs: s.mtimeMs, isDirectory: false };
      if (isLocallyChanged(stored, localStat)) {
        const conflict: SyncConflict = {
          id: genId(),
          pairId: pair.id,
          localPath: absPath,
          remoteName: stored.remoteName,
          remoteId: stored.remoteId,
          localMtimeMs: localStat.mtimeMs,
          remoteUpdatedAt: stored.remoteUpdatedAt,
          localSizeBytes: localStat.sizeBytes,
          remoteSizeBytes: stored.remoteSizeBytes,
          detectedAt: Date.now(),
        };
        guardConflictIds.add(conflict.id);
        actions.push({ type: "conflict", conflict });
        continue;
      }

      actions.push({ type: "delete-local", localPath: absPath, record: stored });
      deleteCount++;
    }
  }

  // Deletion safety valve (same rationale as reconcile): if an implausibly
  // large share of tracked files appear deleted, the remote snapshot is
  // likely incomplete - suppress deletions until a healthy pass. The threshold
  // counts every CANDIDATE, not just the ones that survived the guard above,
  // so routing some of them to conflicts cannot talk the valve out of firing.
  // When it fires, the guard's conflicts go with the deletions: they rest on
  // the same "missing from the snapshot" reading, which is the thing being
  // distrusted.
  if (deleteCandidates.length > 0) {
    const storedCount = Object.keys(storedState.files).length;
    if (storedCount > 10 && deleteCandidates.length > 5 && deleteCandidates.length > storedCount * 0.5) {
      console.warn(`[sync] Suppressing ${deleteCount} local deletion(s) and ${guardConflictIds.size} withheld-file conflict(s) - ${deleteCandidates.length}/${storedCount} tracked files are missing from the snapshot, which exceeds the safety threshold (snapshot likely incomplete).`);
      return actions.filter(
        (a) => a.type !== "delete-local" && !(a.type === "conflict" && guardConflictIds.has(a.conflict.id)),
      );
    }
  }

  return actions;
}
