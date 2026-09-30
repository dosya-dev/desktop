export type ADField = Uint8Array | string | number;
/**
 * Encode `domain` + fields as `u32be(len)‖bytes` per field (domain first).
 *
 * Injectivity precondition: this length-prefixed encoding is only guaranteed
 * to be unambiguous (no two distinct `(domain, fields)` inputs collide) when
 * every field *position* has a FIXED arity (the same number of fields, in
 * the same order, every call) and a FIXED type per position, as all seven
 * `ad*` builders below guarantee by construction. If a field's arity or type
 * were ever variable or attacker-influenced (e.g. a caller-chosen mix of
 * strings/numbers/bytes at a given position, or a variable-length field
 * list), two different logical inputs could serialize to the identical byte
 * string, defeating the domain separation this AD is meant to provide.
 */
export declare function encodeAD(domain: string, fields: ADField[]): Uint8Array;
export declare const adChunk: (a: {
    fmt: number;
    workspaceId: string;
    dekId: string;
}) => Uint8Array<ArrayBufferLike>;
export declare const adFileManifest: (a: {
    fmt: number;
    workspaceId: string;
    fileId: string;
    version: number;
    parentFolderId: string;
    wkVersion: number;
}) => Uint8Array<ArrayBufferLike>;
export declare const adFolderIndex: (a: {
    fmt: number;
    workspaceId: string;
    folderId: string;
    indexVersion: number;
    wkVersion: number;
}) => Uint8Array<ArrayBufferLike>;
export declare const adRootManifest: (a: {
    fmt: number;
    workspaceId: string;
    manifestVersion: number;
    prevRootHash: Uint8Array;
    folderMerkleRoot: Uint8Array;
    membershipHeadHash: Uint8Array;
    minClientVersion: number;
}) => Uint8Array<ArrayBufferLike>;
export declare const adGrant: (a: {
    fmt: number;
    workspaceId: string;
    wkVersion: number;
    granteeId: string;
    granteePubkey: Uint8Array;
    granterId: string;
}) => Uint8Array<ArrayBufferLike>;
export declare const adMembershipEntry: (a: {
    fmt: number;
    workspaceId: string;
    seq: number;
    prevEntryHash: Uint8Array;
    op: string;
    subjectId: string;
    subjectPubkey: Uint8Array;
    actorId: string;
}) => Uint8Array<ArrayBufferLike>;
export declare const adUserKeys: (a: {
    fmt: number;
    userId: string;
    source: "passphrase" | "recovery";
}) => Uint8Array<ArrayBufferLike>;
