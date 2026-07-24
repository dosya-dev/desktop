import { app, session } from "electron";
import { createReadStream, createWriteStream, readFileSync } from "fs";
import { stat, readFile, writeFile as fsWriteFile, rename as fsRename, unlink as fsUnlink } from "fs/promises";
import { basename, extname } from "path";
import { Transform, type Readable } from "stream";
import { longPath } from "./paths";
import type { RemoteFileInfo, RemoteFolderInfo } from "./types";
import http from "http";
import https from "https";
import { HttpProxyAgent } from "http-proxy-agent";
import { HttpsProxyAgent } from "https-proxy-agent";
import { URL } from "url";

// ── Bandwidth throttling ────────────────────────────────────────────
// A token bucket shared by all transfers in one direction, so the cap is a
// real aggregate limit rather than per-connection. Rate 0 = unlimited.
class TokenBucket {
  private tokens: number;
  private lastRefill = 0; // set on first use to avoid Date.now() at module load
  constructor(private ratePerSec: number) {
    this.tokens = ratePerSec;
  }
  setRate(ratePerSec: number): void {
    this.ratePerSec = Math.max(0, ratePerSec);
    const burst = this.burst();
    if (this.tokens > burst) this.tokens = burst;
  }
  get unlimited(): boolean {
    return this.ratePerSec <= 0;
  }
  private burst(): number {
    // Allow a small burst so throughput isn't choppy (min 64KB).
    return Math.max(this.ratePerSec, 64 * 1024);
  }
  private refill(): void {
    const now = Date.now();
    if (this.lastRefill === 0) { this.lastRefill = now; return; }
    const elapsed = (now - this.lastRefill) / 1000;
    this.tokens = Math.min(this.burst(), this.tokens + elapsed * this.ratePerSec);
    this.lastRefill = now;
  }
  async take(n: number): Promise<void> {
    if (this.unlimited) return;
    // Loop until enough tokens have refilled for `n` bytes.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      this.refill();
      if (this.tokens >= n) { this.tokens -= n; return; }
      const deficit = n - this.tokens;
      const waitMs = Math.min(200, Math.max(5, (deficit / this.ratePerSec) * 1000));
      await sleep(waitMs);
    }
  }
}

/**
 * Transform that paces a stream to a TokenBucket. On the download side its
 * backpressure slows the socket read (real bandwidth limit); on the upload
 * side it paces bytes to the request. Bypass entirely when the bucket is
 * unlimited so there's zero overhead in the common case.
 */
class ThrottleStream extends Transform {
  constructor(private bucket: TokenBucket) {
    super();
  }
  async _transform(chunk: Buffer, _enc: string, cb: (err?: Error | null) => void): Promise<void> {
    try {
      const CH = 16 * 1024;
      for (let offset = 0; offset < chunk.length; offset += CH) {
        const slice = chunk.subarray(offset, offset + CH);
        await this.bucket.take(slice.length);
        this.push(slice);
      }
      cb();
    } catch (err) {
      cb(err as Error);
    }
  }
}

// Persistent HTTP agents with keep-alive and a bounded socket pool.
// Without these, each request opens a new TCP+TLS handshake (~100ms).
// With keep-alive, connections are reused — critical when uploading
// 38K files (saves ~38K x 100ms = ~63 min of handshake overhead).
// maxSockets is the real concurrency ceiling per host and the main RAM lever
// (each socket ~= one in-flight stream). Kept modest on purpose; the engine's
// worker counts are derived to stay at/under this so workers don't just spin.
const MAX_SOCKETS_PER_HOST = 32;
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS_PER_HOST });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: MAX_SOCKETS_PER_HOST });

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

// Cache proxy agents per (target-scheme, proxy-url) so keep-alive still works
// through a corporate proxy instead of a fresh TCP+TLS handshake per request.
const proxyAgentCache = new Map<string, http.Agent>();

/**
 * Build (or reuse) a proxy-aware agent for a target URL through `proxyUrl`.
 * https-proxy-agent tunnels https targets via HTTP CONNECT; http-proxy-agent
 * sends the absolute-URI form for http targets.
 */
