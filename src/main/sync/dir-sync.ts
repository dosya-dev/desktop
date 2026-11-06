/**
 * Flush a directory's entries to disk, so a rename into it survives a power
 * cut. POSIX only and best-effort: Windows cannot open a directory this way,
 * and some filesystems refuse a directory fsync. The file's own bytes are
 * already flushed by the downloader (FileHandle.sync before the rename);
 * this makes the NAME durable.
 *
 * Its own leaf module so the engine can sync each directory once per batch
 * (a per-file directory fsync cost ~10 ms a download) and tests can stub it.
 */
import { open } from "node:fs/promises";

export async function syncDirectory(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  try {
    const handle = await open(dir, "r");
    try { await handle.sync(); } finally { await handle.close(); }
  } catch {
    // Unsupported here; nothing more we can do.
  }
}
