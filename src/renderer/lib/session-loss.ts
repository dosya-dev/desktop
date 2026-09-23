// apps/desktop/src/renderer/lib/session-loss.ts
//
// How the renderer learns that its session died on the server without this
// app doing anything: an admin revoked it from the portal, the user ended it
// from another device, or it simply expired. Three signals converge on the
// auth context, which confirms against /api/me before signing out:
//
//   1. Any API response that is a 401 (api-client.ts, upload-transport.ts)
//      reports through `sessionLoss`.
//   2. The sync engine's own 401 arrives over IPC (auth:session-expired).
//   3. A periodic and on-focus re-check covers a window that is idle.
//
// Pure and import-free so it runs under `node --test`.

/** How often an idle, signed-in window re-checks /api/me. */
export const SESSION_CHECK_INTERVAL_MS = 5 * 60 * 1000;

/** sessionStorage key carrying the "why you were signed out" line across
 *  the reload that tears the session down. */
export const SIGNED_OUT_NOTICE_KEY = "dosya:signed-out-notice";

/** A 401 means "session gone" everywhere except the auth routes, where it
 *  is the ordinary answer to a wrong password or code. */
export function isSessionLossResponse(path: string, status: number): boolean {
  if (status !== 401) return false;
  return !path.startsWith("/api/auth/");
}

export class SessionLossSignal {
  private listeners = new Set<() => void>();
  // A 401 can land while the auth provider is still mounting; it is held
  // for the first subscriber rather than dropped.
  private pending = false;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    if (this.pending) {
      this.pending = false;
      fn();
    }
    return () => { this.listeners.delete(fn); };
  }

  report(): void {
    if (this.listeners.size === 0) {
      this.pending = true;
      return;
    }
    for (const fn of [...this.listeners]) fn();
  }
}

export const sessionLoss = new SessionLossSignal();
