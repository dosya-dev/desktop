export type Box = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export type Rec = {
    k: 'face';
    id: string;
    file: string;
    ver: number;
    box: Box;
    sig: string;
    score: number;
    at: number;
    dev: string;
    sortAt: number;
    folder: string | null;
} | {
    k: 'none';
    file: string;
    ver: number;
    at: number;
    dev: string;
    reason: 'no_faces' | 'unsupported' | 'failed';
} | {
    k: 'gone';
    file: string;
    at: number;
} | {
    k: 'persona';
    id: string;
    at: number;
} | {
    k: 'assign';
    face: string;
    persona: string | null;
    src: 'auto' | 'user';
    at: number;
} | {
    k: 'name';
    persona: string;
    name: string;
    at: number;
} | {
    k: 'cover';
    persona: string;
    face: string;
    at: number;
} | {
    k: 'not';
    face: string;
    persona: string;
    at: number;
} | {
    k: 'merge';
    into: string;
    from: string;
    at: number;
} | {
    k: 'drop';
    persona: string;
    at: number;
} | {
    k: 'tomb';
    file: string;
    box: Box;
    at: number;
} | {
    k: 'skip';
    folder: string;
    on: boolean;
    at: number;
};
export interface Batch {
    v: 1;
    recs: Rec[];
}
export declare class PersonasFormatError extends Error {
    constructor(message: string);
}
export declare function encodeBatch(b: Batch): Uint8Array;
export declare function decodeBatch(bytes: Uint8Array): Batch;
export declare function bytesToB64(b: Uint8Array): string;
/** Strict standard base64 (padded). Throws PersonasFormatError on anything else. */
export declare function b64ToBytes(s: string): Uint8Array;
export declare function encodeSig(v: Float32Array): string;
export declare function decodeSig(s: string): Float32Array;
