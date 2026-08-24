/**
 * Worker-pool sizing for lightweight direct-to-R2 transfers (presigned URLs).
 *
 * Kept free of electron imports so the sizing rules are unit-testable under
 * plain node.
 *
 * These values derive HONESTLY from the user's maxConcurrentTransfers
 * setting. The previous base*6 formula (floor 6, caps 32/64) turned the
 * default "max 3 transfers" into 18-36 unpaced concurrent PUTs, which
 * saturated a residential uplink's queue and made the user's whole network
 * unusable (2026-08-20 stress test). Parallelism helps round-trip-bound tiny
 * files, but past a handful of flows it only adds bufferbloat.
 */

/** Cap for mixed/large presigned transfers - bounded well under the socket pool. */
export const TRANSFER_CONCURRENCY_CAP = 12;

/**
 * Files at or under this are pure round-trip latency: the bytes fit in a
 * socket buffer, so an in-flight transfer holds ~64KB and nothing else.
 */
export const TINY_FILE_MAX_BYTES = 256 * 1024;

/**
 * Ceiling for chunks of only-tiny files. Must stay at or under
 * remote-client.ts's MAX_SOCKETS_PER_HOST, or the surplus workers just queue
 * on the agent.
 */
export const TINY_TRANSFER_CONCURRENCY_CAP = 16;

/**
 * Concurrency for one presigned-transfer chunk, derived from the user's
 * maxConcurrentTransfers setting and the largest file in the chunk. The
 * engine sorts uploads by size before chunking, so chunks are
 * size-homogeneous: a chunk of tiny files spends its whole life waiting on
 * round-trips, not the pipe, and can safely run a pipeline twice as deep.
 */
export function directConcurrencyFor(base: number, chunkMaxBytes: number): number {
  const b = Number.isFinite(base) && base >= 1 ? Math.floor(base) : 1;
  const std = Math.min(TRANSFER_CONCURRENCY_CAP, Math.max(2, b * 2));
  if (chunkMaxBytes > TINY_FILE_MAX_BYTES) return std;
  return Math.min(TINY_TRANSFER_CONCURRENCY_CAP, std * 2);
}
