/**
 * Content-defined chunking (FastCDC-style) for block-level / delta sync.
 *
 * Splits a file into variable-length chunks at boundaries determined by the
 * *content* (a rolling gear hash), not fixed offsets. The key property: when
 * you insert or remove bytes in the middle of a file, only the chunks around
 * the edit change - every other chunk keeps the same hash and can be skipped on
 * upload. That's what makes delta sync possible.
 *
 * This module is pure and deterministic (fixed gear table, no RNG), so its
 * output is stable across machines - a prerequisite for cross-client dedup.
 * It is the client half of feature #3 in docs/desktop-native-features-spec.md;
 * the server chunk store is a separate piece.
 *
 * Memory: `chunkFile` streams - it holds at most one in-flight chunk
 * (≤ maxSize) plus the current read buffer, never the whole file.
 */

import { createReadStream } from "fs";
import { createHash } from "crypto";
import { longPath } from "./paths";

export interface Chunk {
  /** Byte offset of this chunk within the file. */
  offset: number;
  /** Length of this chunk in bytes. */
  size: number;
  /** Strong content hash (sha256, hex) - the chunk's identity for dedup. */
  hash: string;
}

export interface ChunkOptions {
  minSize?: number;
  avgSize?: number;
  maxSize?: number;
}

interface ResolvedParams {
  min: number;
  avg: number;
  max: number;
  maskS: number;
  maskL: number;
}

const DEFAULTS = { min: 256 * 1024, avg: 1024 * 1024, max: 4 * 1024 * 1024 };

/**
 * Deterministic 256-entry gear table derived from a fixed seed (xorshift32),
 * so chunk boundaries are identical everywhere - no Math.random.
 */
const GEAR: Uint32Array = (() => {
  const g = new Uint32Array(256);
  let s = 0x9e3779b9 >>> 0;
  for (let i = 0; i < 256; i++) {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    g[i] = s >>> 0;
  }
  return g;
})();

function resolveParams(opts?: ChunkOptions): ResolvedParams {
  const avg = opts?.avgSize ?? DEFAULTS.avg;
  const min = opts?.minSize ?? DEFAULTS.min;
  const max = opts?.maxSize ?? DEFAULTS.max;
  // Normalized chunking (NC=2): a stricter mask before the average size makes
  // early cuts rare, a looser mask after it makes late cuts likely → chunk
  // sizes cluster tightly around `avg`.
  const bits = Math.round(Math.log2(avg));
  const maskS = ((1 << Math.min(31, bits + 2)) - 1) >>> 0;
  const maskL = ((1 << Math.max(1, bits - 2)) - 1) >>> 0;
  return { min, avg, max, maskS, maskL };
}

function sha256(buf: Uint8Array): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Chunk an in-memory buffer. This is the reference implementation of the cut
 * algorithm; `chunkFile` streams the identical logic.
 */
export function chunkBuffer(buf: Uint8Array, opts?: ChunkOptions): Chunk[] {
  const { min, avg, max, maskS, maskL } = resolveParams(opts);
  const n = buf.length;
  const chunks: Chunk[] = [];
  let start = 0;

  while (start < n) {
    const hardEnd = Math.min(start + max, n);
    let fp = 0 >>> 0;
    let end = hardEnd; // default: cut at maxSize or EOF
    for (let i = start; i < hardEnd; i++) {
      fp = ((fp << 1) + GEAR[buf[i]!]) >>> 0;
      const len = i - start + 1;
      if (len < min) continue;
      const mask = len < avg ? maskS : maskL;
      if ((fp & mask) === 0) { end = i + 1; break; }
    }
    chunks.push({ offset: start, size: end - start, hash: sha256(buf.subarray(start, end)) });
    start = end;
  }
  return chunks;
}

/**
 * Chunk a file on disk without loading it into memory. Streams the read and
 * finalizes each chunk's hash as its boundary is reached.
 */
export function chunkFile(path: string, opts?: ChunkOptions): Promise<Chunk[]> {
  const { min, avg, max, maskS, maskL } = resolveParams(opts);
  return new Promise((resolve, reject) => {
    const stream = createReadStream(longPath(path));
    const chunks: Chunk[] = [];

    let fp = 0 >>> 0;
    let chunkStart = 0; // absolute offset of the current chunk
    let chunkLen = 0;    // bytes accumulated into the current chunk
    let hash = createHash("sha256");

    const finalize = () => {
      chunks.push({ offset: chunkStart, size: chunkLen, hash: hash.digest("hex") });
      chunkStart += chunkLen;
      chunkLen = 0;
      fp = 0 >>> 0;
      hash = createHash("sha256");
    };

    stream.on("data", (data: string | Buffer) => {
      const buf = typeof data === "string" ? Buffer.from(data) : data;
      let sliceStart = 0; // start of the current chunk's bytes within this buffer
      for (let j = 0; j < buf.length; j++) {
        fp = ((fp << 1) + GEAR[buf[j]!]) >>> 0;
        chunkLen++;
        if (chunkLen < min) continue;
        const mask = chunkLen < avg ? maskS : maskL;
        if ((fp & mask) === 0 || chunkLen >= max) {
          hash.update(buf.subarray(sliceStart, j + 1));
          sliceStart = j + 1;
          finalize();
        }
      }
      // Tail bytes belong to the still-open chunk.
      if (sliceStart < buf.length) hash.update(buf.subarray(sliceStart));
    });
    stream.on("end", () => {
      if (chunkLen > 0) finalize();
      resolve(chunks);
    });
    stream.on("error", reject);
  });
}

export interface ChunkDiff {
  /** Chunks the server doesn't have yet - the only bytes that need uploading. */
  toUpload: Chunk[];
  uploadBytes: number;
  reusedBytes: number;
  totalChunks: number;
}

/**
 * Given the set of chunk hashes already known (server-side or from the previous
 * version), determine which chunks of `chunks` actually need uploading.
 */
export function diffChunks(known: Set<string>, chunks: Chunk[]): ChunkDiff {
  const toUpload: Chunk[] = [];
  let uploadBytes = 0;
  let reusedBytes = 0;
  for (const c of chunks) {
    if (known.has(c.hash)) reusedBytes += c.size;
    else { toUpload.push(c); uploadBytes += c.size; }
  }
  return { toUpload, uploadBytes, reusedBytes, totalChunks: chunks.length };
}

export interface FileDelta {
  /** Full ordered chunk list of the new file - this becomes the new version's manifest. */
  manifest: Chunk[];
  /** Chunks whose hash the server/previous-version doesn't have - the only bytes to send. */
  toUpload: Chunk[];
  uploadBytes: number;
  reusedBytes: number;
  totalBytes: number;
  /** Percentage of bytes avoided vs a full re-upload. */
  savedPct: number;
}

/**
 * The client half of block-level delta upload: chunk the local file, compare
 * against the hashes already known (the previous version's manifest and/or what
 * the server reports it has), and produce the minimal upload plan + the new
 * manifest. The server contract (missing-check, chunk PUT, chunked-commit) is
 * specified in docs/desktop-native-features-spec.md §3.
 */
export async function planFileDelta(
  path: string,
  knownHashes: Set<string>,
  opts?: ChunkOptions,
): Promise<FileDelta> {
  const manifest = await chunkFile(path, opts);
  const { toUpload, uploadBytes, reusedBytes } = diffChunks(knownHashes, manifest);
  const totalBytes = reusedBytes + uploadBytes;
  return {
    manifest,
    toUpload,
    uploadBytes,
    reusedBytes,
    totalBytes,
    savedPct: totalBytes ? (reusedBytes / totalBytes) * 100 : 0,
  };
}
