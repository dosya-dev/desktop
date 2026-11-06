/**
 * Make a Cloudflare WAF challenge readable to the renderer.
 *
 * QA TC-009/014/015: the zone has a WAF rule ("challenge password leaked",
 * Cloudflare leaked-credential detection) that answers POST /api/auth/login,
 * /api/auth/signup and the reset routes with a Managed Challenge whenever the
 * submitted `password` field is on a breach list. That answer is Cloudflare's
 * own 403 HTML page with `cf-mitigated: challenge` and NO CORS headers - the
 * request never reaches the Worker, so the API's CORS middleware never runs.
 * The renderer (app://bundle) is cross-origin to the API, so Chromium refuses
 * the response and fetch() rejects with a bare "Failed to fetch
 * (api.dosya.dev)": a wrong password, a correct-but-leaked one and a sign-up
 * with one all looked like the network being down.
 *
 * The app cannot solve a challenge, but it can say what happened. This adds
 * the minimum CORS grant to THAT response only, so the renderer reads a 403
 * carrying `cf-mitigated` and shows a real message (api-client.ts).
 *
 * Narrow on purpose:
 * - only responses that carry `cf-mitigated` (Cloudflare-generated; the API
 *   never sends it), and only from the API origin (the caller gates that with
 *   originAllowed before calling this);
 * - only when the response has no Access-Control-Allow-Origin of its own;
 * - only for a renderer origin the API's own allowlist already grants
 *   (`app://bundle`, or a localhost dev renderer), passed in by the caller.
 * Nothing here lets any other origin read anything.
 */

type Headers = Record<string, string[]>;

function headerValue(headers: Headers, name: string): string | null {
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === name) return v?.[0] ?? null;
  }
  return null;
}

/**
 * Scheme + host of the document that made the request, or null. Not
 * `URL.origin`: for the non-special `app:` scheme that is the opaque "null".
 */
export function rendererOrigin(documentUrl: string | null | undefined): string | null {
  if (!documentUrl) return null;
  try {
    const u = new URL(documentUrl);
    if (!u.host) return null;
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

/**
 * The response headers with a CORS grant added for `origin`, or null when this
 * response is not a Cloudflare challenge that needs one.
 */
export function challengeCorsHeaders(
  responseHeaders: Headers | undefined,
  origin: string | null,
  allowedOrigins: readonly string[],
): Headers | null {
  if (!responseHeaders || !origin || !allowedOrigins.includes(origin)) return null;
  if ((headerValue(responseHeaders, "cf-mitigated") ?? "").trim().toLowerCase() !== "challenge") return null;
  if (headerValue(responseHeaders, "access-control-allow-origin") !== null) return null;
  return {
    ...responseHeaders,
    "Access-Control-Allow-Origin": [origin],
    "Access-Control-Allow-Credentials": ["true"],
    "Access-Control-Expose-Headers": ["cf-mitigated"],
  };
}
