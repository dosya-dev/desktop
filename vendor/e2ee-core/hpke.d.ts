export type HpkeKeyPair = {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
};
export declare function generateHpkeKeyPair(): Promise<HpkeKeyPair>;
export declare function hpkeSeal(recipientPublicKey: Uint8Array, info: Uint8Array, plaintext: Uint8Array, aad?: Uint8Array): Promise<{
    enc: Uint8Array;
    ciphertext: Uint8Array;
}>;
export declare function hpkeOpen(recipientPrivateKey: Uint8Array, enc: Uint8Array, info: Uint8Array, ciphertext: Uint8Array, aad?: Uint8Array): Promise<Uint8Array>;
