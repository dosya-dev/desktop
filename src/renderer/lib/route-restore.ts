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
const NON_RESTORABLE = ["/onboarding", "/login", "/signup", "/forgot-password", "/2fa", "/verify", "/editor", "/about"];

export function isRestorableRoute(path: string): boolean {
  if (typeof path !== "string" || !path.startsWith("/") || path.length > 500) return false;
  if (path === "/") return false;
  return !NON_RESTORABLE.some((p) => path === p || path.startsWith(p + "/") || path.startsWith(p + "?"));
}

/**
 * Query params that describe a full-window overlay sitting ON TOP of a page
 * rather than the page itself. `view=<id>` is the file viewer, which covers
 * the whole window (title bar included). Restoring it on launch dropped the
 * user straight back into the viewer they had just closed the app from
 * (desktop QA TC-032/033/037), so it is stripped and the list underneath is
 * restored instead. `panel=<id>` (the side detail panel) is part of the list
 * and stays.
 */
const TRANSIENT_PARAMS = ["view"];

/** `path` minus any TRANSIENT_PARAMS; other params keep their order. */
export function stripTransientParams(path: string): string {
  const q = path.indexOf("?");
  if (q < 0) return path;
  const params = new URLSearchParams(path.slice(q + 1));
  let changed = false;
  for (const k of TRANSIENT_PARAMS) {
    if (params.has(k)) { params.delete(k); changed = true; }
  }
  if (!changed) return path;
  const rest = params.toString();
  return rest ? `${path.slice(0, q)}?${rest}` : path.slice(0, q);
}

export function saveLastRoute(path: string, storage: RouteStorage): void {
  if (!isRestorableRoute(path)) return;
  try { storage.setItem(LAST_ROUTE_KEY, stripTransientParams(path)); } catch {}
}

/** Re-validates on read: storage is user-writable, so treat it as input. */
export function readLastRoute(storage: RouteStorage): string | null {
  try {
    const v = storage.getItem(LAST_ROUTE_KEY);
    // Stripped on read too: a value saved by 3.1.3 or earlier can still carry
    // the viewer's `view=` param.
    return v !== null && isRestorableRoute(v) ? stripTransientParams(v) : null;
  } catch {
    return null;
  }
}
