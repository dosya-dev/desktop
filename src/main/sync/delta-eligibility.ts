/**
 * When a delta (block-level) upload is worth attempting, and when it is not
 * even possible.
 *
 * These limits are not preferences - they mirror what the server can actually
 * do. `/api/sync/chunks/commit` reassembles a file by streaming every chunk
 * through the Worker, and caps that at 64 MB (MAX_BYTES) and 8192 chunks
 * (MAX_CHUNKS). Ask it to exceed either and it refuses, so the client has to
 * know the same numbers and take the whole-file path instead.
 *
 * Kept in its own leaf module so the rules are unit-testable and so the two
 * places that care - deciding whether to STORE a chunk list, and deciding
 * whether to USE one - can never drift apart.
 */

/** Below this a delta would send essentially the whole file anyway, and
 *  chunking costs a full extra read. */
export const DELTA_MIN_BYTES = 8 * 1024 * 1024;

/** Server reassembly ceiling - MAX_BYTES in apps/api .../chunks/commit.ts. */
export const DELTA_MAX_BYTES = 64 * 1024 * 1024;

/** Server chunk-count ceiling - MAX_CHUNKS in the same file. */
export const DELTA_MAX_CHUNKS = 8192;

/** Whether a file of this size is worth keeping a chunk list for at all. */
export function blockTrackingApplies(sizeBytes: number): boolean {
  return sizeBytes >= DELTA_MIN_BYTES && sizeBytes <= DELTA_MAX_BYTES;
}

export interface DeltaDecision {
  attempt: boolean;
  /** Why not, for the Activity log. Empty when attempting. */
  reason: string;
}

/**
 * Decide whether to try a delta upload for a file we are about to send.
 *
 * `priorChunkCount` is how many chunks the last synced version had: with none
 * there is nothing on the server to diff against, so a delta would upload
 * every chunk and then ask for a reassembly - strictly worse than sending the
 * file once.
 */
export function shouldAttemptDelta(sizeBytes: number, priorChunkCount: number, chunkCount: number): DeltaDecision {
  if (sizeBytes < DELTA_MIN_BYTES) return { attempt: false, reason: "file is small enough to send whole" };
  if (sizeBytes > DELTA_MAX_BYTES) return { attempt: false, reason: "file is larger than the server can reassemble" };
  if (priorChunkCount === 0) return { attempt: false, reason: "no previous chunk list to diff against" };
  if (chunkCount === 0) return { attempt: false, reason: "file produced no chunks" };
  if (chunkCount > DELTA_MAX_CHUNKS) return { attempt: false, reason: "file has more chunks than the server accepts" };
  return { attempt: true, reason: "" };
}

/**
 * Whether sending these chunks is actually cheaper than sending the file.
 *
 * A delta that has to upload nearly everything costs MORE than a plain upload
 * (same bytes, plus a reassembly), so there is a floor on how much has to be
 * reused before it is worth it.
 */
export function deltaIsWorthIt(totalBytes: number, missingBytes: number): boolean {
  if (totalBytes <= 0) return false;
  return missingBytes / totalBytes <= 0.8;
}
