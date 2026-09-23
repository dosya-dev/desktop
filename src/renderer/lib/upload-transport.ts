// apps/desktop/src/renderer/lib/upload-transport.ts
//
// The renderer's real HTTP transport for upload-in-parts.ts: init through the
// shared API client, bytes through XMLHttpRequest (fetch has no upload
// progress in Chromium), complete through fetch. Kept apart from the pure
// helper so the helper stays loadable under `node --test`.
import { api, apiBase, ApiError } from "./api-client";
import { isSessionLossResponse, sessionLoss } from "./session-loss";
import {
  cancelledError,
  type HttpResult,
  type InitResponse,
  type PutOptions,
  type Transport,
} from "./upload-in-parts";

/** Per request, not per file: a 10 MB part or a sub-50 MB single PUT. */
const REQUEST_TIMEOUT_MS = 600_000;

function xhrPut(opts: PutOptions): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) { reject(cancelledError()); return; }
    const xhr = new XMLHttpRequest();
    // Uses the IPC-primed apiBase() - a bare relative path would resolve
    // against the renderer's own app://bundle origin and get swallowed by the
    // static-asset protocol handler instead of reaching the real API.
    xhr.open("PUT", `${apiBase()}${opts.path}`);
    xhr.withCredentials = true;
    for (const [k, v] of Object.entries(opts.headers ?? {})) xhr.setRequestHeader(k, v);
    xhr.timeout = REQUEST_TIMEOUT_MS;

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded);
    };
    const onAbort = () => xhr.abort();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    xhr.onloadend = () => opts.signal?.removeEventListener("abort", onAbort);

    xhr.onload = () => {
      let data: unknown = {};
      try { data = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
      if (isSessionLossResponse(opts.path, xhr.status)) sessionLoss.report();
      resolve({ status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error("Network error"));
    xhr.ontimeout = () => reject(new Error("Upload timed out"));
    // Aborting an XHR fires `abort` (not `error`), so settle the promise
    // here - otherwise it hangs forever.
    xhr.onabort = () => reject(cancelledError());

    // Send the Blob directly - XHR streams it, no arrayBuffer() needed.
    xhr.send(opts.body);
  });
}

export const uploadTransport: Transport = {
  async init(body) {
    try {
      return await api.post<InitResponse>("/api/upload/init", body);
    } catch (err) {
      // The API client throws on non-2xx; the helper wants the refusal as
      // data so it can surface the server's sentence (quota, size cap...).
      if (err instanceof ApiError) return { ok: false, error: err.message };
      if (err instanceof DOMException && err.name === "AbortError") throw cancelledError();
      throw err;
    }
  },
  put: xhrPut,
  async post(path, headers, signal) {
    let res: Response;
    try {
      res = await fetch(`${apiBase()}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json", ...(headers ?? {}) },
        body: "{}",
        signal,
      });
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") throw cancelledError();
      throw err;
    }
    if (isSessionLossResponse(path, res.status)) sessionLoss.report();
    const data = await res.json().catch(() => ({}));
    return { status: res.status, data };
  },
};
