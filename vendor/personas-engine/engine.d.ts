import { type Box } from './records.js';
import { type FaceReaderPort, type FileSource, type IdentityUnlock, type JournalApi, type KeyStore, type LocalCache } from './ports.js';
export type EngineStatus = {
    state: 'needs_identity';
} | {
    state: 'needs_unlock';
} | {
    state: 'off';
} | {
    state: 'ready';
    read: number;
    total: number | null;
    reading: boolean;
    paused: boolean;
};
export interface PersonaCard {
    id: string;
    name: string | null;
    face_count: number;
    photo_count: number;
    cover_face_id: string;
    cover_file_id: string;
    cover_box: Box;
}
export type PersonasEngineErrorCode = 'not_ready' | 'not_found' | 'invalid' | 'name_invalid' | 'name_taken';
export declare class PersonasEngineError extends Error {
    readonly code: PersonasEngineErrorCode;
    constructor(code: PersonasEngineErrorCode);
}
export interface EngineDeps {
    api: JournalApi;
    cache: LocalCache;
    keys: KeyStore;
    reader: FaceReaderPort;
    files: FileSource;
    userId: string;
    workspaceId: string;
    deviceId: string;
    hasIdentity: () => Promise<boolean>;
    now?: () => number;
    newId?: () => string;
    /**
     * Photos in flight at once: each fetches its rendition and then waits for
     * the reader, so downloads overlap reading, and a reader that reads several
     * photos at a time (a pool of workers) is kept busy. Results are still
     * journaled in the order the photos were started. Default 4.
     */
    readAhead?: number;
}
export declare class PersonasEngine {
    private readonly d;
    private state;
    private wsKey;
    /** The cached key matched the server's sealed key this session. */
    private verified;
    private synced;
    private paused;
    private reading;
    /**
     * The server refused an append as over a storage cap: this instance reads
     * no more (and retries nothing) until the index is deleted or reset.
     */
    private full;
    /** The state moved past the saved snapshot; saveCache() writes it. */
    private dirty;
    /** Last candidate walk: eligible file -> version. */
    private eligible;
    /** `${file}:${ver}` -> failed reads this session. */
    private attempts;
    private skipped;
    private listeners;
    private lock;
    /** Bumped when the index is deleted here; reads started before drop their records. */
    private gen;
    constructor(deps: EngineDeps);
    /**
     * The gate the screens show. Throws (the network error) when the first sync
     * fails and there is no cached index to answer from; hosts catch it and retry.
     */
    status(): Promise<EngineStatus>;
    /** Opens the user's personas key with the unlocked identity, or creates and seals it if there is none; caches it. */
    unlockWith(identity: IdentityUnlock): Promise<void>;
    /**
     * Loads the cached key and snapshot once. False when there is no usable
     * key (status needs_unlock). On first load the key is checked against the
     * server's sealed key; a different or missing one means it was replaced.
     */
    private prepare;
    /** The cached key does not fit this user's journal: forget it and everything derived from it. */
    private lockOut;
    sync(): Promise<void>;
    /**
     * Pull and apply everything after `applied`; marks the state dirty if
     * anything changed (the outer operation saves it once). The head answers
     * "nothing new" without a batch body. The journal is append-only and a seq
     * is never reused, so while it still holds the batches this index applied,
     * its first seq is at most `applied`: a first seq above it (or none) means
     * it was deleted elsewhere, maybe re-created, and the index restarts.
     */
    private syncLocked;
    /**
     * The journal was deleted, maybe with the key: forget the local index and
     * check the key again (prepare) before reading or writing anything under
     * it. False when there is no usable key.
     */
    private restart;
    /** Forget everything derived from the journal and the cached key's check; the next prepare() starts over. */
    private resetLocal;
    /**
     * Seal and write the whole index, only if it changed since the last save.
     * The snapshot grows with the index (about 850 bytes a face), so it is
     * written once per outer operation (a sync, a readSome call, a persona
     * action), never per journal append.
     */
    private saveCache;
    /** Inside the lock: run fn, then save the index once if it changed (also after fn failed; then a save error is not reported over fn's). */
    private saving;
    /**
     * Append recs (split at the record limit, order kept) and apply them by
     * syncing. Inside the lock. Only `create` (turnOn) may start an empty
     * journal; any other append the server refuses as gone means the journal
     * was deleted elsewhere: the index resets, the records are dropped (not
     * retried) and the caller gets not_ready.
     */
    private commit;
    /**
     * The journal was deleted on another device: reads in flight drop their
     * records (gen), then the same reset as the sync probe's, and a fresh pull
     * (the key is checked again first). Inside the lock.
     */
    private journalGone;
    /** Run a change under the lock with the index loaded and on; then notify. */
    private mutate;
    private exclusive;
    skippedBatches(): number;
    turnOn(): Promise<void>;
    turnOff(): Promise<void>;
    deleteIndex(): Promise<void>;
    setPaused(p: boolean): void;
    isPaused(): boolean;
    private readCount;
    /**
     * Read up to `max` unread photos and journal them in batches. The index
     * snapshot is saved once, when the call ends. Over a storage cap (the
     * server refused an append with JournalFullError) it stops, resolves with
     * what it journaled, and later calls read nothing.
     */
    readSome(max: number, signal?: AbortSignal): Promise<number>;
    private readBatches;
    /** A read result that will not be journaled: if it records a failure, forget the failed tries. */
    private forgetFailure;
    /** flush(), or null (and reading stops) when the server refused the batch as over a storage cap. */
    private flushOrFull;
    /** The records for one photo, or null when it failed and may be tried again later this session. */
    private readOne;
    /**
     * Journal one read batch, then group the faces that landed and journal
     * that. Under the lock, photos whose folder was skipped meanwhile are
     * dropped, and nothing is written if the index was deleted since `gen`.
     * Returns the photos journaled.
     */
    private flush;
    private inSkipped;
    subscribe(fn: () => void): () => void;
    private notify;
    private visible;
    /** Null only if none of its faces is in the index (never after a clean replay). */
    private card;
    private visibleCards;
    /** The visible personas, named first; with q, the named ones whose name starts with it. */
    listPersonas(q?: string): PersonaCard[];
    /** A persona's photos, newest sortAt first (ties: file id), one row per photo. */
    personaPhotos(pid: string, cursor?: string | null, limit?: number): {
        persona: PersonaCard;
        files: {
            file_id: string;
            face_id: string;
            box: Box;
        }[];
        next: string | null;
    };
    /** The faces in one photo, in read order; persona fields only for a visible persona. */
    peopleInFile(fileId: string): {
        persona_id: string | null;
        name: string | null;
        face_id: string;
        box: Box;
    }[];
    /** Named visible personas whose name starts with prefix: exact match first, then most faces. */
    findByName(prefix: string, limit?: number): PersonaCard[];
    skippedFolders(): string[];
    private persona;
    rename(pid: string, name: string): Promise<void>;
    setCover(pid: string, faceId: string): Promise<void>;
    /** If exactly one side is named it survives; otherwise `into` does. Returns the survivor. */
    merge(into: string, from: string): Promise<string>;
    /** Remove person: the drop (which deletes the faces), then a tomb for each of its faces' positions. */
    removePersona(pid: string): Promise<void>;
    notThisPerson(faceId: string): Promise<void>;
    /** Skipping a folder also takes its photos' faces out (gone); un-skipping lets them be read again. */
    skipFolder(folderId: string, on: boolean): Promise<void>;
}
