/**
 * Signed root manifest, encrypted folder/file manifests, and freshness
 * checks (spec §6, §5.6).
 *
 * The root manifest is a workspace's single source of truth for "what does
 * this workspace currently look like": it binds a `folderMerkleRoot` (the
 * root of the folder tree) and a `membershipHeadHash` (the tip of the P0.4
 * Task 3 membership log) under one Ed25519 signature, and chains to its own
 * predecessor via `prevRootHash` - so a client that has seen manifest N can
 * detect a server trying to serve a stale or forked manifest N (or an
 * out-of-order one) by comparing hashes (`checkFreshness`), never by trusting
 * a bare version counter alone.
 *
 * Folder indexes and file manifests are plaintext data structures (arrays of
 * entries / the P0.3 `FileManifest`) that this module only wraps: it does
 * not interpret their contents. Both are AEAD-sealed under the workspace key
 * (WK) via `wrapKey`/`unwrapKey` (never a raw `aeadEncrypt` call), each under
 * its own AD domain (`adFolderIndex` / `adFileManifest`) so a ciphertext
 * sealed for one folder/file/version can never be silently substituted for
 * another.
 */
import type { FileManifest } from "./file.js";
export type RootManifestFields = {
    fmt: number;
    workspaceId: string;
    manifestVersion: number;
    prevRootHash: Uint8Array;
    folderMerkleRoot: Uint8Array;
    membershipHeadHash: Uint8Array;
    minClientVersion: number;
};
/** Ed25519-sign `adRootManifest(fields)` with the workspace's root-manifest signing key. */
export declare function signRootManifest(fields: RootManifestFields, signKey: Uint8Array): Promise<Uint8Array>;
/** Verify `sig` is a valid Ed25519 signature by `signerPubkey` over `adRootManifest(fields)`. */
export declare function verifyRootManifest(fields: RootManifestFields, sig: Uint8Array, signerPubkey: Uint8Array): Promise<boolean>;
/**
 * `sha256(adRootManifest(fields))` - the manifest's content-addressed
 * identity, used both as the next manifest's `prevRootHash` (chaining) and
 * as the `hash` a caller persists as "last seen" for `checkFreshness`.
 */
export declare function rootManifestHash(fields: RootManifestFields): Promise<Uint8Array>;
/** AEAD-wrap a plaintext folder index blob under `wk`, AD = `adFolderIndex(...)`. */
export declare function encryptFolderIndex(index: Uint8Array, wk: Uint8Array, fmt: number, workspaceId: string, folderId: string, indexVersion: number, wkVersion: number): Promise<Uint8Array>;
/** Reverse of `encryptFolderIndex`. Throws `Error("keys: unwrap failed")` on any failure. */
export declare function decryptFolderIndex(ciphertext: Uint8Array, wk: Uint8Array, fmt: number, workspaceId: string, folderId: string, indexVersion: number, wkVersion: number): Promise<Uint8Array>;
/**
 * Deterministic length-prefixed serialization of a `FileManifest` (fixed
 * field order): `fmt`/`version`/chunk-`plainLen` are written as raw 4-byte
 * `u32be` values, `totalSize` as a raw 8-byte `u64be` value (their width is
 * fixed, so no extra length prefix is needed); `workspaceId`/`fileId`/`dekId`
 * (UTF-8) and every `Uint8Array` field (`chunkId`/`nonce`/`plainHash`/
 * `merkleRoot`) are `u32be(len) ‖ bytes`. `chunks` is prefixed with its own
 * `u32be` count.
 *
 * Note: `totalSize` is `u64be`-encoded (up to `Number.MAX_SAFE_INTEGER`,
 * 2^53-1 bytes) so whole-file sizes are not capped at ~4 GiB - this product
 * targets large media. Per-chunk `plainLen` stays `u32be`: it is bounded by
 * the chunker's max chunk size (≤4 MiB, see `chunker.ts`'s `DEFAULTS.max`),
 * so 32 bits is safe there regardless of how large the whole file is. The
 * chunk-count and string-length prefixes also stay `u32be` - plenty of
 * headroom for counts/lengths that are never anywhere near 4 billion.
 */
export declare function serializeFileManifest(m: FileManifest): Uint8Array;
/** Reverse of `serializeFileManifest`. Throws `Error("manifests: malformed FileManifest")` on any truncation/overrun. */
export declare function deserializeFileManifest(bytes: Uint8Array): FileManifest;
/** `serializeFileManifest(m)` then AEAD-wrap under `wk`, AD = `adFileManifest(...)`. */
export declare function encryptFileManifest(m: FileManifest, wk: Uint8Array, fmt: number, workspaceId: string, fileId: string, version: number, parentFolderId: string, wkVersion: number): Promise<Uint8Array>;
/** Reverse of `encryptFileManifest`: `unwrapKey` then `deserializeFileManifest`. Throws `Error("keys: unwrap failed")` on any AEAD/AD failure. */
export declare function decryptFileManifest(ciphertext: Uint8Array, wk: Uint8Array, fmt: number, workspaceId: string, fileId: string, version: number, parentFolderId: string, wkVersion: number): Promise<FileManifest>;
/**
 * Detect rollback/fork of an incoming root manifest against a persisted
 * "last seen" `{version, hash}` (both are `rootManifestHash` outputs):
 *
 *  - `null` `lastSeen` (nothing persisted yet): always `"ok"`.
 *  - `incoming.version < lastSeen.version`: `"rollback"` - the server is
 *    serving an older manifest than one this client already observed.
 *  - `incoming.version === lastSeen.version` but `incoming.hash` differs
 *    from `lastSeen.hash`: `"fork"` - two different manifests claim the
 *    same version number (an equivocating/forking server or a signature
 *    replayed with tampered fields at the same version).
 *  - Otherwise advancing (`incoming.version > lastSeen.version`) but
 *    `incoming.prevHash` does not equal `lastSeen.hash`: `"fork"` - the
 *    chain link back to the last manifest this client saw is broken, so the
 *    incoming manifest cannot be this client's true next version.
 *  - Anything else: `"ok"`.
 */
export declare function checkFreshness(lastSeen: {
    version: number;
    hash: Uint8Array;
} | null, incoming: {
    version: number;
    hash: Uint8Array;
    prevHash: Uint8Array;
}): "ok" | "rollback" | "fork";
