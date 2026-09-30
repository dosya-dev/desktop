/**
 * File encrypt-upload / download-decrypt (spec §5.5). Composes e2ee-core's
 * per-file DEK + chunked-AEAD + delta primitives against the injected
 * `ApiClient`/`ChunkTransport` and this package's `workspace.ts` (folder
 * index + §9 commit/rebase) - never re-implements any crypto here.
 *
 * DEK recovery (documented choice - see the plan's Task 3 note): e2ee-core's
 * `FileManifest` (file.ts) has NO `wrappedDek`/similar field - it carries
 * only `dekId`, a content-derived label (`hex(sha256(dek))`), which is NOT
 * reversible back to the key. So the raw DEK is NOT recoverable from the
 * manifest alone; this module wraps the DEK itself under the workspace key
 * (`wrapDek`/`unwrapDek`, already the correct primitive for exactly this -
 * see workspace-keys.ts) and stores that wrapped DEK alongside the encrypted
 * manifest, in a small client-owned wire record (`FileRecordWire` below).
 *
 * Where that record lives: embedded directly in the file's folder `Entry`
 * (`entry.meta.record`), NOT fetched via a separate server endpoint. Two
 * reasons:
 *   1. The P1a server surface has no `GET file-manifest` route (only
 *      `POST /api/e2ee/commit` writes `e2ee_file_manifests`, and
 *      `GET /api/e2ee/head/:workspaceId` returns folder indexes only, never
 *      file manifests) - see apps/api/src/pages/api/e2ee/head/[workspaceId].ts.
 *      Adding one is a reasonable follow-up (the table + write path already
 *      exist), but this task's ApiClient additions are scoped to the two
 *      chunk-URL methods only.
 *   2. It keeps `downloadFile` self-contained: one `getHead` (via
 *      `listFolder`) + N chunk fetches, no extra round trip.
 * The tradeoff: the folder index now carries every file's (small) manifest +
 * wrapped-DEK bytes, so `listFolder` cost grows with the number/size of
 * manifests in a folder, not just entry count - acceptable for P1b's
 * personal-scope scale; a dedicated file-manifest-fetch endpoint (the DB
 * table is already written by commit.ts) would be the fix if that ever
 * matters. `encryptFileManifest`'s own ciphertext is ALSO still sent through
 * `commitFolderOps`'s `fileManifests` (into `e2ee_file_manifests`) on every
 * upload/edit, so that table stays populated for whenever such an endpoint
 * lands - this module just doesn't depend on reading it back yet.
 */
import { type PlainChunkSource, type PlainChunkSink } from "@dosya-dev/e2ee-core";
import type { ApiClient } from "./api.js";
import type { ChunkTransport } from "./transport.js";
import type { Session } from "./session.js";
import { type Workspace } from "./workspace.js";
export type FileDeps = {
    api: ApiClient;
    transport: ChunkTransport;
    session: Session;
    ws: Workspace;
};
/**
 * Encrypt the file `source` describes under a fresh per-file DEK, upload
 * every ciphertext chunk via `transport`, then commit a new folder `Entry`
 * (kind "file") whose `contentRef` is `hex(manifest.merkleRoot)` - a hash
 * over the file's actual chunk sequence, NOT the stable `fileId` - and
 * whose `meta.record` carries the encrypted `FileManifest` + wrapped DEK
 * (see this module's doc comment). `contentRef` must vary with content
 * (not just identity) because e2ee-core's rebase.ts uses `contentRef`
 * INEQUALITY as its sole signal for "these two versions have genuinely
 * conflicting content edits" (§9): using the invariant `fileId` there
 * would make every edit of the SAME file look metadata-only forever, so
 * two devices' concurrent edits would both fall into the LWW branch and
 * silently drop the loser's write. A merkle-root contentRef changes on any
 * real content edit (`updateFile` below) while staying IDENTICAL for a
 * pure metadata/rename op, so LWW still applies correctly to those. The
 * SAME encrypted manifest also rides through the commit's `fileManifests`
 * field into `e2ee_file_manifests` (see `workspace.ts`'s
 * `commitFolderOps`), and every fresh chunk's hex id is added via
 * `chunkRefDeltas` so the server's refcount bookkeeping stays
 * accurate - see `commitFolderOps`'s doc comment for why that delta is
 * reported per-entry rather than as a flat array.
 *
 * RE-SEAL ON CONCURRENT RE-KEY (removes a silent single-file corruption bug
 * a prior hardening pass introduced - see `WorkspaceRekeyedError`'s doc
 * comment): the DEK + chunks are only ever encrypted/uploaded ONCE, above
 * this loop. But the WK-SEALED record (`manifestCiphertext` via
 * `encryptFileManifest`, `wrappedDek` via `wrapDek`) is (re)computed INSIDE
 * the loop, under whatever `ws.wk`/`ws.wkVersion` are current on THIS
 * attempt - so if `commitFolderOps` throws `WorkspaceRekeyedError` (a
 * concurrent rotation landed mid-commit and already adopted the new key
 * onto `ws` in place), the next iteration re-seals the SAME `dek`/`manifest`
 * under the fresh key and retries the whole commit, seamlessly, bounded by
 * `MAX_RESEAL_ATTEMPTS`. The file's ciphertext-at-rest (chunks) is never
 * re-encrypted or re-uploaded by this retry - only the small WK-sealed
 * record changes, exactly like `computeRotation`'s own re-key of existing
 * files.
 *
 * Chunks are read, sealed and uploaded one at a time from `source`, so
 * memory stays at one chunk. If `source.read` or a chunk PUT throws
 * part-way, the chunks already uploaded stay in R2 unreferenced (no commit
 * happened); a retry re-encrypts with fresh nonces, so they are never
 * reused. Reclaiming them is the server's job, outside this client.
 */
