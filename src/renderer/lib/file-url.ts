// Ported from apps/web/src/lib/file-url.ts — keep in sync with the web copy.
// Desktop delta: API base comes from the IPC-primed apiBase() instead of a
// build-time constant, plus a fileDownloadUrl helper for version downloads.

import { apiBase } from "@/lib/api-client";

export interface FileRef {
  fileId: string;
  /** Omit or pass 0 for the current version. */
  version?: number;
  /** Extra query params, e.g. `ut=<unlock token>` or a cache-buster. */
  query?: string;
}

/**
 * The single place a /raw URL is built. Every preview surface goes through
 * here — the endpoint streams the original bytes inline with cookie auth.
 */
export function fileRawUrl({ fileId, version, query }: FileRef): string {
  const params = new URLSearchParams();
  if (version && version > 0) params.set("version", String(version));
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) params.set(k, v);
  }
  const qs = params.toString();
  return `${apiBase()}/api/files/${fileId}/raw${qs ? `?${qs}` : ""}`;
}

/** Longest-edge sizes the API will serve. Anything else is rejected with a 400. */
export type ThumbSize = 128 | 256 | 512 | 1600;

/** URL of a server-generated WebP thumbnail. The renderer never decodes anything. */
export function fileThumbUrl({ fileId, version, query, size }: FileRef & { size: ThumbSize }): string {
  const params = new URLSearchParams();
  if (version && version > 0) params.set("version", String(version));
  if (query) {
    for (const [k, v] of new URLSearchParams(query)) params.set(k, v);
  }
  params.set("w", String(size));
  return `${apiBase()}/api/files/${fileId}/thumb?${params}`;
}

/** Attachment-download URL (used by the main-process download IPC and links). */
export function fileDownloadUrl(fileId: string, version?: number): string {
  const qs = version && version > 0 ? `?version=${version}` : "";
  return `${apiBase()}/api/files/${fileId}/download${qs}`;
}
