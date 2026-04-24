import { app, session } from "electron";
import { createReadStream, createWriteStream, readFileSync } from "fs";
import { stat, readFile, rename as fsRename, unlink as fsUnlink } from "fs/promises";
import { basename, extname, resolve as pathResolve } from "path";
import type { RemoteFileInfo, RemoteFolderInfo } from "./types";
import http from "http";
import https from "https";
import { URL } from "url";

// Persistent HTTP agents with keep-alive and higher socket pool.
// Without these, each request opens a new TCP+TLS handshake (~100ms).
// With keep-alive, connections are reused — critical when uploading
// 38K files (saves ~38K x 100ms = ~63 min of handshake overhead).
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 16 });

function agentFor(url: string | URL): http.Agent | https.Agent {
  const protocol = typeof url === "string" ? new URL(url).protocol : url.protocol;
  return protocol === "https:" ? httpsAgent : httpAgent;
}

/**
 * Resolve system proxy for a URL using Electron's session.
 * Returns the proxy URL string (e.g. "http://proxy:8080") or null for DIRECT.
 * Corporate environments with authenticated proxies, PAC files, etc. are
 * handled automatically by Chromium's proxy resolver.
 */
async function resolveProxy(url: string): Promise<string | null> {
  try {
    const proxyInfo = await session.defaultSession.resolveProxy(url);
    // proxyInfo format: "DIRECT" or "PROXY host:port" or "HTTPS host:port"
    if (!proxyInfo || proxyInfo === "DIRECT") return null;
    const match = proxyInfo.match(/^(PROXY|HTTPS)\s+(.+)$/i);
    if (match) {
      const scheme = match[1].toUpperCase() === "HTTPS" ? "https" : "http";
      return `${scheme}://${match[2]}`;
    }
    return null;
  } catch {
    return null;
  }
}

const isDev = !app.isPackaged;
function debugLog(...args: unknown[]): void {
  if (isDev) console.log(...args);
}

const RETRY_DELAYS = [1000, 3000, 8000]; // exponential-ish backoff
const NON_RETRYABLE = new Set(["SESSION_EXPIRED", "RATE_LIMITED"]);
const MAX_FILE_SIZE = 2 * 1024 * 1024 * 1024; // 2 GB

const MIME_MAP: Record<string, string> = {
  pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png",
  gif: "image/gif", webp: "image/webp", svg: "image/svg+xml",
  mp4: "video/mp4", mov: "video/quicktime", avi: "video/x-msvideo", webm: "video/webm",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg",
  zip: "application/zip", gz: "application/gzip", tar: "application/x-tar", "7z": "application/x-7z-compressed", rar: "application/vnd.rar",
  doc: "application/msword", docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint", pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain", csv: "text/csv", json: "application/json", js: "text/javascript", ts: "text/typescript",
  html: "text/html", css: "text/css", xml: "application/xml", md: "text/markdown",
  py: "text/x-python", rb: "text/x-ruby", go: "text/x-go", rs: "text/x-rust",
  java: "text/x-java-source", c: "text/x-c", cpp: "text/x-c++", h: "text/x-c",
  sh: "application/x-sh", yaml: "application/x-yaml", yml: "application/x-yaml",
  ico: "image/x-icon", ttf: "font/ttf", woff: "font/woff", woff2: "font/woff2",
};

/** Custom error class that carries rate-limit metadata. */
export class RateLimitError extends Error {
  readonly retryAfterMs: number;

  constructor(retryAfterMs: number) {
    super("RATE_LIMITED");
    this.name = "RateLimitError";
    this.retryAfterMs = retryAfterMs;
  }
}

/** Rate limit budget tracked from server response headers. */
export interface RateBudget {
  remaining: number;
  resetAt: number; // epoch seconds
  limit: number;
}

/**
 * HTTP client for dosya.dev API, using Electron session cookies.
 * Includes retry with jittered backoff for transient failures.
 * Uses streaming for file uploads/downloads to prevent OOM on large files.
 * Tracks rate limit budget from response headers.
 */
export class RemoteClient {
  /** Current rate limit budget, updated from every API response. */
  rateBudget: RateBudget = { remaining: Infinity, resetAt: 0, limit: 300 };

  /** Cached session cookie to avoid IPC round-trip to Chromium on every request. */
  private cachedCookie: string | null = null;
  private cookieCachedAt = 0;
  private static readonly COOKIE_CACHE_TTL = 60_000; // 60s

  constructor(private apiBase: string) {}

  /** Invalidate the cached cookie (call on login/logout). */
  clearCookieCache(): void {
    this.cachedCookie = null;
    this.cookieCachedAt = 0;
  }

  /**
   * Update rate budget from response headers.
   * Called after every successful or failed response.
   */
  private updateBudget(headers: Record<string, string | string[] | undefined>): void {
    const remaining = headers["x-ratelimit-remaining"];
    const reset = headers["x-ratelimit-reset"];
    const limit = headers["x-ratelimit-limit"];
    if (remaining != null) this.rateBudget.remaining = parseInt(String(remaining), 10);
    if (reset != null) this.rateBudget.resetAt = parseInt(String(reset), 10);
    if (limit != null) this.rateBudget.limit = parseInt(String(limit), 10);
  }

