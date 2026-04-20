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

  return res.json();
}

// Convenience methods
export const api = {
  get: <T>(path: string, signal?: AbortSignal) =>
    apiRequest<T>(path, { signal }),

  post: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "POST", body }),

  put: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "PUT", body }),

  delete: <T>(path: string, body?: unknown) =>
    apiRequest<T>(path, { method: "DELETE", body }),
};
