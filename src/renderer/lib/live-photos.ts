// Ported from apps/web/src/lib/live-photos.ts - keep in sync
/**
 * Live Photo pairing on the client. The API decides what is a pair (see
 * apps/api/src/lib/repo/repo-d1/live-pairs.ts); these helpers only read its answer.
 * Grids and filmstrips collapse the twin under the still; list view keeps it as
 * a row right under the still; delete and move take the twin along.
 */
export interface LivePairFields {
  id: string;
  live_video_id?: string | null;
  live_photo_id?: string | null;
}

export function isLiveStill(f: LivePairFields): boolean {
  return typeof f.live_video_id === 'string' && f.live_video_id.length > 0;
}

export function isLiveTwin(f: LivePairFields): boolean {
  return typeof f.live_photo_id === 'string' && f.live_photo_id.length > 0;
}

/** Grid and filmstrip order: every twin whose still is in the list disappears. */
export function collapseLiveTwins<T extends LivePairFields>(files: readonly T[]): T[] {
  const stills = new Set(files.filter(isLiveStill).map((f) => f.id));
  return files.filter((f) => !(isLiveTwin(f) && stills.has(f.live_photo_id!)));
}

/** List order: each twin sits directly after its still; orphan twins keep their place. */
export function twinsUnderStills<T extends LivePairFields>(files: readonly T[]): T[] {
  const twinsByStill = new Map<string, T>();
  for (const f of files) if (isLiveTwin(f)) twinsByStill.set(f.live_photo_id!, f);
  const stills = new Set(files.filter(isLiveStill).map((f) => f.id));
  const out: T[] = [];
  for (const f of files) {
    if (isLiveTwin(f) && stills.has(f.live_photo_id!)) continue;
    out.push(f);
    if (isLiveStill(f)) {
      const twin = twinsByStill.get(f.id);
      if (twin) out.push(twin);
    }
  }
  return out;
}

/** The twin ids to add when acting on a selection, excluding ones already selected. */
export function liveTwinIds(files: readonly LivePairFields[], selectedIds: ReadonlySet<string>): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!selectedIds.has(f.id) || !isLiveStill(f)) continue;
    const twin = f.live_video_id!;
    if (!selectedIds.has(twin) && !out.includes(twin)) out.push(twin);
  }
  return out;
}

export function liveTwinOf<T extends LivePairFields>(files: readonly T[], still: LivePairFields): T | null {
  if (!isLiveStill(still)) return null;
  return files.find((f) => f.id === still.live_video_id) ?? null;
}

export interface LiveDeleteTarget {
  type: 'file' | 'folder';
  twin?: { id: string } | null;
  withTwin?: boolean;
  permanent?: boolean;
}

/**
 * The twin's DELETE endpoint when a single-file delete should take its twin
 * along, else null. Deleting a still is always two requests (the still, then
 * the twin) - the checkbox can only opt the twin out, never fold it into one.
 *
 * A permanent delete never carries the twin. The trash listing projects no
 * pairing fields at all (they are NULL there by design), so a `twin` on a
 * permanent target could only be a leftover from the row that opened the
 * dialog - and acting on it would purge a second file for good without ever
 * having named it. The irreversible path takes exactly what was selected.
 */
export function twinDeleteEndpoint(target: LiveDeleteTarget): string | null {
  if (target.type !== 'file' || !target.twin || target.withTwin === false) return null;
  if (target.permanent) return null;
  return `/api/files/${target.twin.id}`;
}
