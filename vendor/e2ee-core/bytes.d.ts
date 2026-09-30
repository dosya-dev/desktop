export declare function toHex(b: Uint8Array): string;
export declare function fromHex(s: string): Uint8Array;
export declare function toB64(b: Uint8Array): string;
export declare function fromB64(s: string): Uint8Array;
export declare function utf8(s: string): Uint8Array;
export declare function fromUtf8(b: Uint8Array): string;
export declare function concat(...parts: Uint8Array[]): Uint8Array;
export declare function u32be(n: number): Uint8Array;
/**
 * 8-byte big-endian encoding of a JS number up to `Number.MAX_SAFE_INTEGER`
 * (2^53-1). Avoids BigInt: split into a high/low 32-bit word pair via
 * `Math.floor(n / 2**32)` / `n - high*2**32` (both exact for any safe
 * integer, since `high <= 2^21-1` keeps `high*2**32` within the 53-bit
 * mantissa), then big-endian-encode each word like `u32be`.
 */
export declare function u64be(n: number): Uint8Array;
export declare function eq(a: Uint8Array, b: Uint8Array): boolean;
