/** What a response's `Set-Cookie` headers say should happen to `dosya_session`. */
export type SessionCookieUpdate =
  | { action: "store"; value: string }
  | { action: "clear" };

const COOKIE_NAME = "dosya_session";

/** Case-insensitive lookup, because header casing is not guaranteed. */
function setCookieHeaders(headers: Record<string, string[]> | undefined): string[] {
  if (!headers) return [];
  for (const [name, values] of Object.entries(headers)) {
    if (name.toLowerCase() === "set-cookie") return values ?? [];
  }
  return [];
}

/**
 * The `dosya_session` updates carried by a response, or `[]` if there are none.
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
    if (!raw.startsWith(`${COOKIE_NAME}=`)) continue;
    // Keep everything after the first "=" - the value may itself contain "="
    // (base64 padding), and only the part before the first ";" is the value.
    const value = raw.split(";")[0].slice(COOKIE_NAME.length + 1);
    updates.push(value ? { action: "store", value } : { action: "clear" });
  }
  return updates;
}
