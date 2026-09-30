/**
 * Personal encrypted workspace: the root manifest (sign/verify/chain), the
 * folder index (encrypt/decrypt/serialize), and the §9 optimistic-commit/
 * rebase loop. Composes e2ee-core's primitives against the injected
 * `ApiClient` - never re-implements any crypto here.
 *
 * Personal scope (P1b, single member): the root manifest is signed by the
 * user's OWN Ed25519 identity key and there is no membership log yet (that
 * lands in P2) - `membershipHeadHash` is a fixed personal anchor derived
 * from the owner's own pubkey (see `personalMembershipHeadHash`) rather than
 * a log tip. The workspace key (WK) is generated client-side and kept ONLY
 * in the in-memory `Workspace` returned here - it never reaches the server,
 * and new-device WK sync is a documented follow-up (no P1a endpoint for it
 * yet, same caveat as the plan's Global Constraints).
 */
import { type Op, type FolderState, type RootManifestFields, type Conflict } from "@dosya-dev/e2ee-core";
import type { ApiClient, CommitBody } from "./api.js";
import type { Session } from "./session.js";
export type Workspace = {
    workspaceId: string;
    wk: Uint8Array;
    wkVersion: number;
    /**
     * §6 rollback/fork high-water mark: the `(version, hash)` of the most
     * recent root manifest this `Workspace` has verified (via
     * `getVerifiedHead`, from a real read OR its own successful commit).
     * `undefined` until the first head is ever seen -- e2ee-core's
     * `checkFreshness` treats a `null` `lastSeen` as "nothing observed yet,
     * anything is acceptable" (trust-on-first-use), which is exactly the
     * `undefined` state here.
     *
     * IN-MEMORY ONLY for P1b: this field resets every time a fresh
     * `Workspace` is constructed (`createWorkspace` or a future
     * `openWorkspace`/resume path), so it only protects reads made *within*
     * one running session. A real client MUST persist `lastSeen` durably
     * across sessions (disk/localStorage/keychain, keyed by `workspaceId`) --
     * that is the CALLER's responsibility, not this engine's. Without durable
     * persistence, every fresh session is fresh-device trust-on-first-use: a
     * server that rolls a workspace back between sessions (rather than
     * mid-session) goes undetected because there is no prior `lastSeen` to
     * compare the rolled-back head against.
     */
    lastSeen?: {
        version: number;
        hash: Uint8Array;
    };
    /**
     * Whether THIS session's own identity is the workspace's founder - an
     * ordinary `createWorkspace` call (always `true`, hard-set in-process,
     * since the creator just created it), or an `openWorkspace` re-open where
     * the CALLER explicitly asserts founder status via `opts.selfFounded`.
     *
     * This is the P2b-log security crux (spec §7;
     * docs/superpowers/plans/2026-07-27-e2ee-p2b-membership-log.md's Global
     * Constraints): when `true`, `getVerifiedHead` HARD-anchors the signed
     * membership log's replay to THIS session's own key as founder -
     * `replayLog` throws `"membership: founder anchor mismatch"` if the server
     * ever serves a log founded by a DIFFERENT identity, so a malicious server
     * cannot forge a self-founded workspace's history from scratch and have it
     * accepted.
     *
     * CRITICAL: this value MUST NOT be derived from anything the server
     * returns (a grant row, a `granterEd25519Pub` column, a head, a log entry
     * - none of it). A previous version of this engine derived it from the
     * stored self-grant's server-controlled `granterEd25519Pub` field, which
     * let a malicious server simply stamp a DIFFERENT (attacker) key onto that
     * column to make a self-founded workspace look like an ordinary cross-user
     * grant - downgrading `selfFounded` to `false`, dropping the hard anchor,
     * and getting a wholly forged workspace (attacker-founded log + attacker-
     * signed root) accepted. That heuristic has been REMOVED. The only
     * trustworthy source for "did I create this workspace myself" is the
     * CALLER's OWN out-of-band, locally-persisted record of workspaces it
     * created (e.g. the web store's `workspaces` list, populated only by
     * `createWorkspace`) - never anything fetched from the network in the
     * course of opening the workspace.
     *
     * When `false` (the default for `openWorkspace` - either a genuine
     * cross-user grant, or simply a caller that hasn't asserted founder
     * status), replay is NOT hard-anchored - the log's founder is trusted on
     * first use (TOFU, spec §11). This is a SAFE baseline (it never trusts a
     * server-controlled value to decide whether to drop its own guard), but it
     * is NOT a strengthening of security over the hard anchor: TOFU still does
     * not protect against a server that was ALREADY malicious before this
     * session's very first open of the workspace (closing that needs Key
     * Transparency, deferred to a later phase). A caller that KNOWS (from its
     * own persisted state, not from the server) that it founded this
     * workspace MUST pass `{ selfFounded: true }` to actually get the
     * unforgeable hard anchor - see `openWorkspace`'s doc comment.
     */
    selfFounded: boolean;
};
/**
 * The longest Space name this engine will store.
 *
 * A bound is not cosmetic here: the root index is fetched and parsed by every
 * device that opens the Space, so an unbounded name is a cost every reader
 * pays forever. 100 is far past any label a person types and far short of
 * anything that matters in a payload.
 */
