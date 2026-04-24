import { join, relative, sep } from "path";
import { readdir, stat } from "fs/promises";
import { shouldIgnoreEntry } from "./local-watcher";
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
 * Build a map of local files: relative path → stat.
 * Always uses forward slashes in paths regardless of OS.
 * Uses the shared shouldIgnoreEntry() filter so the scanner and watcher
 * have identical ignore semantics.
 */
const STAT_BATCH_SIZE = 50;
const YIELD_INTERVAL = 200;

async function scanLocal(
  rootPath: string,
  userPatterns?: string[],
): Promise<{ files: Map<string, LocalFileStat>; dirs: Set<string> }> {
  const files = new Map<string, LocalFileStat>();
  const dirs = new Set<string>();
  let yieldCounter = 0;

  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_FOLDER_DEPTH) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    // Collect file entries for batch stat
    const fileEntries: { fullPath: string; relPath: string }[] = [];

    for (const entry of entries) {
      if (shouldIgnoreEntry(entry.name, entry.isDirectory(), userPatterns)) continue;

      const fullPath = join(dir, entry.name);
      const relPath = relative(rootPath, fullPath).split(sep).join("/");

      if (entry.isDirectory()) {
        dirs.add(relPath);
        // Yield periodically to keep event loop responsive
        if (++yieldCounter % YIELD_INTERVAL === 0) {
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
        batch.map(f => stat(f.fullPath).catch(() => null)),
      );
      for (let j = 0; j < batch.length; j++) {
        const s = stats[j];
        if (!s || !s.isFile() || s.size > 100 * 1024 * 1024 * 1024) continue;
        files.set(batch[j].relPath, {
          sizeBytes: s.size,
          mtimeMs: s.mtimeMs,
          isDirectory: false,
        });
      }
      if (++yieldCounter % YIELD_INTERVAL === 0) {
        await new Promise<void>(r => setImmediate(r));
      }
    }
  }

  await walk(rootPath, 0);
  return { files, dirs };
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
    const parentId = folder.parent_id;
    if (!parentId || parentId === rootFolderId) {
      folderPathMap.set(folderId, folder.name);
      return folder.name;
    }
    const parentPath = folderPath(parentId);
    const p = parentPath ? `${parentPath}/${folder.name}` : folder.name;
    folderPathMap.set(folderId, p);
    return p;
  }

  for (const [id] of remoteFolders) {
    folderPath(id);
  }

  const filePathMap = new Map<string, string>();
  for (const [id, file] of remoteFiles) {
    const folderId = file.folder_id;
    if (!folderId || folderId === rootFolderId) {
      filePathMap.set(id, file.name);
    } else {
      const fp = folderPathMap.get(folderId);
      filePathMap.set(id, fp ? `${fp}/${file.name}` : file.name);
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
): Promise<SyncAction[]> {
  const actions: SyncAction[] = [];
  const { files: localFiles, dirs: localDirs } = await scanLocal(pair.localPath, pair.excludedPatterns);
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

  for (const remoteId of allFileIds) {
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
      const localChanged =
        localStat.mtimeMs !== stored.localMtimeMs ||
        localStat.sizeBytes !== stored.localSizeBytes;
      if (localChanged) {
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
      const localChanged =
        localStat.mtimeMs !== stored.localMtimeMs ||
        localStat.sizeBytes !== stored.localSizeBytes;

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
    // (no action needed — will be cleaned below)
  }

  // Clean up stale records: files that exist in stored state but are gone from both
  // remote and local (Case 6)
  for (const id of Object.keys(storedState.files)) {
    if (!processedIds.has(id)) continue;
    const stored = storedState.files[id];
    const remoteFile = remote.files.get(id);
    const localStat = stored.localPath ? localFiles.get(stored.localPath) : undefined;
    if (!remoteFile && !localStat) {
      delete storedState.files[id];
    }
  }

  return actions;
}

/**
 * Lightweight remote-only reconcile — no local filesystem scan.
 * Only detects remote changes (new, updated, deleted files) by comparing
 * the remote snapshot against stored state. Used when the watcher reports
 * no local changes since the last full reconcile.
 *
 * This saves 15+ seconds of I/O per poll cycle on large file trees (150K files).
 */
export function reconcileRemoteOnly(
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

  // Check for remote deletions
  for (const [id, stored] of Object.entries(storedState.files)) {
    if (!remote.files.has(id)) {
      // File deleted remotely → delete locally
      actions.push({ type: "delete-local", localPath: join(pair.localPath, stored.localPath), record: stored });
    }
  }

  return Promise.resolve(actions);
}
