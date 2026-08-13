/**
 * Typed API client for dosya.dev REST API.
 *
 * Uses fetch with credentials: 'include' so Electron's Chromium
 * automatically sends the dosya_session cookie.
 */

let _apiBase: string | null = null;

async function getApiBase(): Promise<string> {
  if (_apiBase) return _apiBase;
  _apiBase = await window.electronAPI.getApiBase();
  return _apiBase;
}

/** Must be awaited once at app bootstrap (main.tsx) before the first render. */
export async function primeApiBase(): Promise<void> {
  _apiBase = await window.electronAPI.getApiBase();
}

/**
 * Synchronous API base for URL building (img/video/iframe src attributes,
 * which can't await). Safe anywhere below the app root: main.tsx primes it
 * before rendering.
 */
export function apiBase(): string {
  if (!_apiBase) throw new Error("API base not primed");
  return _apiBase;
}

export class ApiError extends Error {
  status: number;
  data: Record<string, unknown>;

  constructor(
    message: string,
    status: number,
    data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal;
}

export async function apiRequest<T>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const apiBase = await getApiBase();
  const { method = "GET", body, headers = {}, signal } = options;

  const fetchHeaders: Record<string, string> = { ...headers };
  if (body && !(body instanceof FormData) && !(body instanceof ArrayBuffer)) {
    fetchHeaders["Content-Type"] = "application/json";
  }

  const res = await fetch(`${apiBase}${path}`, {
    method,
    headers: fetchHeaders,
    body:
      body instanceof FormData || body instanceof ArrayBuffer
        ? body
        : body
          ? JSON.stringify(body)
          : undefined,
    credentials: "include",
    signal,
  });

  if (!res.ok) {
    let errorData: Record<string, unknown> = {};
    try {
      errorData = await res.json();
    } catch {
      // non-JSON error response
    }
    throw new ApiError(
      (errorData.error as string) || `Request failed (${res.status})`,
      res.status,
      errorData,
    );
  }

  // Handle empty responses (204, etc.)
  const contentType = res.headers.get("content-type");
  if (!contentType || !contentType.includes("application/json")) {
    return undefined as T;
  }

  // A JSON content-type with an empty/truncated body makes res.json() throw a
  // raw SyntaxError that callers branching on `instanceof ApiError` won't
  // recognize. Normalize it: an empty body → undefined, malformed → ApiError.
  // Clone BEFORE reading so we can still inspect the body if json() fails.
  const bodyClone = res.clone();
  try {
    return await res.json();
  } catch {
    const text = await bodyClone.text().catch(() => "");
    if (!text.trim()) return undefined as T;
    throw new ApiError("Malformed response from server", res.status);
  }
}

// Convenience methods
export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { signal }),

  post: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "POST", body }),

  put: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "PUT", body }),

  patch: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "PATCH", body }),

  delete: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "DELETE", body }),
};
