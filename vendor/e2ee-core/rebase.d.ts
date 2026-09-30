/**
 * 3-way rebase/merge of a client's squashed pending ops onto the current
 * remote folder-index head (spec §9).
 *
 * `rebase` starts from a copy of `remote` and folds in each local op,
 * comparing against `base` (the state the local ops were made against) to
 * tell "remote didn't touch this" apart from "remote also changed this" -
 * disjoint changes auto-merge, and any overlap is resolved without ever
 * dropping a user edit:
 *   - content edit-vs-edit -> keep both, as a conflicted-copy entry
 *   - rename/metadata-only edit-vs-edit -> deterministic last-writer-wins
 *   - delete-vs-edit (either direction) -> keep the edit (resurrect if the
 *     edit was local and remote deleted it)
 *   - a brand-new local entry whose name collides with an existing one ->
 *     keep both, renaming the incoming one to a conflict name
 *
 * This module is pure logic (no crypto, no I/O, no clock/RNG): `timestamp`s
 * are client-asserted (§9, accepted), and conflicted-copy ids come from the
 * injected `makeConflictId()` so callers control id allocation and tests get
 * determinism.
 */
import type { FolderState, Op } from "./ops.js";
export type ConflictKind = "conflicted-copy" | "lww-remote-wins" | "lww-local-wins" | "delete-edit";
export type Conflict = {
    kind: ConflictKind;
    id: string;
    name: string;
    detail?: string;
};
export type RebaseResult = {
    merged: FolderState;
    conflicts: Conflict[];
};
/**
 * 3-way merge of squashed local ops onto the current remote head. Starts
 * from a copy of `remote` and folds in each local op per the rules above.
 * Never mutates `base`, `remote`, or `localOps`. NEVER loses data: every
 * conflict resolves by keeping both sides (a conflicted-copy entry) or a
 * deterministic tiebreak, never by dropping an edit.
 */
export declare function rebase(args: {
    base: FolderState;
    remote: FolderState;
    localOps: Op[];
    makeConflictId: () => string;
}): RebaseResult;
