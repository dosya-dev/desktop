/**
 * Pure classification of a failed API request, DOM-free so node:test can
 * cover it (api-client.ts itself pulls in the i18n JSON and cannot be).
 */

/** `ApiError.data.code` for a request Cloudflare refused before the API saw it. */
export const EDGE_CHALLENGE_CODE = "edge_challenge";

/**
 * Cloudflare marks every response it generates for a WAF challenge with
 * `cf-mitigated: challenge` (managed, JS and interactive challenges alike).
 * The API itself never sends this header.
 */
export function isEdgeChallenge(headers: { get(name: string): string | null }): boolean {
  return (headers.get("cf-mitigated") ?? "").trim().toLowerCase() === "challenge";
}

/** A deliberate cancellation (AbortController), which callers handle themselves. */
export function isAbortError(err: unknown): boolean {
  return (err as { name?: unknown } | null)?.name === "AbortError";
}
