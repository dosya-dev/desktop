import type { RemoteFileInfo, RemoteFolderInfo, SyncFileError, SyncFileRecord } from "./types";

/**
 * Relative paths for a remote snapshot, shared by the reconciler (two-way),
 * the pull path and the pre-population step - three copies of this walk used
 * to live in three places, and all three answered the same question the same
 * wrong way.
 *
 * The question: where does a file go whose folder_id is NOT in the folder map?
 * That happens legitimately - a delta poll applies a folder tombstone before
 * the matching file tombstones, a folder the caller cannot see is withheld
 * from the snapshot, a corrupt or cyclic parent chain. The old answer was the
 * sync ROOT (field report 2026-09-02, desktop #1), which downloaded the file
 * to the wrong place and on the next cycle read as a move or a spurious
 * delete. The answer now is "unknown": the file is left out of the maps and
 * returned in `unknownParent` so the engine can say so and try again next
 * cycle, when the folder is usually present.
 *
 * Type-only sibling imports: a module a `node --test` file loads directly has
 * to be a leaf (see index-db.ts). Name normalization is therefore injected -
 * the reconciler passes NFC; tests pass nothing.
 */

/** Deeper than this and the chain is treated as corrupt rather than walked. */
const MAX_REMOTE_FOLDER_DEPTH = 100;

export const UNKNOWN_PARENT_MESSAGE = "parent folder not yet known; will retry";

/**
 * Ledger key prefix for an unresolved file. It can never collide with a real
 * relative path (no real path starts with "(unknown folder"), and the folder
 * id is part of the key so two same-named files under two different unknown
 * folders stay two rows instead of collapsing into one.
 */
const UNKNOWN_PARENT_KEY_PREFIX = "(unknown folder";

export interface RemotePaths {
  /** remoteId → relative path, for every file whose folder chain resolved. */
  filePathMap: Map<string, string>;
  /** folderId → relative path, for every folder whose chain resolved. */
  folderPathMap: Map<string, string>;
  /** Files whose folder_id (or an ancestor) is not in the snapshot. */
  unknownParent: RemoteFileInfo[];
  /** Folders whose parent chain does not reach the root (missing or cyclic). */
  unknownFolders: string[];
}

export function buildRemotePaths(
  remoteFiles: Map<string, RemoteFileInfo>,
  remoteFolders: Map<string, RemoteFolderInfo>,
  rootFolderId: string | null,
  normalize: (name: string) => string = (s) => s,
): RemotePaths {
  const folderPathMap = new Map<string, string>();
  const unknownFolderSet = new Set<string>();
  const building = new Set<string>(); // cycle detection

  /** Relative path of a folder, or null when its chain cannot be resolved. */
  function folderPath(folderId: string, depth: number): string | null {
    const known = folderPathMap.get(folderId);
    if (known !== undefined) return known;
    if (unknownFolderSet.has(folderId)) return null;
    if (building.has(folderId) || depth > MAX_REMOTE_FOLDER_DEPTH) {
      unknownFolderSet.add(folderId);
      return null;
    }
    const folder = remoteFolders.get(folderId);
    if (!folder) return null; // not in the snapshot at all - the caller records it
    building.add(folderId);
    try {
      const name = normalize(folder.name);
      const parentId = folder.parent_id;
      if (!parentId || parentId === rootFolderId) {
        folderPathMap.set(folderId, name);
        return name;
      }
      const parentPath = folderPath(parentId, depth + 1);
      if (parentPath === null) {
        unknownFolderSet.add(folderId);
        return null;
      }
      const p = `${parentPath}/${name}`;
      folderPathMap.set(folderId, p);
      return p;
    } finally {
      building.delete(folderId);
    }
  }

  for (const [id] of remoteFolders) folderPath(id, 0);

  const filePathMap = new Map<string, string>();
  const unknownParent: RemoteFileInfo[] = [];
  for (const [id, file] of remoteFiles) {
    const folderId = file.folder_id;
    const name = normalize(file.name);
    if (!folderId || folderId === rootFolderId) {
      filePathMap.set(id, name);
      continue;
    }
    const dir = folderPathMap.get(folderId);
    if (dir === undefined) {
      unknownParent.push(file);
      continue;
    }
    filePathMap.set(id, `${dir}/${name}`);
  }

  return { filePathMap, folderPathMap, unknownParent, unknownFolders: [...unknownFolderSet] };
}

/**
 * Path map for a snapshot with the unknown-parent placement already applied -
 * the form every caller actually wants.
 *
 * `baseById` is REQUIRED, and that is the point: it was optional-by-habit
 * before, and the reconciler passed `storedState.files[id]`, which
 * `loadPairState` always returns empty (the base tree lives in SQLite). The
 * placement branch was therefore dead and a synced file whose folder vanished
 * went back to being planned as a deletion. A required argument makes that
 * mistake a compile error.
 */
