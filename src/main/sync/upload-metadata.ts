import { stat, utimes } from "fs/promises";
import type { Stats } from "fs";

/**
 * The metadata that travels with an upload or comes back with a download,
 * kept pure (and a leaf) so `node --test` can pin the wire shapes without
 * loading the transport.
 *
 * Contract 1 (upload init version guard): an update names the version it is
 * overwriting as `expected_version`; the server answers 409
 * `{ error: "version_conflict", current_version }` when someone else got
 * there first. The engine turns that into a conflict (keep-both by default)
 * instead of a per-file error, because "the server has a newer copy" is a
 * decision for the planner, not a failure.
 *
 * Contract 2 (source mtime): every upload carries the local file's mtime as
 * unix SECONDS in X-Dosya-Source-Mtime (single PUT and multipart complete) or
 * `source_modified_at` (batch/commit entries) - the same shape the web client
 * sends - so "Date modified" on the server is the file's date, not the upload's.
 * Downloads apply the server's source mtime so the same file is not "modified
 * today" on every device it lands on.
 */

/** Same header, same casing the web client uses (upload-runner.ts). */
export const SOURCE_MTIME_HEADER = "X-Dosya-Source-Mtime";

/** Unix seconds for a stat mtime, or null when the value cannot be trusted. */
export function sourceMtimeSeconds(mtimeMs: number): number | null {
  if (!Number.isFinite(mtimeMs) || mtimeMs <= 0) return null;
  return Math.floor(mtimeMs / 1000);
}

/** The header object to spread into an upload request; empty when unknown. */
export function sourceMtimeHeaders(mtimeMs: number): Record<string, string> {
  const secs = sourceMtimeSeconds(mtimeMs);
  return secs === null ? {} : { [SOURCE_MTIME_HEADER]: String(secs) };
}

export interface UploadInitInput {
  workspaceId: string;
  fileName: string;
  fileSize: number;
  mimeType: string;
  folderId: string | null;
  region: string;
  /** The file this upload replaces, when it is a new version of one. */
  fileId?: string | null;
  /** The base record's remote version - what the client believes it is overwriting. */
  expectedVersion?: number | null;
}

/**
 * Whether an update should carry a version guard at all.
 *
 * Two cases send none, and both are the client deliberately overruling the
 * server rather than asking it to arbitrate:
 *  - a keep-local resolution: the user looked at the conflict and chose the
 *    local copy. Re-sending the stale expected_version 409s forever, so
 *    "keep local" could never resolve anything (fix round 1, F4).
 *  - a last-write-wins pair: that setting IS "local wins", decided before the
 *    upload was planned. A 409 would raise a conflict the pair has said it
 *    does not want.
 * keep-both is the strategy that wants conflicts surfaced, so it guards.
 */
export function shouldSendVersionGuard(input: {
  conflictStrategy: "last-write-wins" | "keep-both" | undefined;
  /** "sync" = a plan the engine made; "keep-local" = the user chose local. */
  reason: "sync" | "keep-local";
}): boolean {
  if (input.reason === "keep-local") return false;
  return (input.conflictStrategy ?? "keep-both") === "keep-both";
}

/**
 * The value to send, or null for "send no guard". Only an update (a file we
 * already track remotely) of a file whose base version we actually know can
 * carry one - a create has nothing to guard, and a guessed version is worse
 * than none.
 */
export function expectedVersionFor(input: {
  baseVersion: number | null | undefined;
  isUpdate: boolean;
  sendGuard: boolean;
}): number | null {
  if (!input.isUpdate || !input.sendGuard) return null;
  const v = input.baseVersion;
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
}

/**
 * `source_modified_at: <unix seconds>` when the file's own date is known,
 * else nothing. Omitted rather than sent as null: the server treats an absent
 * field as "no opinion", while an explicit null would still be a value the
 * body-wins rule has to honour.
 */
function sourceModifiedField(mtimeSeconds: number | null | undefined): Record<string, number> {
  return typeof mtimeSeconds === "number" && Number.isFinite(mtimeSeconds) && mtimeSeconds > 0
    ? { source_modified_at: Math.floor(mtimeSeconds) }
    : {};
}

/** `expected_version: n` when there is a guard to send, else nothing. */
function versionGuardField(expectedVersion: number | null | undefined): Record<string, number> {
  return typeof expectedVersion === "number" && Number.isFinite(expectedVersion) && expectedVersion > 0
    ? { expected_version: expectedVersion }
    : {};
}

/** Body for POST /api/upload/init. expected_version rides only on an update with a known version. */
export function buildUploadInitBody(input: UploadInitInput): Record<string, unknown> {
  const body: Record<string, unknown> = {
    workspace_id: input.workspaceId,
    file_name: input.fileName,
    file_size: input.fileSize,
    mime_type: input.mimeType,
    folder_id: input.folderId,
    region: input.region,
  };
  if (input.fileId) {
    body.file_id = input.fileId;
    Object.assign(body, versionGuardField(input.expectedVersion));
  }
  return body;
}