export declare function uploadFileStreaming(deps: FileDeps, folderId: string, name: string, source: PlainChunkSource): Promise<{
    fileId: string;
}>;
/** Whole-buffer convenience over `uploadFileStreaming`: chunks `bytes` with the default chunker. */
export declare function uploadFile(deps: FileDeps, folderId: string, name: string, bytes: Uint8Array): Promise<{
    fileId: string;
}>;
/**
 * Re-encrypt an EXISTING file's content (edit path): reuses the file's
 * original DEK (unwrapped from its stored record) and delta-encrypts via
 * `computeDelta`, so chunks whose plaintext didn't change are neither
 * re-encrypted nor re-uploaded - only genuinely new chunks hit `transport`.
 * The new entry's `contentRef` is recomputed as `hex(manifest.merkleRoot)`
 * (see `uploadFileStreaming`'s doc comment for why) - it changes here precisely
 * because the content changed, which is what lets a concurrent edit of the
 * SAME file on another device be recognized by rebase.ts as a genuine
 * content conflict rather than silently LWW'd away.
 *
 * Chunks the new manifest no longer references are reported via this
 * entry's `chunkRefDeltas.removed` so the server's refcounts stay accurate
 * (the old manifest version itself is overwritten in `e2ee_file_manifests`,
 * not kept around - see commit.ts's `ON CONFLICT ... DO UPDATE`) - but
 * `commitFolderOps` only actually APPLIES that removal if this attempt's
 * write survives at its original id in the real merged outcome; see its doc
 * comment for why blindly resending a removal on every rebase retry is
 * unsafe (double-decrementing a chunk another writer's commit already
 * removed once).
 *
 * Uses `oldRecord.fileId` (the crypto-identity fileId baked into the stored
 * record) rather than this call's `fileId` PARAMETER for every crypto AD
 * binding: they coincide for an entry still at its original folder id, but
 * diverge for a rebase-generated conflicted-copy entry (a fresh folder id,
 * same underlying crypto fileId) - see `FileRecordWire`'s doc comment.
 *
 * Not part of the plan's two-function interface (`uploadFile`/`downloadFile`)
 * but required to exercise the delta path end-to-end (spec §5.5 `computeDelta`
 * reuse), per this task's own test scenario ("edit+re-upload a file").
 *
 * RE-SEAL ON CONCURRENT RE-KEY -- see `uploadFileStreaming`'s doc comment for the full
 * rationale (`WorkspaceRekeyedError`). Exactly the same shape here: `dek` /
 * `manifest` / `newChunks` are computed and uploaded ONCE, before the retry
 * loop; only the WK-sealed record (`manifestCiphertext`/`wrappedDek`) is
 * recomputed on each attempt, under whatever `ws.wk`/`ws.wkVersion` are
 * current -- so a `WorkspaceRekeyedError` from `commitFolderOps` (a
 * concurrent rotation landed mid-commit) is absorbed by re-sealing under the
 * fresh key and retrying the commit, bounded by `MAX_RESEAL_ATTEMPTS`.
 */
export declare function updateFile(deps: FileDeps, folderId: string, fileId: string, bytes: Uint8Array): Promise<void>;
/**
 * Reverse of `uploadFile`/`updateFile`: read the folder index, find the file
 * `Entry`, decrypt its manifest + unwrap its DEK (both from `entry.meta.record`
 * - see this module's doc comment), then fetch+verify+decrypt every chunk in
 * manifest order via `transport`. `decryptFileStreaming` verifies
 * `sha256(ciphertext) === chunkId` for each chunk internally before any AEAD
 * decryption is attempted (e2ee-core's file.ts).
 *
 * `fileId` here is the FOLDER entry's id (the map key from `listFolder`) -
 * for a rebase-generated conflicted-copy entry that is a fresh id, not the
 * original crypto fileId. The manifest/DEK AD binding uses
 * `record.fileId` (baked into the stored record - see `FileRecordWire`'s
 * doc comment), never this parameter, so downloading a conflicted copy
 * still decrypts correctly.
 */
export declare function downloadFileTo(deps: FileDeps, folderId: string, fileId: string, sink: PlainChunkSink): Promise<{
    totalSize: number;
}>;
/** Whole-buffer convenience over `downloadFileTo`. */
export declare function downloadFile(deps: FileDeps, folderId: string, fileId: string): Promise<Uint8Array>;
/**
 * Remove an entry from `folderId`. A file entry also reports every chunk its
 * manifest references in `chunkRefDeltas.removed`, so the server's refcounts
 * fall and the bytes stop counting against the storage workspace (see
 * `commitFolderOps`'s doc comment for when removals are applied). A folder
 * entry is just dropped from its parent; its own index row stays on the
 * server, unreachable - reclaiming it is a follow-up. Like `updateFile`,
 * nothing is re-sealed here, so a concurrent re-key only retries the commit.
 */
export declare function deleteEntry(deps: FileDeps, folderId: string, entryId: string): Promise<void>;
