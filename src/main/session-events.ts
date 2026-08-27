/** Electron's cookie-changed cause values, per electron.d.ts. */
export type CookieChangeCause =
  | "inserted"
  | "inserted-no-change-overwrite"
  | "inserted-no-value-change-overwrite"
  | "explicit"
  | "overwrite"
  | "expired"
  | "evicted"
  | "expired-overwrite";

/**
 * True when the dosya_session cookie disappeared for a reason other than the
 * app's own logout() flow explicitly clearing it (clearSessionCookie calls
 * cookies.remove(), which fires with cause "explicit"). Everything else -
 * the fixed 30-day expiry elapsing, eviction, an overwrite that drops the
 * value - happened without the user taking any action in this app, so they
 * have no way to know sync just stopped unless something tells them.
 */
export function isUnexpectedSessionLoss(removed: boolean, cause: CookieChangeCause | string): boolean {
  return removed && cause !== "explicit";
}