/**
 * Body for POST /api/sync/chunks/commit - the delta path, which runs BEFORE
 * /api/upload/init and therefore carried no guard at all until fix round 1.
 *
 * It also carries the file's own modification time (Contract 2). This was the
 * last upload door still dropping it, so a block-level version bump stored
 * NULL and the file read as "modified today" on every other device. The
 * server accepts the body field or the X-Dosya-Source-Mtime header and lets
 * the body win; sending it here keeps the two from ever disagreeing.
 */
export function buildChunksCommitBody(input: {
  workspaceId: string;
  region: string;
  fileId: string | null;
  folderId: string | null;
  name: string;
  size: number;
  contentType: string;
  ext: string | null;
  chunks: { hash: string; size: number }[];
  expectedVersion?: number | null;
  /** The local file's mtime in unix SECONDS (sourceMtimeSeconds). */
  sourceModifiedAt?: number | null;
}): Record<string, unknown> {
  return {
    workspace_id: input.workspaceId,
    region: input.region,
    file_id: input.fileId,
    folder_id: input.folderId,
    name: input.name,
    size: input.size,
    content_type: input.contentType,
    ext: input.ext,
    chunks: input.chunks,
    ...sourceModifiedField(input.sourceModifiedAt),
    ...(input.fileId ? versionGuardField(input.expectedVersion) : {}),
  };
}

/** One entry of POST /api/sync/commit - the bulk push path. */
export function buildCommitEntry(input: {
  fileId: string;
  r2Key: string;
  name: string;
  size: number;
  folderId: string | null;
  contentType: string;
  ext: string | null;
  sourceModifiedAt: number | null;
  expectedVersion?: number | null;
}): Record<string, unknown> {
  return {
    file_id: input.fileId,
    r2_key: input.r2Key,
    name: input.name,
    size: input.size,
    folder_id: input.folderId,
    content_type: input.contentType,
    ext: input.ext,
    source_modified_at: input.sourceModifiedAt,
    ...versionGuardField(input.expectedVersion),
  };
}

/**
 * Per-entry version conflicts in a bulk response, keyed by file id with the
 * server's current version (null when it did not say). A bulk endpoint
 * answers 200 with per-file results, so a whole-response 409 check would miss
 * every one of them.
 */
export function collectEntryVersionConflicts(rows: unknown): Map<string, number | null> {
  const out = new Map<string, number | null>();
  if (!Array.isArray(rows)) return out;
  for (const row of rows) {
    const r = row as { file_id?: unknown; id?: unknown; error?: unknown; current_version?: unknown } | null;
    if (!r || r.error !== "version_conflict") continue;
    const id = typeof r.file_id === "string" ? r.file_id : typeof r.id === "string" ? r.id : null;
    if (!id) continue;
    out.set(id, typeof r.current_version === "number" && Number.isFinite(r.current_version) ? r.current_version : null);
  }
  return out;
}

/** The server refused an update because the file moved on since we last synced it. */
export class VersionConflictError extends Error {
  readonly currentVersion: number | null;
  constructor(currentVersion: number | null) {
    super("VERSION_CONFLICT");
    this.name = "VersionConflictError";
    this.currentVersion = currentVersion;
  }
}

/** A VersionConflictError for a 409 version_conflict response, else null. */
export function versionConflictFrom(status: number, body: unknown): VersionConflictError | null {
  if (status !== 409) return null;
  const b = body as { error?: unknown; current_version?: unknown } | null;
  if (!b || b.error !== "version_conflict") return null;
  const cv = typeof b.current_version === "number" && Number.isFinite(b.current_version) ? b.current_version : null;
  return new VersionConflictError(cv);
}

export function isVersionConflict(err: unknown): err is VersionConflictError {
  return err instanceof VersionConflictError;
}

/**
 * Give a downloaded file the server's source mtime (unix seconds), then
 * return the fresh stat - the caller records THAT mtime in the base record,
 * or the next scan reads the utimes as a local edit and re-uploads.
 * Anything implausible leaves the file alone and just returns its stat.
 */
export async function applyDownloadedMtime(absPath: string, sourceModifiedAt: number | null | undefined): Promise<Stats> {
  if (typeof sourceModifiedAt === "number" && Number.isFinite(sourceModifiedAt) && sourceModifiedAt > 0) {
    const when = new Date(sourceModifiedAt * 1000);
    await utimes(absPath, new Date(), when).catch(() => {
      // A volume that refuses utimes (some network shares) still has the file;
      // the record simply carries the download time.
    });
  }
  return stat(absPath);
}
