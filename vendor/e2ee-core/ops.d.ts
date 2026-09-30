/**
 * Semantic op model for folder-state merge/rebase.
 *
 * `FolderState` is the current view of a folder: entry id -> Entry. `Op`s are
 * the pending mutations against that state - `put` upserts an entry by id,
 * `del` removes one. This module is pure logic (no crypto, no I/O): it
 * describes how ops compose, not how they're transported or authenticated.
 */
export type Entry = {
    id: string;
    name: string;
    kind: "file" | "folder";
    contentRef: string;
    meta: Record<string, string | number>;
    writerId: string;
    timestamp: number;
};
export type Op = {
    type: "put";
    entry: Entry;
} | {
    type: "del";
    id: string;
};
export type FolderState = Map<string, Entry>;
/** Apply ops to a COPY of state (pure). put upserts by entry.id; del removes by id. */
export declare function applyOps(state: FolderState, ops: Op[]): FolderState;
/**
 * Coalesce a pending-op log to the NET op per entry id, preserving first-touch order.
 * Multiple puts -> the last put. put...del -> del. del...put -> the last put.
 * (Whether a net "del" of a never-committed entry is a no-op is decided at apply/rebase
 * time against base - squash keeps the net del; applying a del for an absent id is harmless.)
 */
export declare function squashOps(ops: Op[]): Op[];
