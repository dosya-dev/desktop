import { constants as fsConstants } from "node:fs";
import { copyFile, link, lstat, mkdir, realpath, rename, stat, unlink, utimes } from "node:fs/promises";
import { join } from "node:path";
import { hasProtectedSegment, windowsUnsafePath } from "./ignore-rules";
import { isPathWithinRoot } from "./paths";

export class UnsafeSyncPathError extends Error {
  readonly code = "UNSAFE_SYNC_PATH";

  constructor(relPath: string, reason: string) {
    super(`Unsafe sync path "${relPath}": ${reason}`);
    this.name = "UnsafeSyncPathError";
  }
}

export function prepareSafeSyncPath(
  syncRoot: string,
  relPath: string,
  options: { kind: "file" | "directory"; createParents: boolean; allowMissingParents: true },
): Promise<string | null>;
export function prepareSafeSyncPath(
  syncRoot: string,
  relPath: string,
  options: { kind: "file" | "directory"; createParents: boolean; allowMissingParents?: false },
): Promise<string>;
export async function prepareSafeSyncPath(
  syncRoot: string,
  relPath: string,
  options: { kind: "file" | "directory"; createParents: boolean; allowMissingParents?: boolean },
): Promise<string | null> {
  if (!isPathWithinRoot(syncRoot, relPath)) {
    throw new UnsafeSyncPathError(relPath, "outside the sync root or invalid relative path");
  }
  // Every local write, move, and delete passes through here, so the hard
  // denylist holds even where a caller forgot to apply the pair's rules.
  if (hasProtectedSegment(relPath)) {
    throw new UnsafeSyncPathError(relPath, "Git metadata (.git) is never synced");
  }
  const windowsReason = windowsUnsafePath(relPath);
  if (windowsReason) throw new UnsafeSyncPathError(relPath, windowsReason);

  let root: string;
  try {
    root = await realpath(syncRoot);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("sync root is not a directory");
    }
  } catch {
    throw new UnsafeSyncPathError(relPath, "sync root cannot be verified");
  }

  // Backslash is a real separator on Windows, but a valid filename character
  // on POSIX. Match the platform's path interpretation after lexical checking.
  const segments = (process.platform === "win32" ? relPath.split(/[\\/]/) : relPath.split("/"))
    .filter(Boolean);
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    current = join(current, segments[i]);
    const isLeafFile = options.kind === "file" && i === segments.length - 1;
    let entry;
    try {
      entry = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new UnsafeSyncPathError(relPath, `cannot inspect "${segments[i]}"`);
      }
      if (isLeafFile) return current;
      if (!options.createParents) {
        if (options.allowMissingParents) return null;
        throw new UnsafeSyncPathError(relPath, `missing directory "${segments[i]}"`);
      }
      try {
        await mkdir(current);
      } catch (createError) {
        // Another process may have created it after lstat. Inspect the result.
        if ((createError as NodeJS.ErrnoException).code !== "EEXIST") {
          throw new UnsafeSyncPathError(relPath, `cannot create directory "${segments[i]}"`);
        }
      }
      try {
        entry = await lstat(current);
      } catch {
        throw new UnsafeSyncPathError(relPath, `cannot inspect "${segments[i]}" after creation`);
      }
    }

    if (entry.isSymbolicLink()) {
      throw new UnsafeSyncPathError(relPath, `symbolic link or junction at "${segments[i]}"`);
    }
    if (isLeafFile ? !entry.isFile() : !entry.isDirectory()) {
      throw new UnsafeSyncPathError(relPath, `unexpected filesystem entry at "${segments[i]}"`);
    }
  }
  return current;
}

/**
 * True when `to` exists and is not the same filesystem object as `from`.
 * Lets a case-only rename (`a.txt` -> `A.txt` on a case-folding filesystem,
 * one inode) through while refusing a rename that would replace another file.
 */
export async function occupiedByOtherFile(from: string, to: string): Promise<boolean> {
  let target;
  try {
    target = await lstat(to, { bigint: true });
  } catch {
    return false;
  }
  try {
    const source = await lstat(from, { bigint: true });
    return !(source.dev === target.dev && source.ino === target.ino && source.ino !== 0n);
  } catch {
    return true;
  }
}

/**
 * Move `from` to `to` without ever replacing a file at `to`. fs.rename
 * replaces silently, so a file created at the destination after the
 * occupancy check (the window between check and rename) was lost. A hard
 * link fails with EEXIST instead; where links are unsupported (FAT, exFAT,
 * some network shares) or cross devices, an exclusive copy does the same.
 * Only a case-only rename of this same file (one inode on a case-folding
 * filesystem) uses rename, since link and copy would see it as occupied.
 * Throws an error with code "EEXIST" when the destination is taken.
 */
export async function moveNoReplace(from: string, to: string): Promise<void> {
  const target = await lstat(to, { bigint: true }).catch(() => null);
  if (target) {
    const source = await lstat(from, { bigint: true });
    if (source.dev === target.dev && source.ino === target.ino && source.ino !== 0n) {
      await rename(from, to);
      return;
    }
    throw Object.assign(new Error(`destination exists: ${to}`), { code: "EEXIST" });
  }
  try {
    await link(from, to);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw error;
    // No hard links here: copy, refusing to overwrite, then keep the times.
    const source = await stat(from);
    await copyFile(from, to, fsConstants.COPYFILE_EXCL);
    await utimes(to, source.atime, source.mtime).catch(() => {});
  }
  try {
    await unlink(from);
  } catch (error) {
    // The old name could not go (open elsewhere on Windows): undo the new
    // name so the move either happened or did not, never half.
    await unlink(to).catch(() => {});
    throw error;
  }
}
