/**
 * Envelope key-wrapping + the per-user identity bundle (spec §5.4, §5.8).
 *
 * `wrapKey`/`unwrapKey` are a thin, generic AEAD envelope: the wrapped blob
 * is self-contained (`nonce ‖ ciphertext`, `aead.ts`'s 24-byte XChaCha20
 * nonce first) so callers never have to track nonces separately. Every
 * higher-level wrap in this module (and the workspace/DEK/grant wraps in
 * later tasks) is built on these two functions plus the appropriate `ad*`
 * builder for domain separation - never a raw `aeadEncrypt` call.
 *
 * The per-user identity bundle is the X25519 (HPKE) + Ed25519 (signing)
 * keypair pair that anchors a user's E2EE identity. It is wrapped two ways:
 *   - under a KEK = Argon2id(hardenedSecret, salt) - `hardenedSecret` is the
 *     VOPRF-hardened output of the user's passphrase (P1, `oprf-client.ts`),
 *     never the raw passphrase itself;
 *   - under a key derived from a random 32-byte recovery code, for the
 *     "lost my password" path.
 * Both wraps AEAD-encrypt the SAME serialized bundle bytes but under
 * different keys and AD `source` tags ("passphrase" vs "recovery"), so a
 * blob wrapped one way can never be unwrapped via the other path even if the
 * derived keys happened to collide.
 */
/** AEAD-wrap `key` under `wrappingKey`/`ad`; returns the self-contained `nonce ‖ ciphertext`. */
export declare function wrapKey(key: Uint8Array, wrappingKey: Uint8Array, ad: Uint8Array): Promise<Uint8Array>;
/** Reverse of `wrapKey`. Throws `Error("keys: unwrap failed")` on any auth/AD/key/length failure. */
export declare function unwrapKey(wrapped: Uint8Array, wrappingKey: Uint8Array, ad: Uint8Array): Promise<Uint8Array>;
/**
 * KEK = Argon2id(hardenedSecret, salt). `hardenedSecret` is the VOPRF
 * output (from `oprf-client.ts`), NOT the raw passphrase. Defaults to the
 * `interactive` tier; real per-platform tiers are benchmarked in P1.
 */
export declare function deriveKEK(hardenedSecret: Uint8Array, salt: Uint8Array, tier?: "interactive" | "moderate" | "sensitive"): Promise<Uint8Array>;
export type IdentityBundle = {
    x25519: {
        publicKey: Uint8Array;
        privateKey: Uint8Array;
    };
    ed25519: {
        publicKey: Uint8Array;
        privateKey: Uint8Array;
    };
};
/** Fresh X25519 (HPKE) + Ed25519 (signing) keypair pair for a new user identity. */
export declare function generateIdentityBundle(): Promise<IdentityBundle>;
/** AEAD-wrap the bundle under `kek`, AD = adUserKeys({fmt, userId, source: "passphrase"}). */
export declare function wrapIdentityBundle(bundle: IdentityBundle, kek: Uint8Array, fmt: number, userId: string): Promise<Uint8Array>;
/** Reverse of `wrapIdentityBundle`. Throws `Error("keys: unwrap failed")` on any failure. */
export declare function unwrapIdentityBundle(wrapped: Uint8Array, kek: Uint8Array, fmt: number, userId: string): Promise<IdentityBundle>;
/** 32 random bytes: the user's recovery code (shown once, stored by the user). */
export declare function generateRecoveryKey(): Promise<Uint8Array>;
/**
 * Recovery variant of `wrapIdentityBundle`: wrapping key =
 * Argon2id(recoveryKey, salt, interactive), AD source = "recovery".
 */
export declare function wrapIdentityBundleForRecovery(bundle: IdentityBundle, recoveryKey: Uint8Array, salt: Uint8Array, fmt: number, userId: string): Promise<Uint8Array>;
/** Reverse of `wrapIdentityBundleForRecovery`. Throws `Error("keys: unwrap failed")` on any failure. */
export declare function unwrapIdentityBundleForRecovery(wrapped: Uint8Array, recoveryKey: Uint8Array, salt: Uint8Array, fmt: number, userId: string): Promise<IdentityBundle>;
