import { type Batch, type Box } from './records.js';
export interface FaceRow {
    id: string;
    file: string;
    ver: number;
    box: Box;
    sig: Float32Array;
    /** Detection score; picks a persona's cover when the current one leaves. */
    score: number;
    sortAt: number;
    folder: string | null;
    persona: string | null;
    userAssigned: boolean;
}
export interface PersonaRow {
    id: string;
    name: string | null;
    cover: string | null;
    faces: Set<string>;
    notFaces: Set<string>;
    at: number;
}
export declare class IndexState {
    /** Highest journal seq applied. */
    applied: number;
    /** Insertion order is journal order: the newest face is the last entry. */
    faces: Map<string, FaceRow>;
    personas: Map<string, PersonaRow>;
    /** file -> version that has a face/none record. */
    read: Map<string, number>;
    /** file -> positions removed with Remove person; never grouped again. */
    tombs: Map<string, Box[]>;
    /** Folder ids the user skipped. */
    skipped: Set<string>;
    /**
     * New faces that went to the pool since the last clustering pass (the
     * server's pool_new). Device-local: only grouping.ts reads and writes it,
     * replay never does; it is kept in the snapshot.
     */
    poolNew: number;
    /** file -> face ids; derived, rebuilt on restore. */
    private byFile;
    /**
     * Apply one decoded batch. A seq at or below `applied` is ignored. Never
     * throws on a batch that decodeBatch accepted: records naming unknown faces
     * or personas are no-ops.
     */
    apply(seq: number, b: Batch): void;
    private applyRec;
    /**
     * Whether a face/none record for (file, ver) applies. First batch wins: a
     * version already read in an earlier seq at or above `ver` ignores it. A
     * higher version clears the file's older faces first.
     */
    private claimRead;
    private removeFileFaces;
    private deleteFace;
    /** Take the face out of its persona; fix the cover; drop an emptied unnamed persona unless `prune` is false. */
    private unassign;
    /** The best-scored face left (ties: lowest id), or null. */
    private bestFace;
    /** A persona with no faces is deleted unless it has a name (the server's R29 behaviour). */
    private pruneIfEmpty;
    snapshot(): Uint8Array;
    static restore(bytes: Uint8Array): IndexState;
}
