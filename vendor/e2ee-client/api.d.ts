/**
 * Server API surface the E2EE client engine calls (P1a routes - see
 * apps/api/src/pages/api/e2ee/*.ts). Callers inject an implementation bound
 * to their own auth (session cookie / bearer token); the engine itself never
 * knows or cares how auth works, only that these calls succeed or reject.
 */
export interface ApiClient {
    /** GET /api/e2ee/oprf-public-key - no auth required, cacheable. */
    oprfPublicKey(): Promise<Uint8Array>;
    /** POST /api/e2ee/oprf-evaluate - session-authed. */
    oprfEvaluate(blinded: Uint8Array): Promise<Uint8Array>;
    /** GET /api/e2ee/user-keys - resolves null on a 404 (no identity set up yet). */
    getUserKeys(): Promise<UserKeysRecord | null>;
    /** PUT /api/e2ee/user-keys - upsert. */
    putUserKeys(record: UserKeysRecord): Promise<void>;
    /**
     * GET /api/e2ee/user-pubkey?email= - public identity-key directory lookup
     * for ANOTHER user by email (used to seal a workspace grant to them, see
     * P2b `grantAccess`); resolves null on a 404 (no such user, or that user
     * has no E2EE identity set up yet). Returns PUBLIC keys only - never
     * wrapped/private fields.
     */
    lookupUserPubkey(email: string): Promise<{
        userId: string;
        x25519Pub: string;
        ed25519Pub: string;
    } | null>;
    /**
     * PUT /api/e2ee/workspace-grant - store the caller's own HPKE-sealed WK
     * for `workspaceId` (self-scoped upsert; server sees ciphertext only).
     * `granterEd25519Pub` (P2b Task 2, optional, hex) is the sealing member's
     * OWN ed25519 public key - omit for a plain self-grant (granter == self,
     * the P1b.2a case); a future cross-user grant path threads the real
     * granter's key through here (or via `grant-member`, P2b Task 3).
     */
    putWorkspaceGrant(workspaceId: string, wkVersion: number, sealed: string, granterEd25519Pub?: string): Promise<void>;
    /**
     * GET /api/e2ee/workspace-grant/:workspaceId - the caller's own sealed WK;
     * resolves null on a 404 (no grant stored for this workspace).
     * `granterEd25519Pub` is null for a legacy/self-grant row that never
     * stored one - `openWorkspace` treats null as "granter == self".
     */
    getWorkspaceGrant(workspaceId: string): Promise<{
        wkVersion: number;
        sealed: string;
        granterEd25519Pub: string | null;
    } | null>;
    /** GET /api/e2ee/head/:workspaceId - resolves null on a 404 (no head committed yet). */
    getHead(workspaceId: string): Promise<HeadResponse | null>;
    /**
     * POST /api/e2ee/grant-member - the CALLER (an existing member, gated
     * server-side) has already HPKE-sealed `wkVersion`'s WK to
     * `granteeUserId`'s authenticated key client-side (see `grantAccess`,
     * which resolves `granteeUserId` via `lookupUserPubkey`); this persists
     * that opaque sealed blob under the GRANTEE's own row, adds them to the
     * workspace's membership projection, AND appends `membershipEntry` (P2b-log
     * Task 3: the signed `add` entry `grantAccess` built via e2ee-core's
     * `appendEntry`) to the signed membership log - all three atomically
     * (same `DB.batch`). Server sees ciphertext + a signature only, same
     * boundary as `putWorkspaceGrant`; `membershipEntry.entryBlob` is opaque
     * here too (never parsed server-side - replay + verification is the
     * client's job).
     */
    grantMember(workspaceId: string, granteeUserId: string, wkVersion: number, sealed: string, granterEd25519Pub: string, membershipEntry: {
        seq: number;
        entryBlob: string;
    }): Promise<void>;
    /**
     * POST /api/e2ee/revoke-member - remove `granteeUserId`'s membership +
     * sealed grant for `workspaceId`, AND append `membershipEntry` (P2b-log
     * Task 3: the signed `remove` entry `revokeAccess` built) to the signed
     * membership log - atomically (same `DB.batch`). No WK rotation
     * (documented follow-up): this stops NEW/future access via the membership
     * gate + log replay, not ciphertext the grantee already fetched - see
     * `revokeAccess`'s doc comment.
     */
    revokeMember(workspaceId: string, granteeUserId: string, membershipEntry: {
        seq: number;
        entryBlob: string;
    }): Promise<void>;
    /**
     * GET /api/e2ee/members/:workspaceId - the workspace's current members
     * (account id + email + ed25519 SIGNING pubkey + x25519 ENCRYPTION pubkey
     * - P2d Task 1's addition, the `granteePubkey` `computeRotation` needs to
     * re-seal the rotated workspace key to every remaining member - for
     * display and as the log-subject id `revokeAccess`'s caller needs), for
     * the P2c members/revoke UI and engine `listMembers`. Caller must already
     * be a member.
     */
    listMembers(workspaceId: string): Promise<{
        userId: string;
        email: string;
        ed25519Pub: string;
        x25519Pub: string;
    }[]>;
    /**
     * GET /api/e2ee/membership-log/:workspaceId - the workspace's full signed
     * membership log (spec §7), ordered by `seq`, as opaque
     * `{ seq, entryBlob }` rows. Caller must already be a member (same
     * `isMember` gate as `listMembers`/`getHead`). The client
     * `deserializeSignedEntry`s each row and `replayLog`s the sequence
     * (e2ee-core, unchanged) to derive + verify the current member set - this
     * call itself does no crypto.
     */
    getMembershipLog(workspaceId: string): Promise<{
        seq: number;
        entryBlob: string;
    }[]>;
    /**
     * GET /api/e2ee/my-workspaces - self-scoped discovery (P2c), extended by
     * P2e with the per-workspace scope association: every workspace id the
     * CALLER is currently a member of, plus `globalWorkspaceId` (the storage
     * workspace it's scoped to, or `null` if unscoped - see
     * `putWorkspaceScope`) and `createdByMe` (whether THIS caller was the
     * scope's first writer). This is how an invitee (who never ran
     * `createWorkspace` for a shared workspace) learns a workspaceId at all.
     * SECURITY: the engine/store MUST NOT derive `selfFounded` from this
     * response (`globalWorkspaceId`/`createdByMe` are DISPLAY-ONLY) - see
     * `Workspace.selfFounded`'s doc comment in `workspace.ts` and
     * `stores/e2ee.ts` in apps/web.
     */
    listMyWorkspaces(): Promise<{
        workspaceId: string;
        globalWorkspaceId: string | null;
        createdByMe: boolean;
    }[]>;
    /**
     * PUT /api/e2ee/workspace-scope - records that `workspaceId` (an E2EE
     * Space) belongs to `globalWorkspaceId` (the active global storage
     * workspace at creation time), purely for per-workspace Vault UI grouping
     * (P2e). Plaintext metadata, not crypto. Member-gated server-side; SET-ONCE
     * (`ON CONFLICT(workspace_id) DO NOTHING`) - the first caller to record a
     * scope for a given `workspaceId` wins, later callers cannot rewrite it.
     * Called right after `createWorkspace`'s genesis commit.
     */
    putWorkspaceScope(workspaceId: string, globalWorkspaceId: string): Promise<void>;
    /**
     * POST /api/e2ee/commit - §9 CAS commit. Resolves the 200 body on success,
     * or `{ conflict }` on a 409 - a conflict is an EXPECTED, recoverable
     * outcome (the caller rebases and retries), never thrown as an error. Any
     * other non-2xx status throws.
     */
    commit(body: CommitBody): Promise<CommitResult>;
    /**
     * POST /api/e2ee/rotate - P2d Task 2: apply a client-computed
     * `RotationPayload` (`computeRotation`, workspace.ts) atomically, in ONE
     * CAS-guarded `DB.batch`: the head advance to `newWkVersion`'s root, every
     * re-encrypted folder-index/file-manifest, every re-sealed grant to a
     * REMAINING member (including self), the removed member's grant+membership
     * deletes, and the membership-log `remove` entry - all-or-nothing (see
     * apps/api/src/pages/api/e2ee/rotate.ts). Resolves the 200 body on success,
     * or `{ conflict }` on a 409 - a conflict is an EXPECTED, recoverable
     * outcome (the caller re-fetches the head/members and recomputes the
     * rotation from scratch), never thrown as an error - same posture as
     * `commit`. Any other non-2xx status throws.
     */
    rotate(body: RotateBody): Promise<RotateResult>;
    /**
     * POST /api/e2ee/chunk-upload-url - a presigned R2 PUT for `chunkId`
     * (hex(sha256(ciphertext))).
     *
     * `size` is the EXACT byte length of the ciphertext about to be PUT. The
     * server refuses a size outside e2ee-core's CHUNK_MIN/MAX_CIPHERTEXT_BYTES
     * and signs it into the URL as Content-Length, so R2 403s a body of any
     * other length - which is what stops a member parking arbitrary bytes
     * under random chunk ids. The body sent to R2 must therefore be exactly
     * this many bytes (the fetch transport sends a Uint8Array, whose
     * Content-Length the runtime derives from its length).
     */
    chunkUploadUrl(workspaceId: string, chunkId: string, size: number): Promise<string>;
    /** GET /api/e2ee/chunk-download-url - a presigned R2 GET for the SAME key a prior `chunkUploadUrl` wrote. */
    chunkDownloadUrl(workspaceId: string, chunkId: string): Promise<string>;
}
/** A single folder's current encrypted-index pointer, as returned by GET /head and sent back in a commit's `changedFolderIndexes`. */
export type FolderIndexRef = {
    folderId: string;
    indexVersion: number;
    ciphertext: string;
};
/** GET /api/e2ee/head/:workspaceId 200 body - the current CAS head plus every folder index blob. */
export type HeadResponse = {
    version: number;
    signedRoot: string;
    rootHash: string;
    folderIndexes: FolderIndexRef[];
};
/** POST /api/e2ee/commit request body (see apps/api/src/pages/api/e2ee/commit.ts). */
export type CommitBody = {
    workspaceId: string;
    expectedPrev: number | null;
    signedRoot: string;
    rootHash: string;
    changedFolderIndexes?: FolderIndexRef[];
    fileManifests?: {
        fileId: string;
        version: number;
        ciphertext: string;
    }[];
    addedChunkRefs?: string[];
    removedChunkRefs?: string[];
    /**
     * P2b-log Task 1: opaque serialized `SignedEntry` (spec §7 signed
     * membership log) rows to append to `e2ee_membership_log`, atomically with
     * this commit's head insert. A genesis commit (`createWorkspace`) sends the
     * log's seq-0 entry here; a later grant/revoke (P2b-log Task 3) sends its
     * own appended entry via `grant-member`/`revoke-member` instead, not this
     * field.
     */
    membershipEntries?: {
        seq: number;
        entryBlob: string;
    }[];
};
export type CommitResult = {
    version: number;
} | {
    conflict: {
        currentVersion: number;
    };
};
/**
 * POST /api/e2ee/rotate request body (see
 * apps/api/src/pages/api/e2ee/rotate.ts): the client-computed
 * `RotationPayload` (workspace.ts's `computeRotation`) plus the
 * `workspaceId` it targets - mirrors `CommitBody`'s convention of
 * independently defining the wire shape here rather than importing
 * workspace.ts's engine-level type (which would create a cycle: workspace.ts
 * already imports `ApiClient`/`CommitBody` from this module).
 */
