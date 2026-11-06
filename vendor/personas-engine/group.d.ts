/** Cosine threshold (SFace reference value, ruling R1). */
export declare const MATCH_THRESHOLD = 0.363;
/** A persona shows only with at least this many faces. */
export declare const MIN_PERSONA_FACES = 3;
/** Best centroid at or above MATCH_THRESHOLD; ties: named first, then id ascending. */
export declare function nearestPersona(vector: Float32Array, centroids: {
    id: string;
    vector: Float32Array;
    named: boolean;
}[]): {
    id: string;
    similarity: number;
} | null;
/**
 * Average-linkage agglomerative clustering over cosine similarity. Merges while
 * the best pair's average similarity is >= threshold. O(n^2) memory (Float32Array),
 * Lance-Williams updates, per-row nearest-neighbour cache. Deterministic: faces
 * are processed in id order, ties resolve to the lowest indexes.
 */
export declare function clusterPool(faces: {
    id: string;
    vector: Float32Array;
}[], threshold: number, minSize: number): string[][];
/** Running mean of n vectors plus one, re-normalised to unit length. Returns a new array. */
export declare function updateCentroid(old: Float32Array, n: number, added: Float32Array): Float32Array;