  /**
   * If budget is nearly exhausted, wait until the reset window.
   * This proactively prevents 429 responses.
   */
  private async waitForBudget(): Promise<void> {
    if (this.rateBudget.remaining <= 5 && this.rateBudget.remaining < Infinity) {
      const waitMs = Math.max(0, this.rateBudget.resetAt * 1000 - Date.now());
      if (waitMs > 0 && waitMs < 120_000) {
        debugLog(`[sync] Rate budget low (${this.rateBudget.remaining}), waiting ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs + 500); // +500ms buffer
      }
    }
  }

  /**
   * Parse the Retry-After header value into milliseconds.
   */
  private parseRetryAfter(headers: Record<string, string | string[] | undefined>): number {
    const value = headers["retry-after"];
    if (value == null) return 60_000;
    const seconds = parseInt(String(value), 10);
    if (!isNaN(seconds) && seconds > 0) return seconds * 1000;
    return 60_000;
  }

  /**
   * Create a RateLimitError from response headers.
   */
  private createRateLimitError(headers: Record<string, string | string[] | undefined>): RateLimitError {
    const retryAfterMs = this.parseRetryAfter(headers);
    this.rateBudget.remaining = 0;
    debugLog(`[sync] Rate limited. Retry-After: ${retryAfterMs}ms`);
    return new RateLimitError(retryAfterMs);
  }

  /**
   * Check if a dosya_session cookie exists (without making an API call).
   * Used by the sync engine to decide whether to start.
   */
  async hasSession(): Promise<boolean> {
    const cookie = await this.getSessionCookie();
    return cookie !== null;
  }

  private async getSessionCookie(): Promise<string | null> {
    // Return cached cookie if still fresh — avoids IPC round-trip per request.
    // For a 10K-file sync this saves ~30K–40K async IPC calls.
    if (this.cachedCookie && Date.now() - this.cookieCachedAt < RemoteClient.COOKIE_CACHE_TTL) {
      return this.cachedCookie;
    }

    const apiHost = new URL(this.apiBase).hostname;
    const allSession = await session.defaultSession.cookies.get({ name: "dosya_session" });

    let value: string | null = null;

    // Exact domain match
    const exact = allSession.find(c => c.domain === apiHost);
    if (exact) {
      value = exact.value;
    } else {
      // Dot-prefixed domain match (e.g. ".dosya.dev" for https://dosya.dev)
      const dotMatch = allSession.find(c => {
        if (!c.domain) return false;
        const bare = c.domain.replace(/^\./, "");
        return apiHost === bare || apiHost.endsWith(`.${bare}`);
      });
      if (dotMatch) value = dotMatch.value;
    }

    if (value) {
      this.cachedCookie = value;
      this.cookieCachedAt = Date.now();
    } else {
      this.cachedCookie = null;
      this.cookieCachedAt = 0;
    }

    return value;
  }

  // ── Core fetch for JSON API calls ─────────────────────────────────

  private async fetchOnce(
    path: string,
    opts: { method?: string; body?: Buffer | string; headers?: Record<string, string>; timeout?: number } = {},
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: () => Promise<any>; buffer: () => Promise<Buffer> }> {
    const sessionCookie = await this.getSessionCookie();
    if (!sessionCookie) {
      this.clearCookieCache();
      throw new Error("SESSION_EXPIRED");
    }

    const fullUrl = `${this.apiBase}${path}`;
    const parsed = new URL(fullUrl);
    const isHttps = parsed.protocol === "https:";
    const lib = isHttps ? https : http;

    // Resolve system proxy (supports corporate proxies, PAC files, etc.)
    // Log proxy detection so users behind corporate proxies can debug connectivity.
    const proxyUrl = await resolveProxy(fullUrl);
    if (proxyUrl) {
      debugLog("[sync] Using proxy:", proxyUrl, "for", fullUrl);
    }

    let bodyBuf: Buffer | undefined;
    if (opts.body != null) {
      bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf-8");
    }

    const headers: Record<string, string> = {
      Cookie: `dosya_session=${sessionCookie}`,
      "X-Dosya-Sync": "1",
      ...opts.headers,
    };
    if (bodyBuf) {
      headers["Content-Length"] = String(bodyBuf.length);
    }

    debugLog("[sync] HTTP request:", opts.method ?? "GET", fullUrl, "body-len:", bodyBuf?.length ?? 0);

    return new Promise((resolve, reject) => {
      const timeout = opts.timeout ?? 30_000;
      const req = lib.request(
        fullUrl,
        { method: opts.method ?? "GET", headers, timeout, agent: agentFor(fullUrl) },
        (res) => {
          debugLog("[sync] HTTP response:", res.statusCode, fullUrl);

          // Follow redirects (301, 302, 303, 307, 308)
          const redirectCodes = [301, 302, 303, 307, 308];
          if (redirectCodes.includes(res.statusCode ?? 0) && res.headers.location) {
            res.resume(); // drain original response
            const redirectUrl = res.headers.location;
            const rParsed = new URL(redirectUrl);
            const rLib = rParsed.protocol === "https:" ? https : http;
            // Preserve method for 307/308; use GET for 301/302/303
            const redirectMethod = [307, 308].includes(res.statusCode!) ? (opts.method ?? "GET") : "GET";
            // FIX: Include cookie for same-host redirects (previously dropped)
            const isSameHost = rParsed.hostname === parsed.hostname;
            const rHeaders: Record<string, string> = {};
            if (isSameHost) rHeaders.Cookie = `dosya_session=${sessionCookie}`;

            const rReq = rLib.request(redirectUrl, { method: redirectMethod, headers: rHeaders, timeout, agent: agentFor(redirectUrl) }, (rRes) => {
              const chunks: Buffer[] = [];
              rRes.on("data", (chunk: Buffer) => chunks.push(chunk));
              rRes.on("end", () => {
                const body = Buffer.concat(chunks);
                const resHeaders = rRes.headers as Record<string, string | string[] | undefined>;
                resolve({
                  status: rRes.statusCode ?? 200,
                  headers: resHeaders,
                  json: () => {
                    try { return Promise.resolve(JSON.parse(body.toString("utf-8"))); }
                    catch { return Promise.resolve({ error: "Invalid JSON response" }); }
                  },
                  buffer: () => Promise.resolve(body),
                });
              });
              rRes.on("error", reject);
            });
            rReq.on("error", reject);
            rReq.on("timeout", () => { rReq.destroy(); reject(new Error("Redirect timed out")); });
            // Send body for 307/308 redirects (preserves method + body)
            if ([307, 308].includes(res.statusCode!) && bodyBuf) {
              rReq.write(bodyBuf);
            }
            rReq.end();
            return;
          }

          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => {
            const body = Buffer.concat(chunks);
            const resHeaders = res.headers as Record<string, string | string[] | undefined>;
            resolve({
              status: res.statusCode ?? 500,
              headers: resHeaders,
              json: () => {
                try { return Promise.resolve(JSON.parse(body.toString("utf-8"))); }
                catch { return Promise.resolve({ error: "Invalid JSON response" }); }
              },
              buffer: () => Promise.resolve(body),
            });
          });
          res.on("error", reject);
        },
      );

      req.on("timeout", () => {
        req.destroy();
        reject(new Error("Request timed out"));
      });
      req.on("error", reject);

      if (bodyBuf) {
        req.write(bodyBuf);
      }
      req.end();
    });
  }

  // ── Fetch with retry + jitter ─────────────────────────────────────

  private async fetch(
    path: string,
    opts: { method?: string; body?: Buffer | string; headers?: Record<string, string> } = {},
  ): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: () => Promise<any>; buffer: () => Promise<Buffer> }> {
    // Proactively wait if budget is nearly exhausted
    await this.waitForBudget();

    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const res = await this.fetchOnce(path, opts);

        // Update rate budget from every response
        this.updateBudget(res.headers);

        // Handle 429 — throw RateLimitError with Retry-After info
        if (res.status === 429) {
          throw this.createRateLimitError(res.headers);
        }

        // Don't retry on client errors (4xx) — they won't change
        if (res.status >= 400 && res.status < 500) return res;

        // Retry on server errors (5xx)
        if (res.status >= 500 && attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt] * (0.5 + Math.random());
          debugLog("[sync] Server error", res.status, "retrying in", Math.round(delay), "ms");
          await sleep(delay);
          continue;
        }

        return res;
      } catch (err: any) {
        lastErr = err;
        // Don't retry auth/rate-limit errors
        if (err instanceof RateLimitError) throw err;
        if (NON_RETRYABLE.has(err.message)) throw err;

        if (attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt] * (0.5 + Math.random());
          debugLog("[sync] Request failed, retrying in", Math.round(delay), "ms:", err.message);
          await sleep(delay);
        }
      }
    }

    throw lastErr ?? new Error("Request failed after retries");
  }

  // ── Streaming download ────────────────────────────────────────────
  //
  // Downloads to a temp file, verifies size, then atomically renames.
  // Streams to disk to prevent OOM on large files.

  async downloadFile(
    fileId: string,
    localPath: string,
    expectedSize: number = -1,
    onProgress?: (bytesTransferred: number) => void,
  ): Promise<number> {
    if (process.platform === "win32" && localPath.length > 259 && !localPath.startsWith("\\\\?\\")) {
      localPath = `\\\\?\\${pathResolve(localPath)}`;
    }

    const tmpPath = `${localPath}.dosya-sync-tmp`;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const sessionCookie = await this.getSessionCookie();
        if (!sessionCookie) throw new Error("SESSION_EXPIRED");

        // Check if a partial download exists from a previous failed attempt.
        // If so, resume from where it left off using HTTP Range header.
        let existingBytes = 0;
        try {
          const tmpStat = await stat(tmpPath);
          if (tmpStat.isFile() && tmpStat.size > 0 && expectedSize > 0 && tmpStat.size < expectedSize) {
            existingBytes = tmpStat.size;
          } else if (tmpStat.size >= expectedSize && expectedSize > 0) {
            // Already complete — just verify and rename
            await fsRename(tmpPath, localPath);
            onProgress?.(expectedSize);
            return expectedSize;
          }
        } catch {
          // No tmp file — start from scratch
        }

        const bytesWritten = await this.streamDownload(
          `/api/files/${fileId}/download`,
          tmpPath,
          sessionCookie,
          existingBytes,
          onProgress,
        );

        const totalBytes = existingBytes + bytesWritten;
        if (expectedSize >= 0 && totalBytes !== expectedSize) {
          await fsUnlink(tmpPath).catch(() => {});
          throw new Error(`Download size mismatch: expected ${expectedSize}, got ${totalBytes}`);
        }

        await fsRename(tmpPath, localPath);
        return totalBytes;
      } catch (err: any) {
        lastErr = err;
        // DON'T delete tmp file on retryable errors — we'll resume from it
        if (err instanceof RateLimitError) throw err;
        if (NON_RETRYABLE.has(err.message)) {
          await fsUnlink(tmpPath).catch(() => {});
          throw err;
        }
        if (attempt < RETRY_DELAYS.length) {
          const delay = RETRY_DELAYS[attempt] * (0.5 + Math.random());
          debugLog("[sync] Download retry in", Math.round(delay), "ms:", err.message);
          await sleep(delay);
        } else {
          // Final attempt failed — keep tmp file for next sync cycle resume
        }
      }
    }

    throw lastErr ?? new Error("Download failed after retries");
  }

  /**
   * Stream download with HTTP Range resume support.
   * If resumeFrom > 0, sends `Range: bytes={resumeFrom}-` and appends
   * to the destination file instead of overwriting.
   */
  private streamDownload(
    path: string,
    destPath: string,
    cookie: string,
    resumeFrom: number,
    onProgress?: (bytes: number) => void,
  ): Promise<number> {
    const apiHostname = new URL(this.apiBase).hostname;

    return new Promise((resolve, reject) => {
      const makeRequest = (url: string, redirectCount: number): void => {
        if (redirectCount > 5) {
          reject(new Error("Too many redirects"));
          return;
        }

        const urlParsed = new URL(url);
        const reqLib = urlParsed.protocol === "https:" ? https : http;
        const isSameHost = urlParsed.hostname === apiHostname;
        const headers: Record<string, string> = {};
        if (isSameHost) headers.Cookie = `dosya_session=${cookie}`;
        // Resume from where we left off
        if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

        const req = reqLib.get(url, { headers, timeout: 300_000, agent: agentFor(url) }, (res) => {
          if (res.statusCode === 401) { res.resume(); reject(new Error("SESSION_EXPIRED")); return; }
          if (res.statusCode === 429) {
            const retryAfterMs = this.parseRetryAfter(
              res.headers as Record<string, string | string[] | undefined>,
            );
            this.rateBudget.remaining = 0;
            res.resume();
            reject(new RateLimitError(retryAfterMs));
            return;
          }

          this.updateBudget(res.headers as Record<string, string | string[] | undefined>);

          if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
            res.resume();
            makeRequest(res.headers.location, redirectCount + 1);
            return;
          }

          // 416 Range Not Satisfiable — file changed or resumed past end
          if (res.statusCode === 416) {
            res.resume();
            reject(new Error("Range not satisfiable — file may have changed"));
            return;
          }

          if ((res.statusCode ?? 500) >= 400) {
            res.resume();
            reject(new Error(`Download failed: HTTP ${res.statusCode}`));
            return;
          }

          // Append to existing file when resuming (206 Partial Content),
          // otherwise overwrite from scratch (200 OK).
          const isResume = res.statusCode === 206;
          const ws = createWriteStream(destPath, isResume ? { flags: "a" } : undefined);
          let bytes = 0;

          res.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            onProgress?.(resumeFrom + bytes);
          });

          res.pipe(ws);
          ws.on("finish", () => resolve(bytes));
          ws.on("error", (err) => { res.destroy(); reject(err); });
          res.on("error", (err) => { ws.destroy(); reject(err); });
        });

        req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
        req.on("error", reject);
      };

      makeRequest(`${this.apiBase}${path}`, 0);
    });
  }

  // ── Streaming upload ──────────────────────────────────────────────
  //
  // Init step uses JSON fetch. PUT step streams from disk to prevent OOM.

  /** Threshold above which we use resumable multipart instead of single PUT. */
  private static readonly MULTIPART_THRESHOLD = 50 * 1024 * 1024; // 50 MB

  async uploadFile(
    localPath: string,
    workspaceId: string,
    folderId: string | null,
    region: string,
    fileId?: string | null,
    onProgress?: (bytesTransferred: number) => void,
  ): Promise<{ fileId: string; name: string }> {
    const fileName = basename(localPath);
    const fileStat = await stat(localPath);
    const ext = extname(fileName).slice(1).toLowerCase();
    const mimeType = MIME_MAP[ext] || "application/octet-stream";

    if (fileStat.size > MAX_FILE_SIZE) {
      throw new Error(
        `File too large (${Math.round(fileStat.size / 1024 / 1024)} MB). Maximum supported size is ${MAX_FILE_SIZE / 1024 / 1024 / 1024} GB.`,
      );
    }

    const initBody: Record<string, unknown> = {
      workspace_id: workspaceId,
      file_name: fileName,
      file_size: fileStat.size,
      mime_type: mimeType,
      folder_id: folderId,
      region,
    };
    if (fileId) initBody.file_id = fileId;

    const initRes = await this.fetch("/api/upload/init", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(initBody),
    });

    if (initRes.status === 401) throw new Error("SESSION_EXPIRED");
    const initData = await initRes.json();
    if (!initData.ok) throw new Error(initData.error || "Upload init failed");

    const sessionId = initData.session_id;

    if (fileStat.size > RemoteClient.MULTIPART_THRESHOLD && initData.resumable) {
      // ── Resumable multipart: per-part retry, survives network drops ──
      const partSize = initData.resumable.part_size as number;
      const totalParts = initData.resumable.total_parts as number;

      // Check which parts are already uploaded (for resume after crash)
      let uploadedParts = new Set<number>();
      let bytesAlreadyDone = 0;
      try {
        const statusRes = await this.fetch(`/api/upload/${sessionId}/status`);
        if (statusRes.status === 200) {
          const statusData = await statusRes.json();
          if (Array.isArray(statusData.uploaded_parts)) {
            uploadedParts = new Set(statusData.uploaded_parts as number[]);
            bytesAlreadyDone = (statusData.bytes_uploaded as number) || 0;
          }
        }
      } catch {
        // Status check failed — upload all parts from scratch
      }

      let transferred = bytesAlreadyDone;
      onProgress?.(transferred);

      // Upload each part by streaming from disk — no buffering the entire
      // part in memory. For a 1.5GB file with 10MB parts, the old approach
      // buffered each part as a Buffer (~10MB), passed it through fetch()
      // which copied it again (~20MB), and GC didn't always free the previous
      // part before the next one allocated. Result: 1.9GB RAM for a 1.5GB file.
      for (let partNum = 1; partNum <= totalParts; partNum++) {
        if (uploadedParts.has(partNum)) continue;

        const start = (partNum - 1) * partSize;
        const end = Math.min(start + partSize, fileStat.size);
        const chunkSize = end - start;

        let lastErr: Error | null = null;
        for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
          try {
            const cookie = await this.getSessionCookie();
            if (!cookie) throw new Error("SESSION_EXPIRED");

            const partResult = await this.streamPartUpload(
              `/api/upload/${sessionId}/part/${partNum}`,
              localPath,
              start,
              chunkSize,
              cookie,
            );

            if (!partResult.ok) throw new Error(partResult.error || `Part ${partNum} failed`);
            lastErr = null;
            break;
          } catch (err: any) {
            lastErr = err;
            if (err instanceof RateLimitError) throw err;
            if (NON_RETRYABLE.has(err.message)) throw err;
            if (attempt < RETRY_DELAYS.length) {
              await sleep(RETRY_DELAYS[attempt] * (0.5 + Math.random()));
            }
          }
        }
        if (lastErr) throw lastErr;

        transferred += chunkSize;
        onProgress?.(transferred);
      }

      // Complete the multipart upload (with retry — all parts are uploaded,
      // but the complete call itself can fail due to network issues)
      let completeErr: Error | null = null;
      for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
          const completeRes = await this.fetch(
            `/api/upload/${sessionId}/complete`,
            { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
          );
          if (completeRes.status === 401) throw new Error("SESSION_EXPIRED");
          const completeData = await completeRes.json();
          if (!completeData.ok) throw new Error(completeData.error || "Upload complete failed");
          return { fileId: completeData.file?.id ?? sessionId, name: fileName };
        } catch (err: any) {
          completeErr = err;
          if (err instanceof RateLimitError) throw err;
          if (NON_RETRYABLE.has(err.message)) throw err;
          if (attempt < RETRY_DELAYS.length) {
            await sleep(RETRY_DELAYS[attempt] * (0.5 + Math.random()));
          }
        }
      }
      throw completeErr ?? new Error("Upload complete failed after retries");
    }

    // ── Small files: single PUT stream (fast, no multipart overhead) ──
    const sessionCookie = await this.getSessionCookie();
    if (!sessionCookie) throw new Error("SESSION_EXPIRED");

    const putData = await this.streamUpload(
      `/api/upload/${sessionId}`,
      localPath,
      fileStat.size,
      sessionCookie,
      onProgress,
    );

    if (!putData.ok) throw new Error(putData.error || "Upload failed");
    return { fileId: putData.file?.id ?? sessionId, name: fileName };
  }

  /**
   * Stream a file part directly from disk to the server via HTTP PUT.
   * No buffering — bytes flow: disk → stream → TCP socket.
   * Memory usage is ~64KB (Node.js stream highWaterMark) regardless of part size.
   */
  private streamPartUpload(
    path: string,
    filePath: string,
    start: number,
    length: number,
    cookie: string,
  ): Promise<{ ok: boolean; error?: string }> {
    return new Promise((resolve, reject) => {
      const fullUrl = `${this.apiBase}${path}`;
      const parsed = new URL(fullUrl);
      const lib = parsed.protocol === "https:" ? https : http;

      const req = lib.request(fullUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
          Cookie: `dosya_session=${cookie}`,
          "X-Dosya-Sync": "1",
        },
        timeout: 300_000,
        agent: agentFor(fullUrl),
      }, (res) => {
        this.updateBudget(res.headers as Record<string, string | string[] | undefined>);

        if (res.statusCode === 401) { res.resume(); reject(new Error("SESSION_EXPIRED")); return; }
        if (res.statusCode === 429) {
          res.resume();
          reject(new RateLimitError(this.parseRetryAfter(res.headers as Record<string, string | string[] | undefined>)));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          try { resolve(JSON.parse(body)); }
          catch { resolve({ ok: false, error: "Invalid JSON response" }); }
        });
        res.on("error", reject);
      });

      req.on("timeout", () => { req.destroy(); reject(new Error("Upload timed out")); });
      req.on("error", reject);

      // Stream the byte range directly from disk — no intermediate Buffer
      const stream = createReadStream(filePath, { start, end: start + length - 1 });
      stream.on("error", (err) => { req.destroy(); reject(err); });
      stream.pipe(req);
    });
  }

  /** Batch size threshold: files smaller than this can be batched. */
  static readonly BATCH_FILE_MAX = 5 * 1024 * 1024; // 5 MB
  static readonly BATCH_MAX_FILES = 200;
  /** Maximum total batch payload size to prevent OOM. */
  static readonly BATCH_TOTAL_MAX = 50 * 1024 * 1024; // 50 MB

  /**
   * Upload multiple small files in a single HTTP request.
   * Uses multipart/form-data to bundle files + a JSON manifest.
   * Returns an array of results matching the input order.
   */
  async uploadFilesBatch(
    files: { absPath: string; relPath: string; folderId: string | null; existingFileId: string | null }[],
    workspaceId: string,
    region: string,
  ): Promise<{ fileId: string; name: string; relPath: string }[]> {
    const sessionCookie = await this.getSessionCookie();
    if (!sessionCookie) throw new Error("SESSION_EXPIRED");

    // Verify total batch size won't exceed the cap to prevent OOM
    let totalSize = 0;
    for (const f of files) {
      const s = await stat(f.absPath).catch(() => null);
      totalSize += s?.size ?? 0;
    }
    if (totalSize > RemoteClient.BATCH_TOTAL_MAX) {
      throw new Error(`Batch too large (${Math.round(totalSize / 1024 / 1024)} MB). Maximum is ${RemoteClient.BATCH_TOTAL_MAX / 1024 / 1024} MB.`);
    }

    // Build multipart/form-data manually using Node.js Buffers.
    // We can't use FormData (it's a browser API) in the main process.
    const boundary = `----DosyaBatch${Date.now()}${Math.random().toString(36).slice(2)}`;
    const parts: Buffer[] = [];

    const manifest = {
      workspace_id: workspaceId,
      region,
      files: files.map((f, i) => ({
        name: basename(f.absPath),
        folder_id: f.folderId,
        file_id: f.existingFileId,
        field: `file_${i}`,
      })),
    };

    // Manifest part
    parts.push(Buffer.from(
      `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="manifest"\r\n` +
      `Content-Type: application/json\r\n\r\n` +
      JSON.stringify(manifest) + `\r\n`,
    ));

    // File parts
    for (let i = 0; i < files.length; i++) {
      const fileName = basename(files[i].absPath);
      const fileData = await readFile(files[i].absPath);
      parts.push(Buffer.from(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file_${i}"; filename="${fileName}"\r\n` +
        `Content-Type: application/octet-stream\r\n\r\n`,
      ));
      parts.push(fileData);
      parts.push(Buffer.from(`\r\n`));
    }

    // Closing boundary
    parts.push(Buffer.from(`--${boundary}--\r\n`));

    const body = Buffer.concat(parts);

    const res = await this.fetchOnce("/api/upload/batch", {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
      timeout: 120_000,
    });

    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    if (res.status === 429) throw this.createRateLimitError(res.headers);
    this.updateBudget(res.headers);

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Batch upload failed");

    const results: { fileId: string; name: string; relPath: string }[] = [];
    for (let i = 0; i < files.length; i++) {
      const r = data.results?.[i];
      if (r?.ok) {
        results.push({ fileId: r.fileId, name: r.name, relPath: files[i].relPath });
      } else {
        throw new Error(r?.error || `Batch file ${i} failed`);
      }
    }

    return results;
  }

