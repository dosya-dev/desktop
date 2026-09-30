/**
 * Workspace key (WK), data-encryption keys (DEKs), and member grants
 * (spec §5.4 key hierarchy, §7 grants).
 *
 * The workspace key is the root symmetric key for a workspace: every DEK
 * (one per file, per the P0.3 chunk/file model) is wrapped under it via
 * `wrapDek`/`unwrapDek`, and the folder index / file manifest / root
 * manifest (Task 4) are encrypted or bound to it too. Access to a workspace
 * is extended to a member by HPKE-sealing the WK to their X25519 public key
 * - see `sealGrant`/`openGrant` below - never by re-deriving or re-sending
 * the WK in the clear.
 *
 * Every wrap here reuses `wrapKey`/`unwrapKey` from `./keys.js` (never a raw
 * `aeadEncrypt` call), each under its own AD domain for separation.
 */
/** 32 random bytes: a fresh workspace key (WK), the root symmetric key for a workspace. */
export declare function generateWorkspaceKey(): Promise<Uint8Array>;
export type Dek = {
    dek: Uint8Array;
    dekId: string;
};
/**
 * Fresh 32-byte DEK plus a content-derived `dekId = hex(sha256(dek))`.
 *
 * Chosen over an independently-random id so the id is a pure function of
 * the key bytes: anyone holding the raw DEK can recompute/verify its id
 * without extra state, and two DEKs can never end up with the same id
 * unless they're the same key (collision-resistant via SHA-256), which
 * also makes accidental DEK reuse across files detectable.
 */
export declare function generateDek(): Promise<Dek>;
/** AEAD-wrap `dek` under the workspace key `wk` (via the generic `wrapKey` envelope). */
export declare function wrapDek(dek: Uint8Array, wk: Uint8Array, fmt: number, workspaceId: string, wkVersion: number): Promise<Uint8Array>;
/** Reverse of `wrapDek`. Throws `Error("keys: unwrap failed")` (from `unwrapKey`) on any failure. */
export declare function unwrapDek(wrapped: Uint8Array, wk: Uint8Array, fmt: number, workspaceId: string, wkVersion: number): Promise<Uint8Array>;
export type Grant = {
    sealed: {
        enc: Uint8Array;
        ciphertext: Uint8Array;
    };
    granterSig: Uint8Array;
};
/**
 * Grant workspace access to `granteeId`: HPKE-seal `wk` to their X25519
 * public key with `info = adGrant(...)`, and separately Ed25519-sign that
 * SAME AD bytes with the granter's signing key. The signature lets a
 * recipient (or an auditor) verify *who* authorized the grant and *for
 * whom*, independent of - and checked before - attempting to open the
 * HPKE seal itself.
 */
export declare function sealGrant(args: {
    wk: Uint8Array;
    fmt: number;
    workspaceId: string;
    wkVersion: number;
    granteeId: string;
    granteePubkey: Uint8Array;
    granterId: string;
    granterSignKey: Uint8Array;
}): Promise<Grant>;
/**
 * Reverse of `sealGrant`. Verifies `granterSig` over `adGrant(...)` FIRST -
 * throwing `Error("grant: signature invalid")` if it doesn't check out -
 * and only then HPKE-opens `sealed` with the recipient's X25519 private
 * key, throwing `Error("grant: open failed")` on any HPKE failure (wrong
 * recipient key, tampered ciphertext, or any AD field mismatch - e.g. a
 * spoofed `granteeId`/`granterId`/`wkVersion` relative to what was sealed).
 *
 * Note that because `granterSig` covers the exact same AD bytes used as the
 * HPKE `info`, tampering with any AD field (including `granteeId`) is
 * already caught by the signature check, before HPKE is even attempted.
 */
export declare function openGrant(args: {
    grant: Grant;
    fmt: number;
    workspaceId: string;
    wkVersion: number;
    granteeId: string;
    granteePubkey: Uint8Array;
    granterId: string;
    granterSignPubkey: Uint8Array;
    recipientPrivkey: Uint8Array;
}): Promise<Uint8Array>;
