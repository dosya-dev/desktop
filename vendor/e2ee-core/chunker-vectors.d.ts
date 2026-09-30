/**
 * Frozen content-defined-chunking vectors for ports of `chunker.ts` to other
 * languages (the mobile app's Swift and Kotlin chunker, phase 2).
 *
 * A port is correct when, for every `CHUNKER_VECTORS` entry, feeding
 * `chunkerVectorBytes(size)` through its boundary loop with the DEFAULT
 * params (min 256 KiB, avg 1 MiB, max 4 MiB) yields exactly `boundaries`.
 * Before that, a port checks its copied gear table: the SHA-256 of the 256
 * entries serialized as little-endian uint32 (1024 bytes) must equal
 * `CHUNKER_GEAR_SHA256_HEX`.
 *
 * Generated once from this package's own chunker and frozen. Do not
 * regenerate unless the chunking algorithm changes on purpose - which
 * changes every client's chunk boundaries and must be a deliberate,
 * versioned decision.
 */
/** Deterministic pseudo-random bytes (xorshift32, seed 0x12345678, low byte of each state). */
export declare function chunkerVectorBytes(n: number): Uint8Array;
export declare const CHUNKER_VECTOR_SIZES: readonly number[];
/** SHA-256 over the gear table (256 x little-endian uint32). */
export declare const CHUNKER_GEAR_SHA256_HEX = "316e3aaf9142a51ab230212ecd96e71b4ff23ea1fd3d3e56f43b6a8759b04d0c";
export declare const CHUNKER_VECTORS: readonly {
    size: number;
    boundaries: readonly {
        offset: number;
        size: number;
    }[];
}[];
