/**
 * The public type of the shim.
 *
 * It is STRUCTURAL on purpose: no `SubtleCrypto`/`CryptoKey` from the DOM
 * lib (the tsconfig's `lib` is `ES2023`, no `dom`), and no Node webcrypto
 * types either, because the emitted `subtle-shim.d.ts` is vendored verbatim
 * into apps/web today and into the mobile app in phase 2 - a type import of
 * Node's crypto module there would pull `@types/node`, which this package
 * does not depend on, into every consumer's typecheck.
 *
 * `ArrayBufferView | ArrayBuffer` stands in for `BufferSource` for the same
 * reason: both halves are ES-lib types. Callers that need to hand the shim
 * to an API typed against real WebCrypto make the cast at the install site
 * (`subtle: createMinimalSubtle() as unknown as SubtleCrypto`), where it is
 * visible, rather than having this file pretend to BE WebCrypto.
 */
export type MinimalSubtleKey = {
    readonly __brand: "MinimalSubtleKey";
};
export interface MinimalSubtle {
    digest(algorithm: string | {
        name: string;
    }, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
    importKey(format: string, keyData: ArrayBufferView | ArrayBuffer, algorithm: string | {
        name: string;
        hash?: string | {
            name: string;
        };
    }, extractable?: boolean, keyUsages?: readonly string[]): Promise<MinimalSubtleKey>;
    sign(algorithm: string | {
        name: string;
    }, key: MinimalSubtleKey, data: ArrayBufferView | ArrayBuffer): Promise<ArrayBuffer>;
    deriveBits(algorithm: {
        name: string;
        hash?: string | {
            name: string;
        };
        salt?: ArrayBufferView | ArrayBuffer;
        info?: ArrayBufferView | ArrayBuffer;
    }, key: MinimalSubtleKey, length: number): Promise<ArrayBuffer>;
}
export declare function createMinimalSubtle(): MinimalSubtle;