  private streamUpload(
    path: string,
    filePath: string,
    fileSize: number,
    cookie: string,
    onProgress?: (bytes: number) => void,
    signal?: AbortSignal,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      const fullUrl = `${this.apiBase}${path}`;
      const urlParsed = new URL(fullUrl);
      const lib = urlParsed.protocol === "https:" ? https : http;

      const req = lib.request(fullUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(fileSize),
          Cookie: `dosya_session=${cookie}`,
          "X-Dosya-Sync": "1",
        },
        timeout: 300_000,
        agent: agentFor(fullUrl),
      }, (res) => {
        // Update budget from upload response
        this.updateBudget(res.headers as Record<string, string | string[] | undefined>);

        if (res.statusCode === 429) {
          const retryAfterMs = this.parseRetryAfter(
            res.headers as Record<string, string | string[] | undefined>,
          );
          res.resume();
          reject(new RateLimitError(retryAfterMs));
          return;
        }

        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8");
          try { resolve(JSON.parse(body)); }
          catch { resolve({ error: "Invalid JSON response" }); }
        });
        res.on("error", reject);
      });

      req.on("timeout", () => { req.destroy(); reject(new Error("Upload timed out")); });
      req.on("error", reject);

      // Abort support: cancel in-flight upload when signal fires (e.g. user paused)
      if (signal) {
        if (signal.aborted) { req.destroy(); reject(new Error("Upload cancelled")); return; }
        signal.addEventListener("abort", () => {
          stream?.destroy();
          req.destroy();
          reject(new Error("Upload cancelled"));
        }, { once: true });
      }

      const stream = createReadStream(filePath);
      let transferred = 0;

      stream.on("data", (chunk: string | Buffer) => {
        transferred += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
        onProgress?.(transferred);
      });

      stream.on("error", (err) => {
        req.destroy();
        reject(err);
      });

      stream.pipe(req);
    });
  }

  // ── Public API ────────────────────────────────────────────────────

  /**
   * Fetch workspace snapshot via paginated endpoint.
   * Handles pagination automatically — fetches all pages until hasMore=false.
   * Supports delta polling via `since` (unix timestamp) — only returns changed files.
   *
   * For 1M files: fetches in pages of 5000 (200 requests instead of 1M).
   * For delta polls: typically 1 request (only changed files since last poll).
   */
  async fetchSnapshotFast(
    workspaceId: string,
    rootFolderId: string | null,
    since?: number,
  ): Promise<{ files: RemoteFileInfo[]; folders: RemoteFolderInfo[] } | null> {
    try {
      const files: RemoteFileInfo[] = [];
      let folders: RemoteFolderInfo[] = [];
      let cursor: string | null = null;
      let page = 0;

      while (true) {
        const params = new URLSearchParams({ workspace_id: workspaceId });
        if (rootFolderId) params.set("folder_id", rootFolderId);
        if (cursor) params.set("cursor", cursor);
        if (since) params.set("since", String(since));

        const res = await this.fetch(`/api/sync/snapshot?${params}`);
        if (res.status === 401) throw new Error("SESSION_EXPIRED");
        if (res.status !== 200) return null;

        const data = await res.json();
        if (!data.ok) return null;

        // Folders only come in the first page
        if (page === 0 && data.folders) {
          folders = data.folders;
        }

        for (const f of data.files ?? []) {
          files.push(f);
        }

        if (!data.hasMore) break;
        cursor = data.nextCursor;
        page++;
      }

      return { files, folders };
    } catch (err: any) {
      if (err.message === "SESSION_EXPIRED") throw err;
      return null;
    }
  }

  /**
   * Get presigned download URLs for multiple files in a single request.
   * Returns a map of fileId → { url, name, size }.
   */
  async requestDownloadManifest(
    workspaceId: string,
    fileIds: string[],
  ): Promise<Map<string, { url: string; name: string; size: number }>> {
    const result = new Map<string, { url: string; name: string; size: number }>();
    const CHUNK = 500;

    for (let i = 0; i < fileIds.length; i += CHUNK) {
      const chunk = fileIds.slice(i, i + CHUNK);
      const res = await this.fetch("/api/sync/download-manifest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, file_ids: chunk }),
      });
      if (res.status === 401) throw new Error("SESSION_EXPIRED");
      const data = await res.json();
      if (data.ok && data.downloads) {
        for (const d of data.downloads) {
          result.set(d.fileId, { url: d.url, name: d.name, size: d.size });
        }
      }
    }

    return result;
  }

  /**
   * Download a file directly from a presigned URL (bypasses Worker).
   * Supports resume via HTTP Range if a partial tmp file exists.
   */
  async downloadFromPresignedUrl(
    presignedUrl: string,
    localPath: string,
    expectedSize: number,
    onProgress?: (bytes: number) => void,
  ): Promise<number> {
    if (process.platform === "win32" && localPath.length > 259 && !localPath.startsWith("\\\\?\\")) {
      localPath = `\\\\?\\${pathResolve(localPath)}`;
    }

    const tmpPath = `${localPath}.dosya-sync-tmp`;

    // Check for existing partial download
    let resumeFrom = 0;
    try {
      const tmpStat = await stat(tmpPath);
      if (tmpStat.isFile() && tmpStat.size > 0 && expectedSize > 0 && tmpStat.size < expectedSize) {
        resumeFrom = tmpStat.size;
      } else if (tmpStat.size >= expectedSize && expectedSize > 0) {
        await fsRename(tmpPath, localPath);
        onProgress?.(expectedSize);
        return expectedSize;
      }
    } catch {}

    return new Promise<number>((resolve, reject) => {
      const parsed = new URL(presignedUrl);
      const lib = parsed.protocol === "https:" ? https : http;

      const headers: Record<string, string> = {};
      if (resumeFrom > 0) headers.Range = `bytes=${resumeFrom}-`;

      const req = lib.get(presignedUrl, { headers, timeout: 300_000, agent: agentFor(presignedUrl) }, (res) => {
        if (res.statusCode === 416) {
          // Range not satisfiable — start over
          res.resume();
          fsUnlink(tmpPath).catch(() => {}).then(() => {
            reject(new Error("Range not satisfiable"));
          });
          return;
        }

        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          reject(new Error(`Download failed: HTTP ${res.statusCode}`));
          return;
        }

        if ([301, 302, 303, 307, 308].includes(res.statusCode ?? 0) && res.headers.location) {
          res.resume();
          const rLib = new URL(res.headers.location).protocol === "https:" ? https : http;
          const rHeaders: Record<string, string> = {};
          if (resumeFrom > 0) rHeaders.Range = `bytes=${resumeFrom}-`;
          const rReq = rLib.get(res.headers.location, { headers: rHeaders, timeout: 300_000, agent: agentFor(res.headers.location) }, (rRes) => {
            if ((rRes.statusCode ?? 500) >= 400) { rRes.resume(); reject(new Error(`Download failed: HTTP ${rRes.statusCode}`)); return; }
            const isResume = rRes.statusCode === 206;
            const ws = createWriteStream(tmpPath, isResume ? { flags: "a" } : undefined);
            let bytes = 0;
            rRes.on("data", (chunk: Buffer) => { bytes += chunk.length; onProgress?.(resumeFrom + bytes); });
            rRes.pipe(ws);
            ws.on("finish", async () => {
              try {
                const total = resumeFrom + bytes;
                if (expectedSize >= 0 && total !== expectedSize) {
                  await fsUnlink(tmpPath).catch(() => {});
                  reject(new Error(`Size mismatch: expected ${expectedSize}, got ${total}`)); return;
                }
                await fsRename(tmpPath, localPath);
                resolve(total);
              } catch (err) { reject(err); }
            });
            ws.on("error", reject);
            rRes.on("error", reject);
          });
          rReq.on("error", reject);
          return;
        }

        const isResume = res.statusCode === 206;
        const ws = createWriteStream(tmpPath, isResume ? { flags: "a" } : undefined);
        let bytes = 0;
        res.on("data", (chunk: Buffer) => { bytes += chunk.length; onProgress?.(resumeFrom + bytes); });
        res.pipe(ws);
        ws.on("finish", async () => {
          try {
            const total = resumeFrom + bytes;
            if (expectedSize >= 0 && total !== expectedSize) {
              await fsUnlink(tmpPath).catch(() => {});
              reject(new Error(`Size mismatch: expected ${expectedSize}, got ${total}`)); return;
            }
            await fsRename(tmpPath, localPath);
            resolve(total);
          } catch (err) { reject(err); }
        });
        ws.on("error", (err) => { res.destroy(); reject(err); });
        res.on("error", (err) => { ws.destroy(); reject(err); });
      });

      req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
      req.on("error", reject);
    });
  }

  /** Fetch the current user's ID from /api/me. Returns null if not authenticated. */
  async getCurrentUserId(): Promise<string | null> {
    try {
      const res = await this.fetch("/api/me");
      if (res.status !== 200) return null;
      const data = await res.json();
      return data.user?.id ?? null;
    } catch {
      return null;
    }
  }

  // ── Presigned URL upload flow (fastest path) ──────────────────────

  /**
   * Request presigned PUT URLs for files that need uploading.
   * The server diffs against existing files and returns URLs only for missing ones.
   */
  async requestManifest(
    workspaceId: string,
    folderId: string | null,
    region: string,
    files: { relPath: string; name: string; size: number; folder_id: string | null }[],
  ): Promise<{
    uploads: { relPath: string; fileId: string; r2Key: string; name: string; url: string; size: number; folderId: string | null; contentType: string; ext: string | null }[];
    skipped: number;
  }> {
    const res = await this.fetch("/api/sync/manifest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, folder_id: folderId, region, files }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Manifest request failed");
    return { uploads: data.uploads ?? [], skipped: data.skipped ?? 0 };
  }

  /**
   * Upload a file directly to R2 via presigned URL (bypasses the Worker).
   * Uses Node.js https.request for streaming from disk.
   */
  async uploadToPresignedUrl(
    presignedUrl: string,
    filePath: string,
    fileSize: number,
    contentType: string,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const parsed = new URL(presignedUrl);
      const lib = parsed.protocol === "https:" ? https : http;

      const req = lib.request(presignedUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
        },
        timeout: 300_000,
        agent: agentFor(presignedUrl),
      }, (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          resolve();
        } else {
          reject(new Error(`Presigned upload failed: HTTP ${res.statusCode}`));
        }
      });

      req.on("timeout", () => { req.destroy(); reject(new Error("Upload timed out")); });
      req.on("error", reject);

      const stream = createReadStream(filePath);
      stream.on("error", (err) => { req.destroy(); reject(err); });
      stream.pipe(req);
    });
  }

  /**
   * Commit uploaded files to the database.
   */
  async commitUploads(
    workspaceId: string,
    region: string,
    files: { file_id: string; r2_key: string; name: string; size: number; folder_id: string | null; content_type: string; ext: string | null }[],
  ): Promise<{ committed: number }> {
    const res = await this.fetch("/api/sync/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, region, files }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Commit failed");
    return { committed: data.committed ?? 0 };
  }

  // ── Public API ────────────────────────────────────────────────────

  async listFiles(
    workspaceId: string,
    folderId: string | null,
    page = 1,
    perPage = 500,
  ): Promise<{ files: RemoteFileInfo[]; folders: RemoteFolderInfo[]; totalPages: number }> {
    const params = new URLSearchParams({
      workspace_id: workspaceId,
      page: String(page),
      per_page: String(perPage),
    });
    if (folderId) params.set("folder_id", folderId);

    const res = await this.fetch(`/api/files?${params}`);
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    // 429 is now handled inside fetch() — no need to check here

    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to list files");

    return {
      files: data.files ?? [],
      folders: data.folders ?? [],
      totalPages: data.pagination?.total_pages ?? 1,
    };
  }

  async getWorkspaceRegion(workspaceId: string): Promise<string> {
    const res = await this.fetch(`/api/workspaces/${workspaceId}`);
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    return data.workspace?.default_region || "auto";
  }

  async getFolderTree(workspaceId: string): Promise<RemoteFolderInfo[]> {
    const res = await this.fetch(`/api/folders/tree?workspace_id=${workspaceId}`);
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Failed to get folder tree");
    return data.folders ?? [];
  }

  async moveFile(fileId: string, folderId: string | null): Promise<void> {
    const res = await this.fetch(`/api/files/${fileId}/move`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ folder_id: folderId }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    if (res.status >= 400) {
      const data = await res.json();
      throw new Error(data.error || "Move failed");
    }
  }

  async renameFile(fileId: string, newName: string): Promise<void> {
    const res = await this.fetch(`/api/files/${fileId}/rename`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    if (res.status >= 400) {
      const data = await res.json();
      throw new Error(data.error || "Rename failed");
    }
  }

  async deleteFile(fileId: string): Promise<void> {
    const res = await this.fetch(`/api/files/${fileId}`, { method: "DELETE" });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    if (res.status !== 200 && res.status !== 404) {
      const data = await res.json();
      throw new Error(data.error || "Delete failed");
    }
  }

  /**
   * Batch delete multiple files in a single request.
   * Used when a user deletes a folder locally — 10K files in 20 requests instead of 10K.
   */
  async deleteFilesBatch(workspaceId: string, fileIds: string[]): Promise<void> {
    const CHUNK = 500;
    for (let i = 0; i < fileIds.length; i += CHUNK) {
      const chunk = fileIds.slice(i, i + CHUNK);
      const res = await this.fetch("/api/files/batch-delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: workspaceId, file_ids: chunk }),
      });
      if (res.status === 401) throw new Error("SESSION_EXPIRED");
    }
  }

  async getFolderSyncFlag(folderId: string): Promise<boolean> {
    const res = await this.fetch(`/api/folders/${folderId}`);
    if (res.status === 404) return false;
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    return data.folder?.is_synced === 1 || data.folder?.is_synced === true;
  }

  async setFolderSyncFlag(folderId: string, enabled: boolean): Promise<void> {
    const res = await this.fetch(`/api/folders/${folderId}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
  }

  async setFileSyncFlag(fileId: string, enabled: boolean): Promise<void> {
    const res = await this.fetch(`/api/files/${fileId}/sync`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
  }

  /**
   * Set sync flag on multiple files in a single burst.
   * Fires requests concurrently (up to 10 at a time) to reduce wall-clock time
   * compared to sequential per-file calls. Errors are logged but not thrown
   * because the flag is non-critical metadata.
   */
  async batchSetFileSyncFlags(fileIds: string[], enabled: boolean): Promise<void> {
    const BATCH = 10;
    for (let i = 0; i < fileIds.length; i += BATCH) {
      const chunk = fileIds.slice(i, i + BATCH);
      await Promise.allSettled(
        chunk.map(id =>
          this.setFileSyncFlag(id, enabled).catch(err => {
            if (err.message === "SESSION_EXPIRED") throw err;
            // Non-critical — log and continue
          }),
        ),
      );
    }
  }

  /**
   * Create multiple folders in a single HTTP request.
   * Returns a map of "parentId:name" → folderId for all created/existing folders.
   * Folders must be sorted by depth (parents before children).
   */
  async createFoldersBatch(
    workspaceId: string,
    folders: { name: string; parent_id: string | null }[],
  ): Promise<Map<string, string>> {
    const res = await this.fetch("/api/folders/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, folders }),
    });

    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Batch folder create failed");

    const map = new Map<string, string>();
    for (const f of data.folders ?? []) {
      const key = `${f.parent_id ?? "null"}:${f.name}`;
      map.set(key, f.id);
    }
    return map;
  }

  async createFolder(
    workspaceId: string,
    name: string,
    parentId: string | null,
  ): Promise<string> {
    const res = await this.fetch("/api/folders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, name, parent_id: parentId }),
    });

    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Create folder failed");
    return data.folder?.id ?? data.id;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