export declare const MAX_SPACE_NAME_LENGTH = 100;
/**
 * The one transformation applied to a Space name, on the way in AND on the
 * way out: NFC, invisible characters removed, whitespace collapsed and
 * trimmed, length bounded. Nothing here changes what a name LOOKS like.
 *
 * It runs on READ as well as on write because a name read back arrived from
 * another device and is about to be rendered: a client that stored a name
 * this engine would refuse is not a reason to show it.
 *
 * Returns `null` for a name with nothing visible left in it, which is the
 * same state as a Space that was never named.
 */
export declare function normaliseSpaceName(raw: string): string | null;
/** Reverse of `encodeSignedRoot` - exported so callers/tests can independently `verifyRootManifest` a fetched head. */
export declare function decodeSignedRoot(signedRoot: string): {
    fields: RootManifestFields;
    sig: Uint8Array;
};
/**
 * Create a fresh personal workspace: generate the workspace key (WK)
 * client-side (it is returned in-memory here and NEVER sent to the server),
 * write an empty signed root at version 1 (an empty "root" folder index
 * encrypted under WK), and commit it with `expectedPrev: null`.
 */
export declare function createWorkspace(api: ApiClient, session: Session, workspaceId: string, opts?: {
    name?: string;
}): Promise<Workspace>;
/**
 * Re-open a personal workspace this identity already created: fetch the
 * self-grant `createWorkspace` stored, HPKE-open it (reflexive -- grantee
 * and granter are both this session's own identity) to recover the
 * workspace key, and reconstruct a fresh in-memory `Workspace` for it.
 *
 * Throws `Error("e2ee: openWorkspace: no stored key for this workspace")` if
 * this identity never stored a grant for `workspaceId` (never created it, a
 * different identity owns it, or `createWorkspace`'s post-commit grant store
 * failed -- see that function's doc comment). Otherwise propagates
 * `openGrant`'s own failure modes verbatim (`"grant: signature invalid"` /
 * `"grant: open failed"`) if the stored grant is malformed or tampered --
 * this function does not wrap or reinterpret those.
 *
 * Seeds `ws.lastSeen` (the §6 rollback/fork high-water mark) from the
 * workspace's CURRENT verified head via the shared `getVerifiedHead` --
 * exactly like `createWorkspace` seeds it from its own genesis write, this
 * is a fresh `Workspace`, so it starts with no high-water mark until this
 * read establishes one. `getVerifiedHead` itself mutates `lastSeen` as its
 * documented side effect (trust-on-first-use for a fresh `Workspace`, since
 * `ws.lastSeen` is `undefined` here) and returns `null` for a headless
 * workspace (nothing to seed from) -- either way, no further action is
 * needed after the call.
 *
 * P2b Task 2: the GRANTER is no longer assumed to be this session's own
 * identity -- it's derived from the stored grant's `granterEd25519Pub`
 * (P1b.2a self-grants predate that column and may still have it NULL, which
 * means "granter == self", preserving the old behavior exactly). This is
 * what makes a cross-user grant (P2b Task 3: a DIFFERENT member sealed the
 * WK to this identity) openable here too -- the recipient side
 * (`granteeId`/`granteePubkey`/`recipientPrivkey`) is always this session's
 * own keys regardless of who granted it. Note this is ONLY used to select
 * the right verification key for `openGrant`'s HPKE seal -- it is NEVER used
 * to derive `Workspace.selfFounded` (see below and that field's doc
 * comment): a server-controlled column must never decide whether the hard
 * founder anchor applies.
 *
 * P2b-log Task 2 fix (closes a CRITICAL forge vector): `Workspace.selfFounded`
 * is now taken VERBATIM from `opts.selfFounded`, defaulting to `false`, and is
 * NEVER derived from the stored grant's `granterEd25519Pub` column. The
 * REMOVED prior heuristic (`selfFounded = !stored.granterEd25519Pub ||
 * stored.granterEd25519Pub === selfPubHex`) trusted a value the server fully
 * controls -- a malicious server could stamp an ATTACKER key onto that
 * column for a workspace this identity actually founded, making
 * `openWorkspace` compute `selfFounded: false`, dropping the hard anchor in
 * `getVerifiedHead`, and falling back to TOFU on an attacker-forged log +
 * root (a wholly forged workspace, accepted every session). Removing the
 * derivation removes the vector entirely: there is no server response this
 * function reads that can influence `selfFounded` at all.
 *
 * The default (`opts` omitted, or `opts.selfFounded` omitted) is `false` --
 * a SAFE trust-on-first-use baseline (spec §11), never a value that widens
 * trust based on server input. A caller that independently KNOWS (from its
 * own locally-persisted "I created this workspace" record -- e.g. the web
 * store's `workspaces` list, populated only by `createWorkspace`, never by
 * anything the server returns when opening) that this identity founded
 * `workspaceId` MUST pass `{ selfFounded: true }` to get the unforgeable
 * hard anchor. Getting this wrong in the unsafe direction (asserting
 * `true` for a workspace this identity did NOT actually found) makes a
 * legitimate cross-user grant reject with "founder anchor mismatch" --
 * a loud, safe failure, never a silent forgery.
 */