export type RotateBody = {
    workspaceId: string;
    newWkVersion: number;
    signedRoot: string;
    rootHash: string;
    changedFolderIndexes: FolderIndexRef[];
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
    /** CAS guard: the head version this rotation was computed against. */
    expectedPrev: number;
};
export type RotateResult = {
    version: number;
} | {
    conflict: {
        currentVersion: number;
    };
};
/**
 * The server-stored, per-user E2EE identity record. Every field here is
 * either public (the two pubkeys), an AEAD-wrapped ciphertext blob, or a KDF
 * parameter - the server never sees the KEK, the recovery key, or any
 * private key material.
 */
export type UserKeysRecord = {
    x25519Pub: string;
    ed25519Pub: string;
    wrappedPriv: string;
    recoveryWrapped: string | null;
    argonSalt: string;
    argonParams: string;
};
export type FetchApiClientOptions = {
    /** e.g. "http://127.0.0.1:PORT" - no trailing slash required. */
    baseUrl: string;
    /**
     * Called before every request to obtain auth headers, e.g.
     * `() => ({ Cookie: cookie })` or `() => ({ Authorization: \`Bearer ${token}\` })`.
     * Omit for auth-free use (only `oprfPublicKey` works without it).
     */
    authHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
    /** Injectable for tests; defaults to the ambient global `fetch`. */
    fetchFn?: typeof fetch;
};
/** Fetch-based `ApiClient` against a real (or test-harness) apps/api server. */
export declare function createFetchApiClient(opts: FetchApiClientOptions): ApiClient;
