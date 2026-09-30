export declare const AEAD_KEYBYTES = 32;
export declare const AEAD_NPUBBYTES = 24;
/**
 * The Poly1305 tag XChaCha20-Poly1305 (IETF) appends to every ciphertext -
 * libsodium's crypto_aead_xchacha20poly1305_ietf_ABYTES. The nonce is NOT part
 * of the ciphertext (it travels in the manifest), so a sealed chunk weighs
 * exactly plaintext + AEAD_ABYTES.
 */
export declare const AEAD_ABYTES = 16;
export declare function aeadEncrypt(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array, nonce?: Uint8Array): Promise<{
    nonce: Uint8Array;
    ciphertext: Uint8Array;
}>;
export declare function aeadDecrypt(key: Uint8Array, nonce: Uint8Array, ciphertext: Uint8Array, ad: Uint8Array): Promise<Uint8Array>;