export declare function openWorkspace(api: ApiClient, session: Session, workspaceId: string, opts?: {
    selfFounded?: boolean;
}): Promise<Workspace>;
/**
 * Grant another user access to this workspace (P2b Task 3 - the payoff of
 * cross-user sharing): look `granteeEmail` up in the public-key directory
 * (Task 1), HPKE-seal `ws.wk` to their authenticated X25519 key + sign with
 * this session's OWN Ed25519 key (`sealGrant` - e2ee-core, unchanged), then
 * (P2b-log Task 3) append a signed `add` entry to the workspace's SIGNED
 * MEMBERSHIP LOG (spec §7, e2ee-core's `appendEntry`) naming the grantee as
 * a new member, and persist all of it - the sealed grant under their
 * account id, the membership projection row, AND the log entry - atomically
 * server-side (`grant-member`).
 *
 * `granteeId` fed to `sealGrant` is `dir.ed25519Pub` - already hex (the
 * directory returns keys in the SAME encoding `setupIdentity` stored them
 * in, via `toHex`) - matching exactly what the grantee's own `openWorkspace`
 * computes as ITS `granteeId` (`toHex(session.identity.ed25519.publicKey)`
 * of their own session). `granteePubkey` is decoded via `fromHex` for the
 * same reason. The stored `granterEd25519Pub` is this session's own
 * ed25519 pubkey (hex) - what the grantee's `openWorkspace` uses to derive
 * `granterId`/verify the grant's signature, per P2b Task 2.
 *
 * The APPENDED LOG ENTRY's `subjectId`/`subjectPubkey` are ALSO `dir.ed25519Pub`
 * (decoded) - the grantee's ed25519 SIGNING key, the SAME key `sealGrant`
 * used as `granteeId` above. This is the multi-writer crux: `getVerifiedHead`
 * accepts a root iff it verifies against SOME member's key in `replayLog`'s
 * returned set, so the log's subject key for this new member MUST be the
 * key they actually sign root manifests with - using their x25519
 * (encryption) key here instead would make every root THEY sign
 * unverifiable to every other member. `prev` is the log's current tip (its
 * LAST entry by `seq`, since `getMembershipLog` returns entries ordered
 * ascending) fetched fresh right before appending; this engine has no CAS
 * loop over the log's `seq` (unlike the root-manifest commit's 409/rebase
 * loop) - a concurrent grant/revoke racing the same append would both
 * compute the same `prev` and submit the same `seq`, and the server's
 * `(workspace_id, seq)` PRIMARY KEY makes the loser's whole `grant-member`
 * batch fail atomically rather than silently corrupt the log; a documented,
 * un-retried gap (P2c's job to surface and let the caller retry).
 *
 * Throws `Error("e2ee: grantAccess: that user has no E2EE identity")` if
 * `granteeEmail` has no directory entry (no such user, or they never ran
 * `setupIdentity`) - nothing is written server-side in that case, since the
 * directory lookup fails before any `grantMember` call is made.
 */
