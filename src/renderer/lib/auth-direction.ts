import { useState } from "react";
import { useLocation } from "react-router-dom";

/**
 * Where each auth screen sits in the sign-in sequence.
 *
 * Not a strict path every user walks - it is an ordering, and only the sign of
 * the difference is used. Login is the hub at 0, so anything reached from it
 * reads as forward and returning to it reads as back. That gets every real
 * journey right: login → two-factor is forward, forgot-password → login is
 * back, sign-up → verify is forward.
 */
const FLOW = ["/login", "/signup", "/forgot-password", "/verify", "/2fa"] as const;

export type AuthDirection = "fwd" | "back";

/** Exported for the test; `null` means "no previous screen", i.e. a cold open. */
export function directionBetween(from: string | null, to: string): AuthDirection {
  if (!from) return "fwd";
  const a = FLOW.indexOf(from as (typeof FLOW)[number]);
  const b = FLOW.indexOf(to as (typeof FLOW)[number]);
  // An unknown path on either side has no position to compare, so it cannot
  // claim a direction; entering forward is the honest default.
  if (a === -1 || b === -1) return "fwd";
  return b < a ? "back" : "fwd";
}

/**
 * Module scope on purpose: each auth page unmounts when the route changes, so a
 * ref inside the component would be gone by the time the next one asks which
 * way it arrived.
 */
let lastAuthPath: string | null = null;

/** Test seam - React has no way to reset module state between cases. */
export function resetAuthDirection(): void {
  lastAuthPath = null;
}

/**
 * The direction the current auth screen arrived from. Put the result on the
 * page's root element as `data-auth-dir`; the `.auth-step` class in index.css
 * reads it, so a page animates without changing its markup.
 */
export function useAuthDirection(): AuthDirection {
  const { pathname } = useLocation();
  // A state initialiser runs once per mount, and these pages mount once per
  // navigation - which is exactly the moment the direction is decided. Writing
  // `lastAuthPath` only when the path actually changed keeps the answer stable
  // if React double-invokes the initialiser in StrictMode.
  const [dir] = useState<AuthDirection>(() => {
    const d = directionBetween(lastAuthPath, pathname);
    if (lastAuthPath !== pathname) lastAuthPath = pathname;
    return d;
  });
  return dir;
}
