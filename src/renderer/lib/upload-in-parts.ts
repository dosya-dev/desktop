// apps/desktop/src/renderer/lib/upload-in-parts.ts
//
// One upload flow for the renderer's manual uploads (Upload page, file
// browser drag-drop, "upload new version"). Small files go up as a single
// PUT; anything the server marks `resumable` (over 50 MB) goes through the
// part API in 10 MB pieces, exactly like the sync engine and the web app.
//
// Why: the API sits behind Cloudflare, which refuses any request body over
// 100 MB at the edge - before the Worker runs - so a single PUT of a big file
// died with a bare "Network error" at roughly 10%. Parts never approach that
// ceiling.
//
// This module is deliberately import-free and framework-free so it runs
// under `node --test` (see upload-in-parts.test.ts); the XHR-backed
// transport lives in upload-transport.ts.

export interface ResumableInfo {
  part_size: number;
  total_parts: number;
  part_upload_url: string;
  complete_url: string;
  status_url: string;
}

export interface InitResponse {
  ok: boolean;
  session_id?: string;
  upload_url?: string;
  error?: string;
  resumable?: ResumableInfo | null;
}

export interface PutOptions {
  /** API-relative path, e.g. `/api/upload/<id>/part/3`. */
  path: string;
  body: Blob;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** Bytes of THIS request accepted so far. */
  onProgress?: (loaded: number) => void;
}

export interface HttpResult {
  status: number;
  // Whatever JSON the server answered; `{}` when the body was not JSON.
  data: any;
}

export interface Transport {
  init(body: Record<string, unknown>): Promise<InitResponse>;
  /** Resolves for ANY HTTP status; rejects only when no response arrived
   *  (network drop) or the signal aborted (with an Error named "Cancelled"). */
  put(opts: PutOptions): Promise<HttpResult>;
  post(path: string, headers?: Record<string, string>, signal?: AbortSignal): Promise<HttpResult>;
  sleep?(ms: number): Promise<void>;
}

export interface UploadRequest {
  file: Blob;
  fileName: string;
  mimeType: string;
  workspaceId: string;
  /** Destination folder (null = root). Leave undefined for a new version,
   *  which stays in the file's own folder. */
  folderId?: string | null;
  /** Set for "upload new version"; null/undefined creates a new file. */
  fileId?: string | null;
  /** The source file's mtime, forwarded so the server keeps it. */
  lastModifiedMs?: number;
  signal?: AbortSignal;
  /** Cumulative bytes accepted across the whole file. */
  onProgress?: (bytes: number) => void;
}

export interface UploadOutcome {
  fileId: string | null;
  version?: number;
}

/** Parts in flight at once. Matches the web upload runner. */
export const PART_CONCURRENCY = 3;
/** Total tries per part (first attempt + retries). */
export const PART_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [1000, 3000];

const CANCELLED = "Cancelled";

/** The error an aborted upload rejects with; transports throw it too. */
export function cancelledError(): Error {
  const err = new Error(CANCELLED);
  err.name = CANCELLED;
  return err;
}

/** True for our own cancellation and for a fetch/XHR AbortError. */
export function isUploadCancelled(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return err.name === CANCELLED || err.message === CANCELLED || err.name === "AbortError";
}

const cancelled = cancelledError;
const isCancelled = isUploadCancelled;

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancelled();
}

function sourceMtimeHeaders(lastModifiedMs?: number): Record<string, string> {
  if (!lastModifiedMs) return {};
  const sec = Math.floor(lastModifiedMs / 1000);
  return sec > 0 ? { "X-Dosya-Source-Mtime": String(sec) } : {};
}

function failureMessage(res: HttpResult, fallback: string): string {
  const msg = res.data && typeof res.data.error === "string" ? res.data.error : null;
  return msg || `${fallback} (${res.status})`;
}

function accepted(res: HttpResult): boolean {
  return res.status >= 200 && res.status < 300 && res.data?.ok !== false;
}

/** Run `fn` with the part-loop retry policy: network drops and non-2xx
 *  answers are retried up to PART_ATTEMPTS; an abort is never retried. */
