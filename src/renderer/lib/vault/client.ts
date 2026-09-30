import {
  createFetchApiClient,
  createFetchChunkTransport,
  type ApiClient,
  type ChunkTransport,
} from "@dosya-dev/e2ee-client";
import { apiBase } from "@/lib/api-client";

/** fetch that always carries the session cookie (credentialed CORS from app://bundle). */
const credentialedFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, credentials: "include" });

/**
 * The E2EE engine's two transports for the desktop renderer.
 * - `api`: every /api/e2ee/* call, cookie-authed against the primed API base.
 * - `transport`: presigned R2 chunk PUT/GET with NO credentials - the URL is
 *   the credential, and a cookie would only widen what a leaked URL carries.
 */
export function buildE2eeClient(): { api: ApiClient; transport: ChunkTransport } {
  const api = createFetchApiClient({ baseUrl: apiBase(), fetchFn: credentialedFetch });
  const transport = createFetchChunkTransport();
  return { api, transport };
}

/**
 * The recovery key as the engine wants it. `setup()` shows one unbroken hex
 * string; people paste it back with the spaces, dashes or line breaks their
 * password manager added. Nothing else is touched - the value is hex and case
 * is the caller's business.
 */
export function normalizeRecoveryKey(raw: string): string {
  return raw.replace(/[\s-]/g, "");
}
