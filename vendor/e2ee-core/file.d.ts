/**
 * File content format (spec §5.5) - manifest, per-chunk AEAD, delta reuse,
 * random-access decryption.
 *
 * Layout: a file's plaintext is split into content-defined chunks
 * (`chunkBoundaries`). Each chunk is sealed independently with
 * XChaCha20-Poly1305 under the file's DEK, a random per-chunk nonce, and
 * associated data that binds ONLY `{fmt, workspaceId, dekId}` (`adChunk`) -
 * deliberately NOT the fileId, chunk index, or chunk count. That keeps
 * ciphertext chunks content-addressable and reusable across files/versions
 * (dedup, delta sync). This is NOT convergent encryption: `encryptFile`
 * draws a fresh random nonce per chunk, so encrypting the same plaintext
 * twice yields different ciphertext/chunkId each time. Verbatim reuse of an
 * existing chunk only happens explicitly, via `computeDelta` carrying
 * forward the old chunk's `{chunkId, nonce}` when it matches by `plainHash`.
 *
 * Ordering, count, and file identity live entirely in the `FileManifest`:
 *   - `chunkId = sha256(ciphertext)` is the chunk's content address; the
 *     manifest lists chunk refs in file order, so `chunks[i]` is the i-th
 *     plaintext segment regardless of any AD.
 *   - `manifest.merkleRoot = merkleRoot(chunks.map(c => c.chunkId))` binds
 *     the exact sequence of chunk ids - reordering or truncating the
 *     `chunks` array changes the recomputed root (see
 *     `verifyManifestIntegrity`). The manifest itself is authenticated at a
 *     higher layer (P0.4, under the workspace key) - this module treats it
 *     as a plain, trusted-once-verified object.
 *   - `plainHash = sha256(plaintext chunk)` is a client-only identity used
 *     purely for delta matching (`computeDelta`); it never leaves the
 *     client's local reasoning and is not part of any AD.
 *
 * Integrity order on read matters: callers MUST verify
 * `sha256(ciphertext) === chunkId` before attempting AEAD decryption. That
 * check is cheap, fails fast on corrupt/truncated storage, and - crucially -
 * happens before any key material touches attacker-controlled bytes.
 */
import { type ChunkParams, type ChunkBoundary } from "./chunker.js";
/**
 * THE BYTE RANGE OF ONE UPLOADED CIPHERTEXT CHUNK, as the API enforces it.
 *
 * The server signs each chunk's upload URL for the exact length the client
 * declares, and refuses a declaration outside this range, so a member cannot
 * park arbitrary bytes under random chunk ids. The range is what encryptFile /
 * computeDelta actually produce with the default chunker: the largest chunk is
 * a hard cut at CHUNK_MAX_PLAINTEXT_BYTES plus its tag, the smallest is a
 * 1-byte tail plus its tag (an empty file has no chunks at all, so a 0-byte
 * plaintext chunk is never sealed).
 *
 * apps/api/src/lib/e2ee/chunk-size.ts pins the same numbers - that app is
 * synced to its own repository and cannot import this package - so a change
 * here is a change there, shipped together (test/chunk-bounds.test.ts).
 */
export declare const CHUNK_MAX_CIPHERTEXT_BYTES: number;
export declare const CHUNK_MIN_CIPHERTEXT_BYTES: number;
export type ChunkRef = {
    chunkId: Uint8Array;
    nonce: Uint8Array;
    plainLen: number;
    plainHash: Uint8Array;
};
export type FileManifest = {
    fmt: number;
    workspaceId: string;
    fileId: string;
    version: number;
    dekId: string;
    totalSize: number;
    chunks: ChunkRef[];
    merkleRoot: Uint8Array;
};
export type EncryptedChunk = {
    chunkId: Uint8Array;
    ciphertext: Uint8Array;
};
/**
 * Where a streaming encrypt reads plaintext from. `boundaries` come from any
 * chunker implementation (the TypeScript `chunkBoundaries`, or a native
 * port validated against `CHUNKER_VECTORS`); `read` returns exactly `size`
 * bytes at `offset` - callers may return a subarray of a larger buffer, the
 * bytes are only read, never kept. Reads happen in boundary order, one at a
 * time, so a file handle can serve them sequentially.
 */
