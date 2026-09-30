/**
 * Chunk transport (spec §5.5 / §18 "thin Worker"): moves ENCRYPTED chunk
 * bytes to/from R2 via presigned URLs the server hands back (see
 * `ApiClient.chunkUploadUrl`/`chunkDownloadUrl` in `./api.js`). The engine
 * never touches R2 credentials or bucket details - it only PUTs/GETs an
 * opaque presigned URL - which is exactly why this is its own injected
 * dependency: production wires a real `fetch`, tests (where the harness's R2
 * credentials are fake - see the plan's Global Constraints) wire the
 * in-memory implementation below instead, with no change to `file.ts`.
 */
export interface ChunkTransport {
    /** PUT `bytes` (already AEAD ciphertext - see `file.ts`) to a presigned upload URL. */
    putChunk(url: string, bytes: Uint8Array): Promise<void>;
    /** GET the ciphertext bytes previously PUT to a presigned URL (or its matching presigned download URL). */
    getChunk(url: string): Promise<Uint8Array>;
}
/** Real R2 transport: presigned URLs are plain HTTP PUT/GET, no auth headers needed (the URL itself is the credential). */
export declare function createFetchChunkTransport(fetchFn?: typeof fetch): ChunkTransport;
/**
 * In-memory `ChunkTransport` for tests: a `Map<url, bytes>` standing in for
 * R2. `store` is exposed read-only so a test can assert directly on what
 * would have hit the wire - in particular, that every stored value is AEAD
 * ciphertext and the original plaintext never appears there (see
 * e2ee-client-file.int.test.ts's no-plaintext-leak assertion).
 */
export interface InMemoryChunkTransport extends ChunkTransport {
    readonly store: ReadonlyMap<string, Uint8Array>;
}
export declare function createInMemoryChunkTransport(): InMemoryChunkTransport;