function getProxyAgent(targetUrl: string | URL, proxyUrl: string): http.Agent {
  const isHttps = (typeof targetUrl === "string" ? new URL(targetUrl).protocol : targetUrl.protocol) === "https:";
  const key = `${isHttps ? "https" : "http"}|${proxyUrl}`;
  let agent = proxyAgentCache.get(key);
  if (!agent) {
    agent = isHttps
      ? new HttpsProxyAgent(proxyUrl, { keepAlive: true })
      : new HttpProxyAgent(proxyUrl, { keepAlive: true });
    proxyAgentCache.set(key, agent);
  }
  return agent;
}

/**
 * Resolve the agent to use for a request. Returns the shared DIRECT keep-alive
 * agent when the system says DIRECT (unchanged fast path); otherwise a proxy
 * agent routed through the resolved system/corporate proxy. Electron's
 * resolveProxy already applies PAC files and NO_PROXY/bypass rules, so a null
 * proxy here means "go direct".
 */
async function resolveAgent(url: string | URL): Promise<http.Agent | https.Agent> {
  const urlStr = typeof url === "string" ? url : url.toString();
  const proxyUrl = await resolveProxy(urlStr);
  if (!proxyUrl) return agentFor(url);
  debugLog("[sync] Routing via proxy:", proxyUrl, "for", urlStr);
  return getProxyAgent(url, proxyUrl);
}

const isDev = !app.isPackaged;
function debugLog(...args: unknown[]): void {
  if (isDev) console.log(...args);
}