export type PlainChunkSource = {
    totalSize: number;
    boundaries: ChunkBoundary[];
    read(offset: number, size: number): Promise<Uint8Array>;
};
/** Receives each sealed chunk in index order; typically uploads it. */
export type EncryptedChunkSink = (chunk: EncryptedChunk, ref: ChunkRef, index: number) => Promise<void>;
/** Receives each decrypted chunk in index order; typically appends it to a file. */
export type PlainChunkSink = (plaintext: Uint8Array, index: number) => Promise<void>;
/**
 * Reject a boundary list a chunker should never have produced, BEFORE any
 * byte is read: a gap, an overlap, a start past zero, a zero-length chunk,
 * a chunk the API would refuse (over CHUNK_MAX_PLAINTEXT_BYTES), or a list
 * that does not add up to `totalSize`. A native chunker port with a bug
 * fails here, loudly, instead of producing a manifest that decrypts to the
 * wrong bytes.
 */
export declare function validateBoundaries(boundaries: ChunkBoundary[], totalSize: number): void;
/**
 * Split (per `source.boundaries`), encrypt (fresh nonces), hand each sealed
 * chunk to `sink` as it is produced, and build the manifest. Holds one
 * plaintext chunk and one ciphertext chunk at a time - the shape a phone
 * needs for a file it cannot fit in memory.
 */
export declare function encryptFileStreaming(args: {
    dek: Uint8Array;
    dekId: string;
    fmt: number;
    workspaceId: string;
    fileId: string;
    version: number;
    source: PlainChunkSource;
    sink: EncryptedChunkSink;
}): Promise<{
    manifest: FileManifest;
}>;
/** Split, encrypt (fresh nonces), and build the manifest for a whole in-memory file. */
export declare function encryptFile(args: {
    dek: Uint8Array;
    dekId: string;
    fmt: number;
    workspaceId: string;
    fileId: string;
    version: number;
    plaintext: Uint8Array;
    params?: Partial<ChunkParams>;
}): Promise<{
    manifest: FileManifest;
    chunks: EncryptedChunk[];
}>;
/**
 * Fetch, verify, and decrypt every chunk in manifest order, handing each
 * plaintext chunk to `sink` as it is produced. Integrity checks happen
 * BEFORE the first fetch (manifest root and declared sizes) and before each
 * chunk's decryption (content address), so a corrupt or tampered chunk stops
 * the stream at that chunk and never reaches the sink.
 */
export declare function decryptFileStreaming(args: {
    dek: Uint8Array;
    fmt: number;
    workspaceId: string;
    dekId: string;
    manifest: FileManifest;
    getCiphertext: (chunkId: Uint8Array) => Promise<Uint8Array>;
    sink: PlainChunkSink;
}): Promise<void>;
/** Fetch, verify, and decrypt every chunk in manifest order; concatenate the plaintext. */
export declare function decryptFile(args: {
    dek: Uint8Array;
    fmt: number;
    workspaceId: string;
    dekId: string;
    manifest: FileManifest;
    getCiphertext: (chunkId: Uint8Array) => Promise<Uint8Array>;
}): Promise<Uint8Array>;
/** Decrypt only the chunks overlapping `[start, end)`, slicing to the exact byte range. */
export declare function decryptRange(args: {
    dek: Uint8Array;
    fmt: number;
    workspaceId: string;
    dekId: string;
    manifest: FileManifest;
    start: number;
    end: number;
    getCiphertext: (chunkId: Uint8Array) => Promise<Uint8Array>;
}): Promise<Uint8Array>;
/**
 * Re-chunk `newPlaintext` and diff against `oldManifest` by `plainHash`:
 * chunks whose plaintext is unchanged reuse the old `{chunkId, nonce}`
 * verbatim (no re-encryption, no new ciphertext object); everything else is
 * freshly encrypted. Returns the new manifest plus ONLY the freshly
 * encrypted chunks - the caller/server already holds the reused ones.
 */
export declare function computeDelta(args: {
    dek: Uint8Array;
    dekId: string;
    fmt: number;
    workspaceId: string;
    fileId: string;
    newVersion: number;
    oldManifest: FileManifest;
    newPlaintext: Uint8Array;
    params?: Partial<ChunkParams>;
}): Promise<{
    manifest: FileManifest;
    newChunks: EncryptedChunk[];
}>;
/** Recompute the Merkle root over `manifest.chunks` and compare to `manifest.merkleRoot`. */
export declare function verifyManifestIntegrity(manifest: FileManifest): Promise<boolean>;
