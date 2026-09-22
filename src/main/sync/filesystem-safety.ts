import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
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