export declare function grantAccess(api: ApiClient, session: Session, ws: Workspace, granteeEmail: string): Promise<void>;
/**
 * Revoke a member's access (P2d Task 3 - the guarantee becomes REAL): rotates
 * the workspace key WK_v1→v2, eagerly re-keying EVERY file + folder in the
 * workspace, re-sealing WK_v2 to every REMAINING member (including the
 * caller), removing `removed`'s membership + grant, and appending a signed
 * `remove` entry to the membership log - all atomically
 * (`computeRotation` + `POST /api/e2ee/rotate`, P2d Tasks 1–2).
 *
 * This SUPERSEDES the old P2b-log behavior (append-remove-entry-only, no
 * re-key): a removed member's stale WK_v1 grant can no longer decrypt
 * anything written or re-keyed AFTER this call - proven by the
 * wk1-cannot-read-v2 assertion in `e2ee-cross-user-share.int.test.ts`. The
 * remaining honest-disclosure caveat is narrower now: only ciphertext the
 * removed member ALREADY fetched before revocation (and kept a local copy
 * of) remains readable to them - nothing new or re-keyed.
 *
 * `removed.ed25519Pub` MUST be the removed member's ed25519 SIGNING pubkey
 * (hex) - the SAME id `grantAccess` used as their log `subjectId` - so the
 * appended `remove` entry actually targets their existing membership.
 * Callers get it from `listMembers` (which returns `{userId, email,
 * ed25519Pub, x25519Pub}` per member).
 *
 * Idempotent no-op if `removed.userId` is NOT currently a member (e.g. a
 * concurrent revoke by another caller already removed them, or the caller
 * passed a stale id): the goal ("this user has no access") is already
 * satisfied, so this returns without computing or posting a rotation, rather
 * than throwing or spending an unnecessary re-key. (Documented choice, per
 * the plan's Task 3 - the alternative of throwing was considered but rejected
 * because a race between two admins revoking the same member should not
 * surface as a hard error to the second caller.)
 *
 * Retries (bounded, `MAX_ROTATION_ATTEMPTS`, mirroring `commitFolderOps`'s
 * rebase loop) on a `{conflict}` from `api.rotate` - a racing commit/rotation
 * took the head version this rotation was computed against. Each retry
 * re-fetches the CURRENT member roster (`listMembers`) and recomputes the
 * ENTIRE rotation from scratch via `computeRotation` (which itself re-fetches
 * the current head via `getVerifiedHead` and the current membership log) -
 * never reapplies stale ciphertext computed against an outdated head. This
 * degrades safely: a rotation that can't converge within the bound throws a
 * clear, retriable error (never a partial/corrupt apply - the server's
 * `DB.batch` in `rotate.ts` is itself all-or-nothing per attempt).
 *
 * On success, updates the caller's live `ws` object IN PLACE to WK_v2
 * (`ws.wk`, `ws.wkVersion`, `ws.lastSeen`) - the SAME `Workspace` reference
 * the caller already holds is immediately usable for further reads/writes at
 * v2, with no re-open required. `wk2` itself is recovered by opening THIS
 * session's own v2 self-grant out of the just-applied `RotationPayload`
 * (`computeRotation` always re-seals to every `remaining` member, and the
 * caller is necessarily one of them - see `computeRotation`'s doc comment) -
 * mirroring exactly what a fresh `openWorkspace` would derive, without
 * requiring an actual round-trip re-open.
 *
 * OUT OF SCOPE (per the plan's Global Constraints, documented rather than
 * guarded): removing the LAST remaining member (i.e. `removed` is the
 * caller's own only membership, or otherwise empties `remaining`) would
 * compute a rotation with ZERO grants - WK_v2 sealed to nobody - locking
 * EVERYONE (including the caller) out of the workspace forever. This
 * function does not special-case or reject that call; a caller-side UI
 * (P2c) MUST NOT offer "revoke" for a workspace's last/only member.
 *
 * SELF-REVOKE GUARD (hardening pass): rejects upfront, before computing or
 * posting ANY rotation, if `removed.userId` turns out to be the CALLER's own
 * account id. `api.rotate` would otherwise succeed server-side fine (no data
 * loss for anyone else - the server doesn't care who the caller is relative
 * to `removed`), but the caller would have sealed no v2 self-grant for
 * itself (it's not in `remaining`), so the success path below would fail
 * with a misleadingly-labeled "should be unreachable" error - AFTER the
 * rotation had already landed, which is confusing and too late. The
 * caller's own account id isn't known to this function directly (`removed`
 * is keyed by account userId; this session only knows its own ed25519
 * SIGNING pubkey), so it's resolved by matching that pubkey in the current
 * `listMembers` roster - the same lookup the retry loop below performs on
 * every attempt anyway. A caller that wants to drop its OWN access needs a
 * (future) leave-workspace flow, not `revokeAccess`.
 *
 * CONCURRENT-ROTATION STALENESS (hardening pass): on a `{conflict}` (409)
 * from `api.rotate`, the loop below does not just blindly retry - it first
 * RE-DERIVES `ws.wk`/`ws.wkVersion` from the caller's own CURRENT stored
 * grant (via the same `deriveWkFromStoredGrant` helper `openWorkspace` uses),
 * exactly as if the caller had freshly re-opened the workspace. This matters
 * because the conflict may have been caused by a DIFFERENT rotation landing
 * first (not just an ordinary folder/file commit) - in that case every
 * folder index and file manifest is now encrypted under a NEW wk/wkVersion,
 * and retrying `computeRotation` with the OLD, stale `ws.wk`/`ws.wkVersion`
 * would throw an opaque AEAD-decrypt error deep inside it instead of simply
 * converging. `ws.selfFounded` is left untouched by this re-derivation (see
 * `Workspace.selfFounded`'s doc comment for why it must never be re-derived
 * from anything the server returns). `commitFolderOps` had this SAME latent
 * staleness on its own 409/rebase path - now fixed there too (hardening
 * pass), via the identical `deriveWkFromStoredGrant` re-derivation at its own
 * retry site.
 */
