import { toast } from "sonner";
import { queryClient } from "./query-client";
import { clearHeicCaches } from "./heic-cache";
import { useSyncStore } from "./sync-store";

/** Fired after session-scoped state is torn down. Providers that hold
 *  per-account state in React state (e.g. WorkspaceProvider's activeId)
 *  listen for this to reset themselves. */
export const SESSION_RESET_EVENT = "dosya:session-reset";

/**
 * Tear down every piece of renderer state that belongs to the current
 * account. Runs on explicit logout AND on 401-detected session expiry, so
 * the next account can never see this account's data. Must stay idempotent —
 * it can run twice in a row (expiry watcher + explicit logout).
 */
export function resetSessionState(): void {
  queryClient.clear();
  clearHeicCaches();
  // Kill any visible toasts (e.g. upload progress/results) — the root-level
  // <Toaster> outlives the protected routes, so stale toasts would otherwise
  // show on the login screen or to the next account.
  toast.dismiss();
  // Drop the last sync snapshot (pair names, file names, logs are per-account).
  useSyncStore.setState({ status: null, conflicts: [], isLoading: true });
  window.dispatchEvent(new Event(SESSION_RESET_EVENT));
}
