/**
 * Signed, hash-chained membership authorization log (spec §7).
 *
 * Every membership change (a user joining or leaving a workspace) is an
 * entry in an append-only log, each entry Ed25519-signed by the *actor* who
 * authorized it and hash-chained to the previous entry (`prevHash`), so the
 * full history can be replayed and its internal consistency checked by
 * anyone holding the log. IMPORTANT: internal consistency alone does NOT
 * prove the log is legitimate - `replayLog` will happily replay a fully
 * self-consistent log whose genesis entry was self-signed by an attacker
 * posing as founder. Without an out-of-band anchor there is nothing to stop
 * a caller being fed a forged-from-scratch log. Callers MUST either (a) pass
 * `expectedFounder` to `replayLog` so it verifies the genesis founder id and
 * pubkey against a trusted anchor, or (b) independently compare the returned
 * `founderId` (and the corresponding founder pubkey in `members`) against a
 * trusted out-of-band source before relying on the result. No trusted server
 * is required for replay itself, but a trusted founder identity is required
 * for the result to mean anything.
 *
 * Authorization model for P0 (intentionally simple - finer RBAC, e.g.
 * restricting `remove` to admins only, is a later phase): the genesis entry
 * must be self-signed by the founder; after that, ANY current member may
 * sign an `add` or `remove` entry. `replayLog` enforces this by looking up
 * the acting member's pubkey from the membership state *as of the previous
 * entry* - an actor who was removed only loses authorization for entries
 * strictly after their removal, and an actor who never joined (or was
 * already removed) can never get a later entry accepted. Note that an `add`
 * of a `subjectId` who is already a current member is accepted and simply
 * overwrites their stored pubkey (i.e. it doubles as a member-initiated
 * re-key) - this is intentional within the coarse P0 "any member may
 * add/remove" model, not a bug.
 *
 * `replayLog` validates the log it is given, but it has no notion of
 * freshness: silently dropping trailing entries yields a shorter log that is
 * still fully valid (a valid prefix is itself a valid log). `replayLog`
 * alone is therefore not rollback/truncation-proof; freshness must come from
 * elsewhere (the signed root manifest's `membershipHeadHash`, spec P0.4 Task
 * 4), by checking the replayed `headHash` against that anchor.
 */
export type MembershipOp = "add" | "remove";
export type MembershipEntry = {
    fmt: number;
    workspaceId: string;
    seq: number;
    prevHash: Uint8Array;
    op: MembershipOp | "genesis";
    subjectId: string;
    subjectPubkey: Uint8Array;
    actorId: string;
};
export type SignedEntry = {
    entry: MembershipEntry;
    actorSig: Uint8Array;
};
/**
 * Create the genesis entry for a new workspace's membership log: seq 0,
 * `op: "genesis"`, subject = actor = founder, `prevHash` = 32 zero bytes,
 * self-signed by `founderSignKey` over `adMembershipEntry(entry)`.
 */
export declare function genesisEntry(args: {
    fmt: number;
    workspaceId: string;
    founderId: string;
    founderPubkey: Uint8Array;
    founderSignKey: Uint8Array;
}): Promise<SignedEntry>;
/**
 * Append an `add`/`remove` entry after `prev`: `prevHash =
 * sha256(canonicalEntryBytes(prev.entry))`, `seq = prev.entry.seq + 1`,
 * signed by `actorSignKey` over `adMembershipEntry(entry)`.
 */
export declare function appendEntry(args: {
    prev: SignedEntry;
    op: MembershipOp;
    subjectId: string;
    subjectPubkey: Uint8Array;
    actorId: string;
    actorSignKey: Uint8Array;
}): Promise<SignedEntry>;
/** Verify `signed.actorSig` is a valid Ed25519 signature by `actorPubkey` over `adMembershipEntry(signed.entry)`. */
export declare function verifyEntry(signed: SignedEntry, actorPubkey: Uint8Array): Promise<boolean>;
/**
 * Replay a membership log from genesis, verifying at each entry that:
 *  (a) `seq` increments by exactly 1 from the previous entry (genesis is seq 0);
 *  (b) `prevHash` equals `sha256(canonicalEntryBytes(previousEntry))`;
 *  (c) the entry's signature is valid, by an authorized actor - the founder
 *      (self-signed) for genesis, or a CURRENT member (as of the previous
 *      entry) for `add`/`remove`;
 *  (d) `workspaceId` and `fmt` are identical to the genesis entry's, for every
 *      later entry (a valid member signature over a mismatched workspaceId/fmt
 *      is rejected - it can only mean entries from a different log were
 *      spliced in, since a genuine actor never signs across workspaces).
 * Applies each `add`/`remove` to the running member set in order - including
 * an `add` of an already-current member, which overwrites their stored
 * pubkey (see module docstring). Throws `Error("membership: invalid log at
 * seq N")` - naming the first entry that breaks any rule - on any violation.
 *
 * If `expectedFounder` is provided, the genesis entry's `subjectId` and
 * `subjectPubkey` are additionally checked against it and `Error("membership:
 * founder anchor mismatch")` is thrown on mismatch - this is what turns
 * "internally consistent" into "actually this workspace's log" (see module
 * docstring). When omitted, genesis is accepted self-signed with no
 * external anchor, exactly as before.
 */
export declare function replayLog(entries: SignedEntry[], expectedFounder?: {
    id: string;
    pubkey: Uint8Array;
}): Promise<{
    members: Map<string, string>;
    headHash: Uint8Array;
    founderId: string;
}>;
