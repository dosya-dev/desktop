/**
 * The crypto primitive backend.
 *
 * Everything in this package that touches a key or a byte of content goes
 * through ONE of these. The default is libsodium-wrappers (WASM) - what the
 * web app, Node and the worker harness have always used - loaded lazily on
 * first use so a runtime that cannot run WASM (React Native's Hermes) never
 * evaluates it. Such a runtime calls `setCryptoBackend` at boot with native
 * implementations (react-native-libsodium + expo-crypto) BEFORE any other
 * export of this package is used.
 *
 * The interface is deliberately the exact set of primitives this package
 * calls, nothing more, so a port has a short, testable checklist:
 * `runBackendSelfTest` (backend-selftest.ts) must report every case ok. It
 * exercises every method here - including the negative cases where failing
 * closed is the point - and appends the interop vectors (`runVectors`), so
 * that one call covers both the byte-for-byte answers and the behaviour.
 *
 * Synchronous where libsodium is synchronous. `sha256` and `pwhash` are async
 * because native ports run them off the JS thread.
 */
export type Argon2Params = {
    opslimit: number;
    memlimit: number;
};
export type Argon2Tiers = {
    interactive: Argon2Params;
    moderate: Argon2Params;
    sensitive: Argon2Params;
};
export type BackendKeyPair = {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
};
/**
 * BUFFER CONTRACT (binding on every implementation)
 *
 * Every `Uint8Array` input MAY be a VIEW into a larger buffer with a
 * non-zero `byteOffset` - this package hands out `subarray`s of a file
 * buffer all along the chunking path - so an implementation must read
 * exactly `[byteOffset, byteOffset + byteLength)` and never the whole
 * `.buffer`. It must never mutate, detach or transfer an input, and two
 * calls may be in flight concurrently over the same view.
 *
 * Every returned `Uint8Array` must be a FRESH buffer owned by the caller,
 * never a view into native or pooled memory that a later call can
 * overwrite.
 *
 * Failure is signalled one way only: `aeadDecrypt` THROWS and `verify`
 * returns `false` - never `null`, `undefined` or an empty array, which a
 * caller would otherwise have to tell apart from a genuinely empty
 * plaintext. `runBackendSelfTest` checks all of this.
 */
export interface CryptoBackend {
    /** Short identifier for diagnostics ("libsodium-wasm", "react-native-libsodium"). */
    readonly name: string;
    /** Argon2id cost tiers - libsodium's fixed constants (see backend-sodium.ts for the numbers). */
    readonly argon2Tiers: Argon2Tiers;
    randomBytes(n: number): Uint8Array;
    sha256(data: Uint8Array): Promise<Uint8Array>;
    /** XChaCha20-Poly1305 (IETF): 32-byte key, 24-byte nonce, returns ciphertext ‖ 16-byte tag. */
    aeadEncrypt(key: Uint8Array, nonce: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Uint8Array;
    /** Throws (any error) on authentication failure; the wrapper in aead.ts maps it to "aead: decryption failed". */
    aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Uint8Array;
    /** Argon2id (libsodium ALG_ARGON2ID13). */
    pwhash(outLen: number, password: Uint8Array, salt: Uint8Array, opslimit: number, memlimit: number): Promise<Uint8Array>;
    /** Ed25519. `privateKey` is libsodium's 64-byte secret key (seed ‖ public). */
    signKeyPair(): BackendKeyPair;
    signKeyPairFromSeed(seed32: Uint8Array): BackendKeyPair;
    sign(message: Uint8Array, privateKey: Uint8Array): Uint8Array;
    /** May throw on malformed input; the wrapper in sign.ts maps a throw to `false`. */
    verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean;
}
/**
 * Install a backend for this process. Call once, at boot, before any other
 * export of this package runs. Installing the same instance again is a
 * no-op; a different instance, or any instance after the default backend
 * has started loading, throws - two backends in one process is never what
 * anyone meant.
 */
export declare function setCryptoBackend(backend: CryptoBackend): void;
/** The installed backend, or the lazily-loaded libsodium WASM default. */
export declare function getCryptoBackend(): Promise<CryptoBackend>;
/** Test seam only: forget the installed/default backend so the next call starts fresh. */
export declare function __resetCryptoBackendForTests(): void;
