/**
 * Guards around the one irreversible thing the engine does: deleting.
 *
 * Field report 2026-09-02 (desktop #2). The reconciler already refused to
 * apply an implausibly large share of deletions in one cycle, but the rule
 * lived inline in two places and the watcher-driven push path had no copy of
 * it at all - an unplugged external drive fanned out to a batch delete of
 * every cloud copy. Local deletes were also a bare unlink, so a wrong one was
 * gone for good. This module is the single home of both rules.
 *
 * Electron-free and a leaf (type-only or no sibling imports) so `node --test`
 * can load it; the engine injects the OS trash call.
 */

/**
 * The reconciler's valve, verbatim: deleting more than 5 files AND more than
 * half of what the pair tracks is far more likely to be a partial scan, an
 * incomplete snapshot or a vanished volume than a real decision. Tiny pairs
 * (10 tracked files or fewer) are exempt - there, deleting half is ordinary.
 */
export function exceedsDeletionThreshold(deleteCount: number, storedCount: number): boolean {
  return storedCount > 10 && deleteCount > 5 && deleteCount > storedCount * 0.5;
}

export interface TrackedFileRef {
  remoteId: string;
  localPath: string;
}

export interface LocalDeletionEvent {
  type: "unlink" | "unlinkDir";
  /** Relative to the pair root, forward slashes. */
  relPath: string;
}

/**
 * One materialised, prefix-searchable view of what a pair tracks.
 *
 * Built ONCE per watcher batch. The callbacks it replaces each did
 * `[...index.iterFiles(pairId)]` per call, and one of them was called twice
 * per unlinkDir - so deciding a batch of N events over M tracked files cost
 * O(N x M) index reads before a single delete was issued (fix round 1, F3).
 * Sorted arrays plus binary search make it O(M log M) once and O(log M + k)
 * per query.
 */
export interface TrackedSnapshot {
  /** The tracked file at exactly this relative path, if any. */
  fileByPath(relPath: string): TrackedFileRef | undefined;
  /** Every tracked file whose path starts with `prefix` (a rel dir plus "/"). */
  filesUnder(prefix: string): TrackedFileRef[];
  /** Every tracked folder rel path strictly under `prefix`. */
  foldersUnder(prefix: string): string[];
  /** Whether this exact folder path is tracked. */
  hasFolder(relPath: string): boolean;
}

/** Index of the first element >= `key` in a sorted array of paths. */
function lowerBound(sorted: readonly string[], key: string): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid] < key) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function trackedSnapshot(
  files: Iterable<TrackedFileRef>,
  folders: Iterable<string>,
): TrackedSnapshot {
  const byPath = new Map<string, TrackedFileRef>();
  for (const f of files) byPath.set(f.localPath, f);
  const filePaths = [...byPath.keys()].sort();
  const folderSet = new Set(folders);
  const folderPaths = [...folderSet].sort();

  /** The contiguous run of sorted paths that start with `prefix`. */
  const range = (sorted: readonly string[], prefix: string): string[] => {
    const out: string[] = [];
    for (let i = lowerBound(sorted, prefix); i < sorted.length; i++) {
      if (!sorted[i].startsWith(prefix)) break; // sorted: the run ended
      out.push(sorted[i]);
    }
    return out;
  };

  return {
    fileByPath: (relPath) => byPath.get(relPath),
    filesUnder: (prefix) => range(filePaths, prefix).map((p) => byPath.get(p)!),
    foldersUnder: (prefix) => range(folderPaths, prefix),
    hasFolder: (relPath) => folderSet.has(relPath),
  };
}

/**
 * What a watcher batch would delete from the cloud, counted BEFORE anything
 * is deleted. Chokidar reports a removed tree as one unlink per file plus one
 * unlinkDir per directory, in no guaranteed order, so the old per-event
 * handling had already deleted most files one by one before the directory
 * event could be judged. Files are deduped by remote id.
 */
export function collectLocalDeletions(
  events: LocalDeletionEvent[],
  tracked: TrackedSnapshot,
): { files: TrackedFileRef[]; folders: string[] } {
  const files = new Map<string, TrackedFileRef>();
  const folders = new Set<string>();
  for (const ev of events) {
    if (ev.type === "unlink") {
      const f = tracked.fileByPath(ev.relPath);
      if (f) files.set(f.remoteId, f);
      continue;
    }
    const prefix = ev.relPath + "/";
    for (const f of tracked.filesUnder(prefix)) files.set(f.remoteId, f);
    // One query per unlinkDir, not two: the folder itself is checked against
    // the snapshot's set rather than by searching its own prefix again.
    for (const rel of tracked.foldersUnder(prefix)) folders.add(rel);
    if (tracked.hasFolder(ev.relPath)) folders.add(ev.relPath);
  }
  return { files: [...files.values()], folders: [...folders] };
}

/** Apply a small batch; hold a large one until the user decides. */
export function deletionDecision(deletionCount: number, trackedCount: number): "apply" | "confirm" {
  return exceedsDeletionThreshold(deletionCount, trackedCount) ? "confirm" : "apply";
}

/** Why a batch of deletions was withheld this cycle. */
export type SuppressionReason = "scan-incomplete" | "over-threshold";

/**
 * What to tell the user when deletions were withheld.
 *
 * The cloud-side case asks the user outright (needs-confirmation). The
 * local-side case only ever wrote a console.warn, so someone whose deletions
 * were suppressed - possibly for many cycles in a row, if a drive stays
 * unreadable - was told nothing at all, and the pair still reported itself
 * synced. Silence about work deliberately not done is the same defect as
 * claiming work that did not happen.
 */
export function deletionSuppressedNotice(count: number, reason: SuppressionReason): string {
  const files = `${count.toLocaleString()} file${count === 1 ? "" : "s"}`;
  const because = reason === "scan-incomplete"
    ? "a folder on this device could not be read, so dosya cannot tell a deletion from a folder it simply cannot see"
    : "that is an unusually large share of this folder, which usually means a drive or folder went missing rather than someone deleting things";
  return `${files} were not deleted this time: ${because}. Nothing was removed, and dosya will try again on the next healthy scan.`;
}

export interface LocalRemoveIo {
  /** Move to the OS trash (Electron's shell.trashItem, or a host RPC to it). */
  trash(absPath: string): Promise<void>;
  /** Permanent removal - the fallback when trashing is not possible. */
  unlink(absPath: string): Promise<void>;
}

/**
 * Remove a local file the engine decided is gone from the server: trash
 * first, so the user can get it back; unlink only when the trash refuses
 * (network volumes, some Linux desktops, a sandbox). A file that is already
 * gone is not an error - the point was for it to be gone.
 */
export async function removeLocalFile(absPath: string, io: LocalRemoveIo): Promise<"trashed" | "unlinked" | "missing"> {
  try {
    await io.trash(absPath);
    return "trashed";
  } catch (trashErr: any) {
    if (trashErr?.code === "ENOENT") return "missing";
  }
  try {
    await io.unlink(absPath);
    return "unlinked";
  } catch (err: any) {
    if (err?.code === "ENOENT") return "missing";
    throw err;
  }
}
