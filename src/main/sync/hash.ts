/**
 * Fast content hashing for sync dedup.
 *
 * Uses Node.js crypto MD5 (~500 MB/s). Only called on files whose mtime
 * changed — for a typical re-sync that's ~1-2% of files, not all 150K.
 *
 * MD5 is used for speed, not security. We're comparing content identity,
 * not protecting against collision attacks. A hash match means "same content
 * with 99.9999999% probability" — good enough for sync dedup.
 */

import { createHash } from "crypto";
import { createReadStream } from "fs";

/**
 * Compute MD5 hash of a file by streaming (no full file in memory).
 * Returns hex string like "d41d8cd98f00b204e9800998ecf8427e".
 */
export function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("md5");
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

/**
 * Hash multiple files in parallel (up to `concurrency` at a time).
 * Returns a Map of filePath → hash.
 */
export async function hashFiles(
  files: string[],
  concurrency = 10,
): Promise<Map<string, string>> {
  const results = new Map<string, string>();
  let idx = 0;

  const worker = async () => {
    while (idx < files.length) {
      const i = idx++;
      const file = files[i];
      try {
        const hash = await hashFile(file);
        results.set(file, hash);
      } catch {
        // File unreadable — skip, will be caught as "changed" later
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, () => worker()));
  return results;
}
