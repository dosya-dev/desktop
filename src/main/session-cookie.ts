/**
 * The two names the session cookie can arrive under. The API issues
 * `__Host-dosya_session` in production (host-only on api.dosya.dev, so no
 * *.dosya.dev subdomain can toss it) and the plain `dosya_session` in dev
 * (http, where the `__Host-` prefix - which mandates Secure - is not allowed).
 * Desktop recognises and stores whichever it is given, and always sends back
 * the same name the API expects.
 */
export const HOST_SESSION_COOKIE = "__Host-dosya_session"; // prod, untossable
export const LEGACY_SESSION_COOKIE = "dosya_session";      // dev / pre-migration

/** True when `name` is either session cookie name. */
export function isSessionCookieName(name: string): boolean {
  return name === HOST_SESSION_COOKIE || name === LEGACY_SESSION_COOKIE;
}

/**
 * From the cookies the store holds, pick the one to send - preferring the
 * untossable `__Host-` cookie - as a ready `name=value` Cookie-header pair.
 * Null when the store holds neither.
 */
export function sessionCookieHeader(
  cookies: readonly { name: string; value: string }[],
): string | null {
  const chosen =
    cookies.find((c) => c.name === HOST_SESSION_COOKIE) ??
    cookies.find((c) => c.name === LEGACY_SESSION_COOKIE);
  return chosen ? `${chosen.name}=${chosen.value}` : null;
}

/** What a response's `Set-Cookie` headers say should happen to the session cookie. */
export type SessionCookieUpdate =
  | { action: "store"; name: string; value: string }
  | { action: "clear"; name: string };

/** Case-insensitive lookup, because header casing is not guaranteed. */
function setCookieHeaders(headers: Record<string, string[]> | undefined): string[] {
  if (!headers) return [];
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie") return values ?? [];
  }
  return [];
}

/**
 * The session-cookie updates carried by a response, or `[]` if there are none.
 * Recognises BOTH `__Host-dosya_session` and the legacy `dosya_session`, and
 * reports which name each update is for so the caller can store it under that
 * exact name (the API trusts the name it issued).
 *
 * Deliberately does NOT decide whether the response is allowed to set the
 * cookie - the caller gates that on the request origin. That check used to be
 * `details.url.startsWith(apiBase)`, which an attacker-registered
 * `api.dosya.dev.evil.example` satisfied, letting attacker-controlled content
 * write the victim's session cookie for the real API origin.
 */
export function parseSessionCookieHeaders(
  headers: Record<string, string[]> | undefined,
): SessionCookieUpdate[] {
  const updates: SessionCookieUpdate[] = [];
  for (const raw of setCookieHeaders(headers)) {
    // Try `__Host-dosya_session=` first: it contains the substring
    // `dosya_session=`, so matching the legacy name first would misread it.
    for (const name of [HOST_SESSION_COOKIE, LEGACY_SESSION_COOKIE]) {
      if (!raw.startsWith(`${name}=`)) continue;
      // Keep everything after the first "=" up to the first ";" - the value may
      // itself contain "=" (base64 padding).
      const value = raw.split(";")[0].slice(name.length + 1);
      updates.push(value ? { action: "store", name, value } : { action: "clear", name });
      break;
    }
  }
  return updates;
}

/**
 * The 2FA challenge cookie the API sets after a password that needs a second
 * factor (apps/api/src/lib/auth.ts CHALLENGE_COOKIE). Like the session cookie it
 * is SameSite=Lax and set on a cross-site response, so Chromium drops it unless
 * main stores it by hand; without it /api/auth/2fa/verify finds no challenge.
 */
export const CHALLENGE_COOKIE = "dosya_2fa_challenge";

export type ChallengeCookieUpdate =
  | { action: "store"; value: string; maxAgeSeconds: number | null }
  | { action: "clear" };

/** The challenge-cookie update a response carries, or null. Origin gating is the caller's, as above. */
export function parseChallengeCookieHeader(headers: Record<string, string[]> | undefined): ChallengeCookieUpdate | null {
  for (const raw of setCookieHeaders(headers)) {
    if (!raw.startsWith(`${CHALLENGE_COOKIE}=`)) continue;
    const [pair, ...attrs] = raw.split(";");
    const value = pair.slice(CHALLENGE_COOKIE.length + 1);
    const maxAgeAttr = attrs.map((a) => a.trim()).find((a) => a.toLowerCase().startsWith("max-age="));
    const maxAge = maxAgeAttr ? Number(maxAgeAttr.slice("max-age=".length)) : null;
    if (!value || maxAge === 0) return { action: "clear" };
    return { action: "store", value, maxAgeSeconds: Number.isFinite(maxAge) ? maxAge : null };
  }
  return null;
}
