import type { Box } from './records.js';
export interface JournalApi {
    getKey(): Promise<{
        enc: string;
        ct: string;
    } | null>;
    /** Rejects with KeyExistsError (HTTP 409) when the user already has a key. */
    putKey(sealed: {
        enc: string;
        ct: string;
    }): Promise<void>;
    /** Also deletes every journal of the user. */
    deleteKey(): Promise<void>;
    /**
     * The lowest and highest seq of the caller's journal (both null when it is
     * empty), with no batch body: GET .../journal?head=1. The engine syncs
     * from this and pulls only when there is something after what it applied.
     */
    head(workspaceId: string): Promise<{
        first_seq: number | null;
        last_seq: number | null;
    }>;
    /**
     * Batches with seq > after, ascending; `next` is the `after` for the following page, null at the end.
     * `first_seq` is the journal's lowest seq when the page was read (null: empty), so a journal deleted
     * and re-created between head() and pull() is still noticed.
     */
    pull(workspaceId: string, after: number): Promise<{
        batches: {
            seq: number;
            body: Uint8Array;
        }[];
        next: number | null;
        first_seq?: number | null;
    }>;
    /**
     * POST the sealed batch. Only `create: true` may start an empty journal;
     * without it, an empty journal (deleted on another device) rejects with
     * JournalGoneError (HTTP 409 personas_journal_gone) and nothing is written.
     * Over the journal's or the user's storage cap it rejects with
     * JournalFullError (HTTP 413 personas_journal_full or personas_quota).
     */
    append(workspaceId: string, body: Uint8Array, opts?: {
        create?: boolean;
    }): Promise<{
        seq: number;
    }>;
    deleteJournal(workspaceId: string): Promise<void>;
}
export interface LocalCache {
    load(userId: string, workspaceId: string): Promise<Uint8Array | null>;
    save(userId: string, workspaceId: string, sealedSnapshot: Uint8Array): Promise<void>;
    clear(userId: string, workspaceId?: string): Promise<void>;
}
/** Holds an opaque per-user record the engine writes (the personas key and a check value); store the bytes as given. */
export interface KeyStore {
    get(userId: string): Promise<Uint8Array | null>;
    set(userId: string, key: Uint8Array): Promise<void>;
    clear(userId: string): Promise<void>;
}
export interface ReadFace {
    box: Box;
    sig: Float32Array;
    score: number;
}
/** Throws ReaderUnsupportedError for input it cannot decode. */
export interface FaceReaderPort {
    read(photo: Uint8Array): Promise<ReadFace[]>;
}
export interface Candidate {
    file: string;
    ver: number;
    /** The folder holding the file; null at the workspace root. */
    folder: string | null;
    /** Every folder id above `folder`, any order ([] at the root). Skipping a folder skips everything under it. */
    ancestors: string[];
    sortAt: number;
}
export interface FileSource {
    /** Every image the user can list: no trash, no hidden, no locked, no Vault. */
    candidates(workspaceId: string): AsyncIterable<Candidate>;
    /**
     * GET /api/files/:id/thumb?w=1600. `signal` aborts with the readSome call
     * that asked; a source may ignore it (the engine drops the photo anyway).
     */
    rendition(file: string, ver: number, signal?: AbortSignal): Promise<Uint8Array>;
}
export interface IdentityUnlock {
    userId: string;
    x25519Pub: Uint8Array;
    x25519Priv: Uint8Array;
}
export declare class ReaderUnsupportedError extends Error {
    constructor(message?: string);
}
/** JournalApi.putKey: the user already has a personas key (HTTP 409). */
export declare class KeyExistsError extends Error {
    constructor(message?: string);
}
/** JournalApi.append without create: the user's journal for the workspace is empty, so it was deleted elsewhere (HTTP 409 personas_journal_gone). */
export declare class JournalGoneError extends Error {
    constructor(message?: string);
}
/**
 * JournalApi.append: the journal is at its size cap for the workspace (HTTP 413
 * personas_journal_full) or the user's journals together are at theirs (HTTP
 * 413 personas_quota). Nothing was written. The engine stops reading on this
 * instance until the index is deleted.
 */
export declare class JournalFullError extends Error {
    readonly code: string;
    constructor(code?: string);
}