async function withRetry(
  attempt: () => Promise<HttpResult>,
  fallback: string,
  transport: Transport,
  signal?: AbortSignal,
): Promise<HttpResult> {
  let lastErr: Error = new Error(fallback);
  for (let i = 0; i < PART_ATTEMPTS; i++) {
    throwIfAborted(signal);
    try {
      const res = await attempt();
      if (accepted(res)) return res;
      lastErr = new Error(failureMessage(res, fallback));
    } catch (err) {
      if (isCancelled(err)) throw err;
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
    if (i < PART_ATTEMPTS - 1) {
      const delay = RETRY_DELAYS_MS[Math.min(i, RETRY_DELAYS_MS.length - 1)];
      await (transport.sleep ?? defaultSleep)(delay);
    }
  }
  throw lastErr;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export async function uploadFileInParts(req: UploadRequest, transport: Transport): Promise<UploadOutcome> {
  throwIfAborted(req.signal);
  const init = await transport.init({
    workspace_id: req.workspaceId,
    file_name: req.fileName,
    file_size: req.file.size,
    mime_type: req.mimeType || "application/octet-stream",
    ...(req.folderId !== undefined ? { folder_id: req.folderId } : {}),
    ...(req.fileId ? { file_id: req.fileId } : {}),
  });
  if (!init.ok || !init.session_id) throw new Error(init.error || "Upload init failed");
  throwIfAborted(req.signal);

  if (init.resumable) return uploadParts(req, init.session_id, init.resumable, transport);
  return uploadSingle(req, init.upload_url || `/api/upload/${init.session_id}`, transport);
}

async function uploadSingle(req: UploadRequest, path: string, transport: Transport): Promise<UploadOutcome> {
  const res = await transport.put({
    path,
    body: req.file,
    headers: { "Content-Type": req.mimeType || "application/octet-stream", ...sourceMtimeHeaders(req.lastModifiedMs) },
    signal: req.signal,
    onProgress: req.onProgress,
  });
  if (!accepted(res)) throw new Error(failureMessage(res, "Upload failed"));
  req.onProgress?.(req.file.size);
  return { fileId: res.data?.file?.id ?? null, version: res.data?.file?.current_version };
}

async function uploadParts(
  req: UploadRequest,
  sessionId: string,
  info: ResumableInfo,
  transport: Transport,
): Promise<UploadOutcome> {
  const { part_size: partSize, total_parts: totalParts } = info;
  const size = req.file.size;

  // Progress is the sum of finished parts plus each in-flight part's own
  // counter, so it never jumps backwards when a part is retried.
  let settled = 0;
  const inFlight = new Map<number, number>();
  const report = () => {
    if (!req.onProgress) return;
    let live = 0;
    for (const v of inFlight.values()) live += v;
    req.onProgress(Math.min(size, settled + live));
  };

  const sendPart = async (n: number): Promise<void> => {
    const start = (n - 1) * partSize;
    const chunk = req.file.slice(start, Math.min(start + partSize, size));
    await withRetry(
      () => {
        inFlight.set(n, 0);
        return transport.put({
          path: `${info.part_upload_url}/${n}`,
          body: chunk,
          headers: { "Content-Type": "application/octet-stream" },
          signal: req.signal,
          onProgress: (loaded) => { inFlight.set(n, Math.min(loaded, chunk.size)); report(); },
        });
      },
      `Part ${n} failed`,
      transport,
      req.signal,
    );
    inFlight.delete(n);
    settled += chunk.size;
    report();
  };

  // The server creates the R2 multipart upload lazily on the first part it
  // receives. Two first parts racing would each open their own, so part 1 of
  // a fresh session goes alone and the rest fan out once it has landed.
  // Same reasoning as the web runner and apps/cli/src/multipart.ts.
  const queue: number[] = [];
  for (let n = 1; n <= totalParts; n++) queue.push(n);
  await sendPart(queue.shift()!);
  throwIfAborted(req.signal);

  let failure: Error | null = null;
  const worker = async (): Promise<void> => {
    while (queue.length > 0 && !failure && !req.signal?.aborted) {
      const n = queue.shift()!;
      try {
        await sendPart(n);
      } catch (err) {
        failure = err instanceof Error ? err : new Error(String(err));
      }
    }
  };
  const workers: Promise<void>[] = [];
  for (let i = 0; i < Math.min(PART_CONCURRENCY, queue.length); i++) workers.push(worker());
  await Promise.all(workers);
  throwIfAborted(req.signal);
  if (failure) throw failure;

  const res = await withRetry(
    () => transport.post(info.complete_url, sourceMtimeHeaders(req.lastModifiedMs), req.signal),
    "Upload complete failed",
    transport,
    req.signal,
  );
  req.onProgress?.(size);
  return { fileId: res.data?.file?.id ?? null, version: res.data?.file?.current_version };
}
