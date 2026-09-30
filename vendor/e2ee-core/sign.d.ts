export type SignKeyPair = {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
};
export declare function generateSignKeyPair(): Promise<SignKeyPair>;
export declare function signKeyPairFromSeed(seed32: Uint8Array): Promise<SignKeyPair>;
export declare function sign(message: Uint8Array, privateKey: Uint8Array): Promise<Uint8Array>;
export declare function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): Promise<boolean>;