export declare function revokeAccess(api: ApiClient, session: Session, ws: Workspace, removed: {
    userId: string;
    ed25519Pub: string;
}): Promise<void>;
/**
 * The workspace's current members (account id + email + ed25519 SIGNING
 * pubkey + x25519 ENCRYPTION pubkey), for the P2c members/revoke UI, as the
 * `granteeEd25519PubHex` source `revokeAccess`'s caller needs, and as the
 * `remaining`/`removed` source `computeRotation`'s caller needs (P2d Task 1).
 */
export declare function listMembers(api: ApiClient, ws: Workspace): Promise<{
    userId: string;
    email: string;
    ed25519Pub: string;
    x25519Pub: string;
}[]>;
/**
 * The client-computed result of a full workspace-key rotation (P2d, spec
 * §8's "revoke becomes real" guarantee): a fresh WK (`newWkVersion =
 * ws.wkVersion + 1`), with EVERY file's DEK re-wrapped, EVERY file's
 * manifest re-encrypted, and EVERY folder's index re-encrypted under it -
 * chunks are NEVER touched (only their DEK's wrap and the manifest
 * ciphertext change) - a new signed root binding the re-encrypted folder
 * merkle tree, a v2 grant re-sealing the new WK to every REMAINING member
 * (including the caller), and a signed `remove` membership-log entry for the
 * removed member. Pure client crypto - `computeRotation` never talks to the
 * server except to READ the current head/folder-indexes/membership-log; the
 * caller (Task 2's `revokeAccess`) POSTs this payload to `/api/e2ee/rotate`,
 * which applies all of it atomically (one CAS-guarded `DB.batch`).
 */
