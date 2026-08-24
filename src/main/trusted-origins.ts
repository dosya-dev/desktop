/**
 * Origin comparison for the main process's navigation and request guards.
 *
 * Every one of those guards used to be a `url.startsWith(trusted)` test. That
 * is a substring match, not an origin match, so an attacker-registered
 * `accounts.google.com.evil.example` passed a check against
 * `https://accounts.google.com`. Same for `api.dosya.dev.evil.example` against
 * the API base, which additionally let an attacker-controlled response write
 * the `dosya_session` cookie. Compare parsed origins instead.
 */

/**
 * Scheme + host, which is what "same origin" means for our purposes.
 *
 * Deliberately NOT `URL.origin`: for a non-special scheme like our packaged
 * `app://bundle`, `URL.origin` is the opaque string "null", so comparing
 * origins would make every `app://` URL - including `app://evil` - compare
 * equal. `host` carries the port when there is a non-default one.
 */
function originKey(url: URL): string {
  return `${url.protocol}//${url.host}`;
}

/**
 * True when `url` parses and its origin is exactly one of `allowed`.
 *
 * Unparseable input on either side is not trusted rather than throwing, so a
 * malformed URL can never fall through into an allow decision.
 */
export function originAllowed(url: string, allowed: readonly string[]): boolean {
  let key: string;
  try {
    key = originKey(new URL(url));
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    try {
      return originKey(new URL(entry)) === key;
    } catch {
      return false;
    }
  });
}
