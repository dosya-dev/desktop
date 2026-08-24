import { readdir } from "fs/promises";
import { join } from "path";

export interface FolderEstimate {
  files: number;
  folders: number;
  truncated: boolean;
}

/**
 * Cheap folder-size preflight for the Add-folder modal: Dirent-only BFS (no
 * stat calls, symlinks not followed) with entry and time budgets, so the UI
 * can warn about a 500K-file tree BEFORE the user starts syncing it. Denied
 * directories are simply not counted - this is an estimate, not a scan.
 */
export async function estimateFolder(
  root: string,
  opts?: { maxEntries?: number; timeBudgetMs?: number },
): Promise<FolderEstimate> {
  const maxEntries = opts?.maxEntries ?? 200_000;
  const timeBudgetMs = opts?.timeBudgetMs ?? 5_000;
  const start = Date.now();

  let files = 0;
  let folders = 0;
  let truncated = false;
  const queue: string[] = [root];

  while (queue.length > 0) {
    if (files + folders >= maxEntries || Date.now() - start > timeBudgetMs) {
      truncated = true;
      break;
    }
    const dir = queue.shift()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // unreadable - not counted, this is only an estimate
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        folders++;
        queue.push(join(dir, entry.name));
      } else if (entry.isFile()) {
        files++;
      }
      // Symlinks and special files are ignored, matching the sync scanner.
    }
  }

  return { files, folders, truncated };
}