export function resolveRemotePaths(input: {
  files: Map<string, RemoteFileInfo>;
  folders: Map<string, RemoteFolderInfo>;
  rootFolderId: string | null;
  baseById: (remoteId: string) => SyncFileRecord | undefined;
  normalize?: (name: string) => string;
}): RemotePaths & { unresolved: RemoteFileInfo[] } {
  const built = buildRemotePaths(input.files, input.folders, input.rootFolderId, input.normalize);
  const { placed, unresolved } = placeUnknownParents(built.unknownParent, input.baseById);
  for (const [id, relPath] of placed) built.filePathMap.set(id, relPath);
  return { ...built, unresolved };
}

/**
 * Decide what to do with the unknown-parent files.
 *
 * A file we have synced before keeps its last known path: it certainly still
 * exists on the server, so leaving it out of the remote view would make the
 * planner read "deleted remotely" and remove the local copy. Its bytes can
 * still be compared and updated in place; only its position is in doubt. A
 * file we have never seen has no safe place to go and waits for the folder.
 */
export function placeUnknownParents(
  unknown: RemoteFileInfo[],
  baseById: (remoteId: string) => SyncFileRecord | undefined,
): { placed: Map<string, string>; unresolved: RemoteFileInfo[] } {
  const placed = new Map<string, string>();
  const unresolved: RemoteFileInfo[] = [];
  for (const file of unknown) {
    const stored = baseById(file.id);
    if (stored?.localPath) placed.set(file.id, stored.localPath);
    else unresolved.push(file);
  }
  return { placed, unresolved };
}

/** The ledger row for a file that is waiting on its folder. Never permanent. */
export function unknownParentError(file: RemoteFileInfo, now: number): SyncFileError {
  return {
    filePath: `${UNKNOWN_PARENT_KEY_PREFIX} ${file.folder_id ?? "?"})/${file.name}`,
    error: UNKNOWN_PARENT_MESSAGE,
    retryCount: 0,
    lastAttemptAt: now,
    permanent: false,
  };
}

// ── The same rule, in the UPLOAD direction ──────────────────────────
//
// Everything above answers "where does this REMOTE file belong locally". This
// answers the mirror question - "which remote folder does this LOCAL file
// belong in" - and it had the same bug for longer: three engine sites
// resolved an unknown parent with `?? pair.remoteFolderId`, so a directory
// whose remote folder was never created had its files written to the sync
// root. That is the same flattening, in the direction that writes to the
// user's cloud. The answer is the same too: defer, never place at the root.

export type ParentResolution =
  | { known: true; folderId: string | null }
  | { known: false; parentRelPath: string };

/**
 * The remote folder a local relative path belongs in.
 *
 * A path with no directory part belongs in the pair's own root folder, and
 * that is a KNOWN answer (`folderId: null` when the pair has no remote root
 * yet) - not a fallback. Anything else must have its folder on record.
 */
export function resolveParentFolderId(
  relPath: string,
  opts: {
    rootFolderId: string | null;
    /** The pair's folder index: relative path -> remote folder id. */
    folderIdFor: (parentRelPath: string) => string | undefined;
  },
): ParentResolution {
  const cut = relPath.lastIndexOf("/");
  if (cut === -1) return { known: true, folderId: opts.rootFolderId };
  const parentRelPath = relPath.slice(0, cut);
  const folderId = opts.folderIdFor(parentRelPath);
  return folderId === undefined
    ? { known: false, parentRelPath }
    : { known: true, folderId };
}

export const MISSING_PARENT_MESSAGE = (parentRelPath: string): string =>
  `Parent folder "${parentRelPath}" is not on the server yet; will retry`;

/**
 * The ledger row for a file deferred because its folder does not exist
 * remotely yet. Never permanent: the next scan creates the folder tree first,
 * and then this file goes where it belongs.
 */
export function missingParentError(
  relPath: string,
  parentRelPath: string,
  now: number,
  prev?: SyncFileError,
): SyncFileError {
  return {
    filePath: relPath,
    error: MISSING_PARENT_MESSAGE(parentRelPath),
    retryCount: (prev?.retryCount ?? 0) + 1,
    lastAttemptAt: now,
    permanent: false,
  };
}

/** True for a ledger row written by unknownParentError - cleared every cycle. */
export function isUnknownParentError(err: SyncFileError): boolean {
  return err.error === UNKNOWN_PARENT_MESSAGE && err.filePath.startsWith(UNKNOWN_PARENT_KEY_PREFIX);
}
