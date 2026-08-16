/**
 * Remembers the last page so a reclaimed (destroyed-and-recreated) window
 * boots back into it instead of resetting to the dashboard. DOM-free on
 * purpose: storage is injected, so the logic unit-tests under node --test.
 */

export interface RouteStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export const LAST_ROUTE_KEY = "dosya_last_route";

/**
 * Auth/transient pages must never be restored into: landing a fresh window on
 * /login or /2fa fights the auth redirect, and /editor holds a live remote
 * editing session that should be re-entered deliberately, not by default.
 */
const NON_RESTORABLE = ["/onboarding", "/login", "/signup", "/forgot-password", "/2fa", "/verify", "/editor"];

export function isRestorableRoute(path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 500) return false;
  if (path === "/") return false;
  return !NON_RESTORABLE.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

export function saveLastRoute(path: string, storage: RouteStorage): void {
  if (!isRestorableRoute(path)) return;
  try { storage.setItem(LAST_ROUTE_KEY, path); } catch {}
}

/** Re-validates on read: storage is user-writable, so treat it as input. */
export function readLastRoute(storage: RouteStorage): string | null {
  try {
    const v = storage.getItem(LAST_ROUTE_KEY);
    return v !== null && isRestorableRoute(v) ? v : null;
  } catch {
    return null;
  }
}