export type RotationPayload = {
    newWkVersion: number;
    /** The new (wkVersion=2) signed root manifest, over the re-encrypted folder merkle tree. */
    signedRoot: string;
    rootHash: string;
    changedFolderIndexes: {
        folderId: string;
        indexVersion: number;
        ciphertext: string;
    }[];
    fileManifests: {
        fileId: string;
        version: number;
        ciphertext: string;
    }[];
    /** One v2 grant per REMAINING member - including the caller (self). */
    grants: {
        memberUserId: string;
        wkVersion: number;
        sealed: string;
        granterEd25519Pub: string;
    }[];
    /** The signed `remove(removed)` entry to append to the membership log. */
    membershipEntry: {
        seq: number;
        entryBlob: string;
    };
    removedUserId: string;
    /** CAS guard for the atomic apply: the head version this rotation was computed against. */
    expectedPrev: number;
};
/**
 * Re-key the ENTIRE workspace to a fresh WK (`ws.wkVersion + 1`), re-sealing
 * it to every `remaining` member (including the caller) and appending a
 * signed `remove` entry for `removed` - the eager, full re-key that makes
 * revocation a real guarantee (spec §8; P2d plan's Global Constraints).
 *
 * **THE OVERRIDING INVARIANT this composes toward: no file may become
 * unreadable.** For every folder's index and every file entry in it, the
 * SAME AD fields the readers (`downloadFile`/`listFolder`/`folderStateFromHead`
 * in this file / `file.ts`) bind against are reproduced exactly, just under
 * `(wk2, newWkVersion)` instead of `(ws.wk, ws.wkVersion)`:
 *  - folder index: `encryptFolderIndex(plaintext, wk2, fmt, workspaceId,
 *    folderId, newIndexVersion, newWkVersion)` - same `folderId`, indexVersion
 *    bumped by 1 (a fresh ciphertext needs its own AD-bound version).
 *  - file manifest: `encryptFileManifest(manifest, wk2, fmt, workspaceId,
 *    record.fileId, record.version, folderId, newWkVersion)` - `fileId`
 *    (the record's crypto-identity fileId, NOT necessarily the entry's
 *    current folder-index id - see `FileRecordWire`'s doc comment in
 *    `file.ts`), `version`, and `folderId` (the entry's CONTAINING folder)
 *    are all carried over byte-for-byte from the pre-rotation record; only
 *    `wk`/`wkVersion` change.
 *  - DEK wrap: `wrapDek(dek, wk2, fmt, workspaceId, newWkVersion)` - the raw
 *    DEK bytes are untouched (recovered via `unwrapDek` under the OLD
 *    `ws.wk`/`ws.wkVersion` first); only its wrap changes. Chunks are never
 *    re-encrypted or re-uploaded - this is the ONLY thing that changes about
 *    a file's ciphertext-at-rest.
 * Any mismatch in any of those AD fields would make `decryptFileManifest`/
 * `unwrapDek`/`decryptFolderIndex` throw for a remaining member post-rotation
 * - exactly the "file becomes unreadable" failure this function must never
 * produce (see the plan's Global Constraints + the no-data-loss test in
 * `e2ee-rotation.int.test.ts`).
 *
 * Composes ONLY e2ee-core's existing primitives (`generateWorkspaceKey`/
 * `wrapDek`/`unwrapDek`/`encryptFileManifest`/`decryptFileManifest`/
 * `encryptFolderIndex`/`decryptFolderIndex`/`sealGrant`/`appendEntry`/
 * `replayLog`) - `e2ee-core` itself is NOT modified.
 *
 * Does NOT write anything to the server: this is pure client computation
 * over the CURRENT verified head (via the same `getVerifiedHead` every read
 * goes through, so rotation is subject to the same rollback/fork/founder-
 * anchor checks as any other read) + the current membership log + every
 * folder's CURRENT decrypted contents. The caller (`revokeAccess`, Task 3)
 * POSTs the returned `RotationPayload` to `POST /api/e2ee/rotate` (Task 2),
 * which applies it atomically, CAS-guarded on `expectedPrev`.
 *
 * `args.remaining` MUST include the caller's own membership row (so the
 * caller gets a v2 self-grant too - without it, the caller who just rotated
 * would be locked out of its own workspace); `args.removed` is the member
 * being revoked, NOT present in `remaining`.
 */
export declare function computeRotation(api: ApiClient, session: Session, ws: Workspace, args: {
    remaining: {
        userId: string;
        ed25519Pub: string;
        x25519Pub: string;
    }[];
    removed: {
        userId: string;
        ed25519Pub: string;
    };
}): Promise<RotationPayload>;
/** Decrypt the head's `folderId` folder index -> the current `FolderState`. Empty if the folder (or the workspace's head) doesn't exist yet. */
export declare function listFolder(api: ApiClient, session: Session, ws: Workspace, folderId: string): Promise<FolderState>;
/**
 * `listFolder` plus the head version the state was derived from - what a
 * caller that goes on to `commitFolderOps` passes back as `base`, so the
 * commit can tell whether the workspace moved on in between.
 */
export declare function listFolderAt(api: ApiClient, session: Session, ws: Workspace, folderId: string): Promise<{
    state: FolderState;
    headVersion: number | null;
    spaceName: string | null;
}>;
/**
 * The Space's own name, as every device that opens it sees it, or `null` if
 * nobody has named it.
 *
 * It lives in the root folder index (see the folder-index serialization
 * comment above), so reading it costs the same head fetch + decrypt a folder
 * listing does. A caller drawing a LIST of Spaces should cache what this
 * returns rather than call it per Space per render.
 */
export declare function readWorkspaceName(api: ApiClient, session: Session, ws: Workspace): Promise<string | null>;
/**
 * Set (or, with `null`, clear) the Space's name.
 *
 * A rename is an ordinary root commit carrying no entry ops, so it takes the
 * same optimistic-commit path as everything else: it can lose a race, and it
 * retries against the new head. Two devices renaming at once resolve
 * last-writer-wins, which is what a single-valued label can do.
 */