const RETRY_DELAYS = [1000, 3000, 8000]; // exponential-ish backoff
// Backstop for snapshot pagination. At a typical ~1000 files/page this covers
// tens of millions of files — far beyond any real workspace — while still
// stopping a misbehaving cursor from looping forever.
const MAX_SNAPSHOT_PAGES = 50_000;
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

  /** Aggregate up/down bandwidth caps (bytes/sec). 0 = unlimited. */
  private uploadBucket = new TokenBucket(0);
  private downloadBucket = new TokenBucket(0);

  constructor(private apiBase: string) {}

  /** Set aggregate bandwidth caps in bytes/sec (0 = unlimited). */
  setBandwidthLimits(uploadBytesPerSec: number, downloadBytesPerSec: number): void {
    this.uploadBucket.setRate(uploadBytesPerSec || 0);
    this.downloadBucket.setRate(downloadBytesPerSec || 0);
  }

  /** Wrap a readable through the given bucket, or return it unchanged when unlimited. */
  private throttle(src: Readable, bucket: TokenBucket): Readable {
    if (bucket.unlimited) return src;
    const t = new ThrottleStream(bucket);
    src.on("error", (err) => t.destroy(err));
    // If the source is destroyed prematurely (aborted upload, socket reset)
    // without a normal "end", pipe() won't tear down the throttle — do it here
    // so it doesn't linger. On a clean end (readableEnded) leave it alone so
    // buffered bytes still flush to the destination.
    src.on("close", () => { if (!src.readableEnded && !t.destroyed) t.destroy(); });
    return src.pipe(t);
  }

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
    const raw = String(value).trim();
    // Delta-seconds form (a plain integer), e.g. "Retry-After: 120".
    if (/^\d+$/.test(raw)) {
      const seconds = parseInt(raw, 10);
      if (seconds > 0) return seconds * 1000;
      return 60_000;
    }
    // HTTP-date form (RFC 7231), e.g. "Retry-After: Wed, 21 Oct 2025 07:28:00 GMT".
    const whenMs = Date.parse(raw);
    if (!isNaN(whenMs)) {
      const delta = whenMs - Date.now();
      if (delta > 0) return delta;
      return 0; // date already passed — retry immediately
    }
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

    // Resolve system proxy (supports corporate proxies, PAC files, etc.) and
    // build the actual agent for the request — on proxy-mandatory networks a
    // direct agent silently fails, so the resolved proxy MUST be applied.
    const agent = await resolveAgent(fullUrl);

    let bodyBuf: Buffer | undefined;
    if (opts.body != null) {
      bodyBuf = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body, "utf-8");
    }

    const headers: Record<string, string> = {
      Cookie: `dosya_session=${sessionCookie}`,
      "X-Dosya-Sync": "1",
      "X-Dosya-Client": "desktop",
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
        { method: opts.method ?? "GET", headers, timeout, agent },
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

            // Redirect target may be a different host (e.g. R2) — resolve its
            // proxy independently rather than reusing the origin's agent.
            resolveAgent(redirectUrl).then((rAgent) => {
              const rReq = rLib.request(redirectUrl, { method: redirectMethod, headers: rHeaders, timeout, agent: rAgent }, (rRes) => {
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
            }).catch(reject);
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
    localPath = longPath(localPath);
    const tmpPath = `${localPath}.dosya-sync-tmp`;
    const metaPath = `${tmpPath}.meta`;
    const apiHostname = new URL(this.apiBase).hostname;
    let lastErr: Error | null = null;

    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const sessionCookie = await this.getSessionCookie();
        if (!sessionCookie) throw new Error("SESSION_EXPIRED");

        const total = await this.downloadToFile(
          `${this.apiBase}/api/files/${fileId}/download`,
          localPath, tmpPath, metaPath, expectedSize,
          { cookie: sessionCookie, cookieHost: apiHostname },
          onProgress,
        );
        return total;
      } catch (err: any) {
        lastErr = err;
        // DON'T delete tmp file on retryable errors — we'll resume from it
        if (err instanceof RateLimitError) throw err;
        if (NON_RETRYABLE.has(err.message)) {
          await fsUnlink(tmpPath).catch(() => {});
          await fsUnlink(metaPath).catch(() => {});
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

  /** Read the resume validator (ETag / Last-Modified) saved next to a partial download. */
  private async readDownloadValidator(metaPath: string): Promise<{ etag?: string; lastModified?: string } | null> {
    try {
      const raw = await readFile(metaPath, "utf-8");
      const j = JSON.parse(raw);
      if (j && (j.etag || j.lastModified)) return j;
    } catch {}
    return null;
  }

  /**
   * Stream a URL to a temp file with SAFE HTTP Range resume, verify the size,
   * then atomically rename into place.
   *
   * Safe-resume contract: we only resume a partial download when we have a
   * stored validator (ETag or Last-Modified) from the first attempt, and we
   * send it as `If-Range`. Per RFC 7233 the server returns 206 (append) only
   * if the resource is byte-for-byte unchanged; if it changed it returns 200
   * and we overwrite from scratch. This eliminates the old bug where a resumed
   * download could splice a stale prefix onto new bytes and still pass the
   * size check. If no validator is available, we start fresh rather than risk it.
   *
   * Memory: bytes flow response → disk via pipe (~64KB buffer); the file is
   * never held in memory regardless of size.
   */
  private downloadToFile(
    startUrl: string,
    localPath: string,
    tmpPath: string,
    metaPath: string,
    expectedSize: number,
    ctx: { cookie?: string; cookieHost?: string },
    onProgress?: (bytes: number) => void,
  ): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const begin = async () => {
        // Decide whether we can safely resume.
        let resumeFrom = 0;
        let validator: { etag?: string; lastModified?: string } | null = null;
        try {
          const tmpStat = await stat(tmpPath);
          if (tmpStat.isFile() && tmpStat.size > 0 && expectedSize > 0 && tmpStat.size < expectedSize) {
            validator = await this.readDownloadValidator(metaPath);
            if (validator) {
              resumeFrom = tmpStat.size;
            } else {
              // No validator — cannot prove the partial matches the current
              // remote content. Discard and start fresh.
              await fsUnlink(tmpPath).catch(() => {});
            }
          } else if (tmpStat.size >= expectedSize && expectedSize > 0) {
            // A "complete" tmp we can't verify by content — re-download to be safe.
            await fsUnlink(tmpPath).catch(() => {});
            await fsUnlink(metaPath).catch(() => {});
          }
        } catch { /* no tmp file — start from scratch */ }

        const makeRequest = (url: string, redirectCount: number): void => {
          if (redirectCount > 5) { reject(new Error("Too many redirects")); return; }

          const urlParsed = new URL(url);
          const reqLib = urlParsed.protocol === "https:" ? https : http;
          const headers: Record<string, string> = {};
          if (ctx.cookie && ctx.cookieHost && urlParsed.hostname === ctx.cookieHost) {
            headers.Cookie = `dosya_session=${ctx.cookie}`;
          }
          if (resumeFrom > 0 && validator) {
            headers.Range = `bytes=${resumeFrom}-`;
            headers["If-Range"] = validator.etag || validator.lastModified || "";
          }

          // Resolve a proxy agent per-URL (redirects can cross hosts); falls
          // back to the shared DIRECT agent when no proxy is configured.
          resolveAgent(url).then((agent) => {
          const req = reqLib.get(url, { headers, timeout: 300_000, agent }, (res) => {
            const status = res.statusCode ?? 500;
            if (status === 401) { res.resume(); reject(new Error("SESSION_EXPIRED")); return; }
            if (status === 429) {
              const retryAfterMs = this.parseRetryAfter(res.headers as Record<string, string | string[] | undefined>);
              this.rateBudget.remaining = 0;
              res.resume();
              reject(new RateLimitError(retryAfterMs));
              return;
            }
            this.updateBudget(res.headers as Record<string, string | string[] | undefined>);

            if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
              res.resume();
              makeRequest(new URL(res.headers.location, url).toString(), redirectCount + 1);
              return;
            }

            // 416 — the partial is unusable (past end / range rejected). Reset and restart.
            if (status === 416) {
              res.resume();
              fsUnlink(tmpPath).catch(() => {}).then(() => fsUnlink(metaPath).catch(() => {})).then(() => {
                reject(new Error("Range not satisfiable — restarting download"));
              });
              return;
            }
            if (status >= 400) { res.resume(); reject(new Error(`Download failed: HTTP ${status}`)); return; }

            // 206 = server claims it honored our range. Anything else (200) =
            // full body → overwrite from scratch (no stale prefix).
            let isResume = status === 206;
            let base = 0;
            if (isResume) {
              // Trust-but-verify: a 206 that doesn't actually start at resumeFrom
              // (or reports a different total) would splice mismatched bytes onto
              // our partial. Parse Content-Range and, on any disagreement, discard
              // the partial and restart from 0 rather than appending blindly.
              const contentRange = typeof res.headers["content-range"] === "string" ? res.headers["content-range"] : "";
              const m = contentRange.match(/bytes\s+(\d+)-(\d+)\/(\d+|\*)/i);
              const rangeStart = m ? parseInt(m[1], 10) : NaN;
              const rangeTotal = m && m[3] !== "*" ? parseInt(m[3], 10) : NaN;
              const startOk = rangeStart === resumeFrom;
              const totalOk = expectedSize < 0 || Number.isNaN(rangeTotal) || rangeTotal === expectedSize;
              if (!m || !startOk || !totalOk) {
                res.resume();
                fsUnlink(tmpPath).catch(() => {}).then(() => fsUnlink(metaPath).catch(() => {})).then(() => {
                  reject(new Error(`Resume range mismatch (Content-Range: "${contentRange}", expected start ${resumeFrom}) — restarting download`));
                });
                return;
              }
              base = resumeFrom;
            }

            // Content-Length of THIS response body (range length for 206, full
            // body for 200) — used to detect a truncated transfer even when the
            // caller didn't know expectedSize.
            const clHeader = res.headers["content-length"];
            const contentLength = typeof clHeader === "string" ? parseInt(clHeader, 10) : NaN;

            // Persist a validator for a possible future resume of THIS content.
            const etag = typeof res.headers.etag === "string" ? res.headers.etag : undefined;
            const lm = typeof res.headers["last-modified"] === "string" ? res.headers["last-modified"] : undefined;
            if (etag || lm) {
              fsWriteFile(metaPath, JSON.stringify({ etag, lastModified: lm })).catch(() => {});
            }

            const ws = createWriteStream(tmpPath, isResume ? { flags: "a" } : undefined);
            let bytes = 0;
            res.on("data", (chunk: Buffer) => { bytes += chunk.length; onProgress?.(base + bytes); });
            // Throttle applies backpressure that slows the socket read → real
            // download rate limit (no-op when the bucket is unlimited).
            this.throttle(res, this.downloadBucket).pipe(ws);
            ws.on("finish", async () => {
              try {
                const total = base + bytes;
                // Short/truncated-transfer guard: `bytes` is what this response
                // delivered; it must equal the advertised Content-Length.
                if (!Number.isNaN(contentLength) && bytes !== contentLength) {
                  await fsUnlink(tmpPath).catch(() => {});
                  await fsUnlink(metaPath).catch(() => {});
                  reject(new Error(`Download truncated: Content-Length ${contentLength}, received ${bytes}`));
                  return;
                }
                if (expectedSize >= 0 && total !== expectedSize) {
                  await fsUnlink(tmpPath).catch(() => {});
                  await fsUnlink(metaPath).catch(() => {});
                  reject(new Error(`Download size mismatch: expected ${expectedSize}, got ${total}`));
                  return;
                }
                await fsRename(tmpPath, localPath);
                await fsUnlink(metaPath).catch(() => {});
                resolve(total);
              } catch (err) { reject(err as Error); }
            });
            ws.on("error", (err) => { res.destroy(); reject(err); });
            res.on("error", (err) => { ws.destroy(); reject(err); });
          });

          req.on("timeout", () => { req.destroy(); reject(new Error("Download timed out")); });
          req.on("error", reject);
          }).catch(reject);
        };

        makeRequest(startUrl, 0);
      };

      begin().catch(reject);
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
  ): Promise<{ fileId: string; name: string; version?: number; updatedAt?: number }> {
    const fileName = basename(localPath);
    localPath = longPath(localPath);
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

      // Integrity guard: parts were streamed from disk against a size/mtime
      // captured before the upload began. If the file changed underneath us the
      // parts no longer form a coherent object — fail BEFORE committing so the
      // reconciler restarts cleanly with a fresh init rather than completing a
      // torn upload.
      await this.assertUnchanged(localPath, fileStat.size, fileStat.mtimeMs);

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
          return {
            fileId: completeData.file?.id ?? sessionId,
            name: fileName,
            version: completeData.file?.current_version,
            updatedAt: completeData.file?.updated_at,
          };
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
    // Per-attempt retry (matching the multipart part loop) with a FRESH read
    // stream each attempt (streamUpload opens its own), so a transient network
    // failure on the single PUT is retried instead of surfacing immediately.
    let putData: any = null;
    let putErr: Error | null = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
      try {
        const sessionCookie = await this.getSessionCookie();
        if (!sessionCookie) throw new Error("SESSION_EXPIRED");

        const result = await this.streamUpload(
          `/api/upload/${sessionId}`,
          localPath,
          fileStat.size,
          sessionCookie,
          onProgress,
        );

        if (!result.ok) throw new Error(result.error || "Upload failed");
        putData = result;
        putErr = null;
        break;
      } catch (err: any) {
        putErr = err;
        if (err instanceof RateLimitError) throw err;
        if (NON_RETRYABLE.has(err.message)) throw err;
        if (attempt < RETRY_DELAYS.length) {
          await sleep(RETRY_DELAYS[attempt] * (0.5 + Math.random()));
        }
      }
    }
    if (putErr || !putData) throw putErr ?? new Error("Upload failed after retries");

    // Integrity guard: if the file changed while we streamed it, the bytes the
    // server received under the initial Content-Length may be torn. Fail so the
    // reconciler re-uploads with a fresh init rather than trusting this version.
    await this.assertUnchanged(localPath, fileStat.size, fileStat.mtimeMs);

    return {
      fileId: putData.file?.id ?? sessionId,
      name: fileName,
      version: putData.file?.current_version,
      updatedAt: putData.file?.updated_at,
    };
  }

  /**
   * Re-stat the file and confirm size + mtime are unchanged since the upload
   * captured them. A mismatch (or the file vanishing) throws, which unwinds the
   * whole uploadFile so the reconciler retries from a fresh init.
   */
  private async assertUnchanged(localPath: string, startSize: number, startMtimeMs: number): Promise<void> {
    const s = await stat(localPath).catch(() => null);
    if (!s) throw new Error("File disappeared during upload — restarting");
    if (s.size !== startSize || s.mtimeMs !== startMtimeMs) {
      throw new Error(
        `File changed during upload (size ${startSize}->${s.size}, mtime ${startMtimeMs}->${s.mtimeMs}) — restarting`,
      );
    }
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

      // Route through the resolved system/corporate proxy when present.
      resolveAgent(fullUrl).then((agent) => {
      const req = lib.request(fullUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(length),
          Cookie: `dosya_session=${cookie}`,
          "X-Dosya-Sync": "1",
          "X-Dosya-Client": "desktop",
        },
        timeout: 300_000,
        agent,
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
      let read = 0;
      stream.on("data", (c: string | Buffer) => { read += typeof c === "string" ? Buffer.byteLength(c) : c.length; });
      stream.on("error", (err) => { req.destroy(); reject(err); });
      // Short-read guard: if the file shrank mid-upload the range yields fewer
      // bytes than the advertised Content-Length, which would otherwise hang the
      // request until timeout. Fail fast so the part is retried / upload restarts.
      stream.on("end", () => {
        if (read !== length) { req.destroy(); reject(new Error(`Short read on part: expected ${length}, read ${read}`)); }
      });
      this.throttle(stream, this.uploadBucket).pipe(req);
      }).catch(reject);
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

      // Route through the resolved system/corporate proxy when present.
      resolveAgent(fullUrl).then((agent) => {
      const req = lib.request(fullUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(fileSize),
          Cookie: `dosya_session=${cookie}`,
          "X-Dosya-Sync": "1",
          "X-Dosya-Client": "desktop",
        },
        timeout: 300_000,
        agent,
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

      // Short-read guard: if the file shrank between the init stat and now, the
      // body is shorter than the advertised Content-Length and the request would
      // hang to timeout. Fail fast so the caller's retry/integrity path kicks in.
      stream.on("end", () => {
        if (transferred !== fileSize) {
          req.destroy();
          reject(new Error(`Short read: expected ${fileSize} bytes, read ${transferred}`));
        }
      });

      this.throttle(stream, this.uploadBucket).pipe(req);
      }).catch(reject);
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
    onProgress?: (filesSoFar: number, page: number) => void,
  ): Promise<{ files: RemoteFileInfo[]; folders: RemoteFolderInfo[]; deleted: string[] } | null> {
    try {
      const files: RemoteFileInfo[] = [];
      let folders: RemoteFolderInfo[] = [];
      const deleted: string[] = [];
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
        // Delta responses may carry tombstones for files deleted since `since`.
        for (const id of data.deleted ?? data.deleted_ids ?? []) {
          if (typeof id === "string") deleted.push(id);
        }

        onProgress?.(files.length, page);

        if (!data.hasMore) break;
        // Guard against a runaway loop: if the server claims more pages but
        // gives no usable cursor — or repeats the one we just used — advancing
        // is impossible and the loop would refetch page 0 forever (real HTTP
        // calls that never error, so the socket timeout never rescues it). This
        // is the "stuck at Starting initial sync..." hang: sync never returns.
        const next: string | null = data.nextCursor ?? null;
        if (!next || next === cursor) {
          debugLog("[sync] snapshot pagination halted: missing or repeated cursor at page", page);
          break;
        }
        cursor = next;
        page++;
        // Backstop cap: even with a well-behaved cursor, never spin indefinitely.
        if (page > MAX_SNAPSHOT_PAGES) {
          debugLog("[sync] snapshot pagination hit page cap", MAX_SNAPSHOT_PAGES);
          break;
        }
      }

      return { files, folders, deleted };
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
    localPath = longPath(localPath);
    const tmpPath = `${localPath}.dosya-sync-tmp`;
    const metaPath = `${tmpPath}.meta`;
    // No cookie for presigned R2 URLs — they carry their own signed auth.
    return this.downloadToFile(presignedUrl, localPath, tmpPath, metaPath, expectedSize, {}, onProgress);
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

      // Route through the resolved system/corporate proxy when present (R2 is a
      // different host, so its proxy is resolved independently).
      resolveAgent(presignedUrl).then((agent) => {
      const req = lib.request(presignedUrl, {
        method: "PUT",
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(fileSize),
        },
        timeout: 300_000,
        agent,
      }, (res) => {
        if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
          res.resume();
          resolve();
          return;
        }
        // Capture R2's error body (S3 XML: <Code>/<Message>) so failures are
        // diagnosable instead of a bare status. R2 uses e.g. "AccessDenied /
        // Request has expired", "SignatureDoesNotMatch", "Unauthorized".
        const chunks: Buffer[] = [];
        let len = 0;
        res.on("data", (c: Buffer) => { if (len < 4096) { chunks.push(c); len += c.length; } });
        res.on("end", () => {
          const body = Buffer.concat(chunks).toString("utf-8").replace(/\s+/g, " ").slice(0, 400).trim();
          let host = "?";
          try { host = new URL(presignedUrl).host; } catch {}
          reject(new Error(`Presigned upload failed: HTTP ${res.statusCode} host=${host} body=${body}`));
        });
        res.on("error", () => reject(new Error(`Presigned upload failed: HTTP ${res.statusCode}`)));
      });

      req.on("timeout", () => { req.destroy(); reject(new Error("Upload timed out")); });
      req.on("error", reject);

      const stream = createReadStream(filePath);
      stream.on("error", (err) => { req.destroy(); reject(err); });
      this.throttle(stream, this.uploadBucket).pipe(req);
      }).catch(reject);
    });
  }

  /**
   * Commit uploaded files to the database.
   */
  async commitUploads(
    workspaceId: string,
    region: string,
    files: { file_id: string; r2_key: string; name: string; size: number; folder_id: string | null; content_type: string; ext: string | null }[],
  ): Promise<{ committed: number; results: Map<string, { version: number; updatedAt: number }> }> {
    const res = await this.fetch("/api/sync/commit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, region, files }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "Commit failed");

    // Capture server-authoritative version/updated_at when the endpoint
    // returns them, so the reconciler doesn't churn on client-guessed values.
    const results = new Map<string, { version: number; updatedAt: number }>();
    const rows = Array.isArray(data.files) ? data.files : Array.isArray(data.results) ? data.results : [];
    for (const r of rows) {
      const id = r?.id ?? r?.file_id;
      if (id) results.set(id, { version: r.current_version ?? r.version ?? 1, updatedAt: r.updated_at ?? r.updatedAt ?? Math.floor(Date.now() / 1000) });
    }
    return { committed: data.committed ?? 0, results };
  }

  // ── Block-level delta sync (feature #3) ───────────────────────────
  // Client half only: ask which chunks are missing, then presign + PUT them.
  // The commit/reassembly endpoint is built+tested separately against dev R2.

  /** Ask the server which of these chunk hashes it doesn't already have. */
  async chunksMissing(workspaceId: string, hashes: string[]): Promise<Set<string>> {
    const res = await this.fetch("/api/sync/chunks/missing", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, hashes }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "chunks/missing failed");
    return new Set<string>(data.missing ?? []);
  }

  /** Get presigned PUT URLs for the given chunks (keyed by hash). */
  async presignChunks(
    workspaceId: string,
    region: string,
    chunks: { hash: string; size: number }[],
  ): Promise<Map<string, { url: string; r2Key: string }>> {
    const res = await this.fetch("/api/sync/chunks/presign", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace_id: workspaceId, region, chunks }),
    });
    if (res.status === 401) throw new Error("SESSION_EXPIRED");
    const data = await res.json();
    if (!data.ok) throw new Error(data.error || "chunks/presign failed");
    const map = new Map<string, { url: string; r2Key: string }>();
    for (const u of data.uploads ?? []) map.set(u.hash, { url: u.url, r2Key: u.r2Key });
    return map;
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
