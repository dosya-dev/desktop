/**
 * The last check before a download replaces a local file.
 *
 * The planner decided "download-update" from a scan that may be minutes old
 * (a large queue, a slow link). If the user saved the file in between, the
 * base record no longer vouches for the bytes on disk, and renaming the
 * download over them destroys an edit with no copy kept. This is the I1
 * precondition from sim-fs.ts applied at execution time, not planning time.
 *
 * Leaf module (no sibling imports) so `node --test` can load it.
 */

export interface LocalStat {
  size: number;
  mtimeMs: number;
}

export interface BaseRecordLike {
  localSizeBytes: number;
  localMtimeMs: number;
}

/**
 * True when the file on disk is exactly what the base record says it was.
 * A record with `localMtimeMs: 0` predates mtime tracking and is compared by
 * size alone, matching the simulator's `localMatchesBase`.
 */
export function localMatchesRecord(stat: LocalStat | null, record: BaseRecordLike): boolean {
  if (!stat) return false;
  if (stat.size !== record.localSizeBytes) return false;
  if (record.localMtimeMs === 0) return true;
  return stat.mtimeMs === record.localMtimeMs;
}

/**
 * The rule a `download-update` rename obeys: nothing changed between the
 * moment the plan looked at the local file and the rename. A path that is
 * now empty is safe to fill (renaming onto nothing destroys no bytes), so a
 * file the user deleted locally still receives the newer server copy.
 */
export function updateMayReplace(now: LocalStat | null, baseline: BaseRecordLike): boolean {
  if (!now) return true;
  return localMatchesRecord(now, baseline);
}

/**
 * The local state the plan saw. reconcile() fills `expectedLocal` from its
 * scan, and that is the baseline: under last-write-wins the planner emits
 * download-update precisely BECAUSE the file differs from the base record, so
 * comparing against the record would refuse every planned overwrite. When
 * the planner did not look at the local file (the remote-only fast path) it
 * implicitly assumed the record still described it, so the record is the
 * baseline.
 */
export function baselineFor(action: {
  existingRecord: BaseRecordLike;
  expectedLocal?: { sizeBytes: number; mtimeMs: number };
}): BaseRecordLike {
  if (!action.expectedLocal) return action.existingRecord;
  return { localSizeBytes: action.expectedLocal.sizeBytes, localMtimeMs: action.expectedLocal.mtimeMs };
}

/** A stat taken when a handler decided to download, as a baseline. */
export function baselineFromStat(s: LocalStat): BaseRecordLike {
  return { localSizeBytes: s.size, localMtimeMs: s.mtimeMs };
}

export class LocalChangedDuringDownloadError extends Error {
  readonly relPath: string;
  constructor(relPath: string) {
    super(`"${relPath}" changed on this device while its newer server version was downloading`);
    this.name = "LocalChangedDuringDownloadError";
    this.relPath = relPath;
  }
}