export declare function renameWorkspace(api: ApiClient, session: Session, ws: Workspace, name: string | null): Promise<void>;
/**
 * File-layer artifacts (P1b Task 3, `file.ts`) that ride along with a folder
 * commit: the encrypted `FileManifest` blob(s) a caller wants persisted to
 * `e2ee_file_manifests`, plus the chunk-refcount deltas for whatever ciphertext
 * chunks it just uploaded/orphaned. Optional and empty by default so Task 2's
 * folder-only callers are unaffected.
 *
 * `chunkRefDeltas` is keyed by `entryId` - the SAME id as the corresponding
 * `put` in this call's `localOps` - rather than being a flat pair of arrays,
 * so `commitFolderOps` can tell, on EACH commit attempt (including rebase
 * retries), whether THAT entry's write actually survived the real merged
 * outcome before deciding whether its delta applies. See `commitFolderOps`'s
 * doc comment for why blindly resending a flat delta on every retry is
 * unsafe.
 */
export type CommitFileExtras = {
    fileManifests?: CommitBody["fileManifests"];
    chunkRefDeltas?: {
        entryId: string;
        added: string[];
        removed: string[];
    }[];
    /**
     * The folder state the caller computed its ops AGAINST, with the head
     * version it came from (see `listFolderAt`). When the workspace has moved
     * on by the time the commit starts - another device saved while this one
     * was still uploading chunks - the first attempt is a real 3-way rebase
     * against that base instead of a plain apply on top of the newer remote.
     * Without it a slow edit lands verbatim over the other device's edit and
     * commits cleanly, no 409, no conflicted copy: silent data loss.
     */
    base?: {
        state: FolderState;
        headVersion: number | null;
    };
};
/**
 * Resolve which chunk-ref deltas actually apply given THIS attempt's real
 * merged outcome (`merged`/`conflicts`, from either `applyOps` on the first
 * attempt or a real `rebase()` on a retry), rather than blindly reapplying
 * whatever was computed once against a base that may no longer reflect what
 * is actually being committed. For each `{ entryId, added, removed }`:
 *
 *  - the corresponding local `put` landed UNCHANGED at its original id in
 *    `merged` (the common case: no conflict, or this write cleanly won) ->
 *    the full `added` + `removed` delta applies.
 *  - `entryId` shows up in `conflicts` as `"conflicted-copy"` (this write
 *    survived under a FRESH id - e2ee-core's rebase.ts
 *    `insertConflictedCopy`) -> only `added` applies. The new chunks are now
 *    referenced by the conflicted-copy entry, but `removed` is DROPPED:
 *    whatever remains at `entryId` (the other writer's version) may still
 *    reference those chunks, and removing them is that OTHER commit's
 *    responsibility (exactly once), not this one's.
 *  - neither (e.g. `"lww-remote-wins"`: this attempt's whole edit was
 *    dropped) -> neither applies - nothing this attempt uploaded ended up
 *    referenced by `merged`, so there is nothing to credit or debit.
 *  - a delta whose `entryId` has a local `{ type: "del" }` op (no local
 *    `put` - `deleteEntry` in `file.ts`) -> `removed` (and `added`, normally
 *    empty for a delete) applies iff `remote.has(entryId) && !merged.has(entryId)`:
 *    THIS attempt's own delete is what removed the entry from the head it
 *    was committed against. That is exactly e2ee-core's rebase.ts "clean
 *    delete" branch (`!changed(r, b)` -> `merged.delete(id)`, reached when
 *    the remote never touched the id since `base`), so the manifest
 *    `deleteEntry` decrypted from ITS base is exactly the one still live at
 *    `remote`, and its chunk list is the right thing to release. The other
 *    two rebase.ts outcomes for a local `del` both mean "don't apply": a
 *    `delete-edit` conflict keeps the remote's (edited) entry at `id`
 *    (`merged.has(id)` stays true - the remote's own put already accounts
 *    for its current chunks, unrelated to what this stale local delete
 *    computed), and "both sides deleted" (`!remote.has(id)`) means the
 *    OTHER side's delete already released these refs once - reapplying here
 *    would double-decrement.
 *
 * This is what makes chunk-ref accounting safe to recompute on EVERY rebase
 * retry: a losing attempt whose write becomes a conflicted copy never
 * re-reports the removal a DIFFERENT (winning) commit already applied once,
 * so a chunk shared by both the old and the winning version is never
 * double-decremented (refcount -> negative), and a conflicted copy's own new
 * chunks are never left un-added (orphaned). The same non-double-decrement
 * property holds for a `del`'s removal: `remote.has(entryId)` is only true
 * on the attempt that still sees the entry live, so a losing "both deleted"
 * retry (`!remote.has(id)`) never re-reports what the winning delete already
 * released.
 */
