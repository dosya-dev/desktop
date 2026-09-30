/**
 * Content-defined chunking (FastCDC-style) - pure boundary computation.
 *
 * Splits a buffer into variable-length chunks at boundaries determined by the
 * *content* (a rolling gear hash), not fixed offsets. The key property: when
 * you insert or remove bytes in the middle of a file, only the chunks around
 * the edit change - every other chunk's boundaries (and thus content) stay
 * identical, which is what makes delta sync / dedup possible.
 *
 * This module is pure and deterministic (fixed gear table, no RNG, no I/O),
 * so its output is stable across machines and platforms - a prerequisite for
 * cross-client dedup. It intentionally returns ONLY boundaries `{offset,
 * size}`; computing a strong hash/identity for each chunk is the file
 * layer's job (this package has no Node `crypto`/`fs` dependency).
 *
 * Lifted from `apps/desktop/src/main/sync/chunker.ts` (`chunkBuffer`'s cut
 * algorithm - deterministic GEAR table + normalized chunking, NC=2), with the
 * Node-only I/O (`chunkFile`/streaming), the `paths` dependency, and the
 * sha256 chunk-identity computation removed.
 */
export interface ChunkBoundary {
    /** Byte offset of this chunk within the input. */
    offset: number;
    /** Length of this chunk in bytes. */
    size: number;
}
export interface ChunkParams {
    min: number;
    avg: number;
    max: number;
}
/**
 * The largest plaintext chunk the DEFAULT parameters emit - the chunker's hard
 * cut. Every shipped client (e2ee-client file.ts) chunks with the defaults, so
 * this is the largest plaintext any uploaded chunk carries; see
 * CHUNK_MAX_CIPHERTEXT_BYTES in aead.ts for what that weighs on the wire.
 */
export declare const CHUNK_MAX_PLAINTEXT_BYTES: number;
/**
 * Compute content-defined chunk boundaries over `data`.
 *
 * Pure and deterministic: same input + params always produce the same
 * boundaries. Offsets are contiguous and sizes sum to `data.length`. Every
 * chunk is within `[min, max]` except possibly the last, which may be
 * shorter than `min` (whatever bytes remain at EOF).
 */
export declare function chunkBoundaries(data: Uint8Array, params?: Partial<ChunkParams>): ChunkBoundary[];
