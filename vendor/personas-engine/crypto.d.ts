import { type Batch } from './records.js';
export declare class PersonasKeyError extends Error {
    constructor(message: string);
}
export declare function newPersonasKey(): Promise<Uint8Array>;
export declare function sealPersonasKey(key: Uint8Array, userId: string, identityX25519Pub: Uint8Array): Promise<{
    enc: string;
    ct: string;
}>;
export declare function openPersonasKey(sealed: {
    enc: string;
    ct: string;
}, userId: string, identityX25519Priv: Uint8Array): Promise<Uint8Array>;
export declare function workspaceKey(personasKey: Uint8Array, userId: string, workspaceId: string): Promise<Uint8Array>;
export declare function sealBatch(wsKey: Uint8Array, userId: string, workspaceId: string, b: Batch): Promise<Uint8Array>;
export declare function openBatch(wsKey: Uint8Array, userId: string, workspaceId: string, bytes: Uint8Array): Promise<Batch>;
/** Seal a device's IndexState snapshot for its local cache: nonce(24) || ciphertext. */
export declare function sealSnapshot(wsKey: Uint8Array, userId: string, workspaceId: string, snapshot: Uint8Array): Promise<Uint8Array>;
export declare function openSnapshot(wsKey: Uint8Array, userId: string, workspaceId: string, bytes: Uint8Array): Promise<Uint8Array>;
/** Identifies one sealed personas key; a device compares it with the server's to notice a replaced key. */
export declare function sealedKeyFingerprint(sealed: {
    enc: string;
    ct: string;
}): Promise<Uint8Array>;