export declare function resolveChunkRefDeltas(localOps: Op[], remote: FolderState, merged: FolderState, conflicts: Conflict[], chunkRefDeltas: {
    entryId: string;
    added: string[];
    removed: string[];
}[]): {
    added: string[];
    removed: string[];
};
/**
 * Signal thrown by `commitFolderOps` when a concurrent workspace-key
 * ROTATION landed mid-commit (detected on its 409-retry path - see that
 * function's doc comment) AND this commit carries file-layer ciphertext
 * (some pending `put` op's `entry.meta.record`, or `fileExtras.fileManifests`)
 * that was sealed by the caller under the OLD `wk`/`wkVersion` before this
 * call ever started.
 *
 * That ciphertext is now STALE relative to the just-rebased folder index
 * (which `commitFolderOps` re-encrypts under the NEW, just-adopted key) and
 * therefore CANNOT be safely committed as-is: doing so would land an
 * old-key file record inside a new-key folder index -- silently corrupting
 * that one file (permanently undecryptable, since every reader decrypts
 * with the CURRENT `ws.wkVersion`). This error exists so that never happens
 * silently again -- see the prior hardening pass's "Concern / follow-up"
 * note in `.superpowers/sdd/p2d-minor-hardening-report.md`, which this fix
 * closes.
 *
 * `newWkVersion` is `ws.wkVersion` at the moment of the throw -- exactly
 * the epoch the caller must re-seal its file record under before retrying.
 * `commitFolderOps` has ALREADY updated `ws.wk`/`ws.wkVersion` in place
 * (mirroring its own ordinary 409-retry re-derivation) before throwing this,
 * so a catching caller (`uploadFile`/`updateFile` in `file.ts` - the only
 * callers that carry file-layer ciphertext, and therefore the only ones
 * that need to catch this) can immediately re-seal under the fresh key and
 * retry, with no extra round trip to re-derive the key itself.
 *
 * Folder-only commits (no file records, no fileManifests) never throw this
 * - there is nothing key-sealed at the file layer to go stale for them, so
 * `commitFolderOps` just re-derives and converges, exactly as before this
 * fix (the prior hardening pass's Item 1 behavior, preserved).
 */
export declare class WorkspaceRekeyedError extends Error {
    readonly newWkVersion: number;
    constructor(newWkVersion: number);
}
/**
 * The §9 optimistic commit: apply `localOps` to `folderId`, encrypt + sign +
 * commit a new root version. On a 409 (someone else committed first),
 * re-fetch the new head and 3-way rebase the SAME squashed ops (via
 * e2ee-core's `rebase`) onto it, against the ORIGINAL base observed before
 * this call's first attempt - never an intermediate attempt's remote, which
 * would compound drift across retries - then retry, bounded by
 * `MAX_REBASE_ATTEMPTS`.
 *
 * `fileExtras` (Task 3's file layer) does NOT ride along unchanged on every
 * attempt. `fileManifests` still does (each is an independent, self-
 * contained ciphertext keyed by its own fileId/version - resending is
 * harmless). But `chunkRefDeltas` is RECOMPUTED every attempt via
 * `resolveChunkRefDeltas`, against that attempt's ACTUAL merged outcome
 * (`merged`/`conflicts`) - never blindly resent. A losing attempt's whole
 * commit batch rolls back server-side (see commit.ts's CAS design note), so
 * the batch itself is never partially applied - but a LATER retry attempt is
 * a genuinely NEW commit, and what it should credit/debit depends on what
 * THAT attempt is actually about to write: if this call's own edit survives
 * only as a rebase-generated conflicted copy (a different writer won the
 * race for the original id), reapplying the ORIGINAL `removed` delta would
 * double-decrement a chunk the WINNING commit already removed once (driving
 * its refcount negative), and would risk leaving the conflicted copy's own
 * new chunks un-added. See `resolveChunkRefDeltas`'s doc comment for the
 * full case analysis.
 */
export declare function commitFolderOps(api: ApiClient, session: Session, ws: Workspace, folderId: string, localOps: Op[], fileExtras?: CommitFileExtras, opts?: {
    spaceName?: string | null;
}): Promise<void>;
