/**
 * "Is this failure the network being gone?"
 *
 * One home for the question, because three things now depend on the same
 * answer: the recovery loop retries a pair parked on it, the poller's error
 * handler puts a pair into `offline` rather than swallowing the error, and
 * the tray refuses to say "All synced" while it holds.
 *
 * It used to be a private function inside the engine, which is why the
 * poller's handler could quietly disagree with it: a machine with no network
 * and no local changes sat at `idle` showing "Synced" indefinitely while the
 * poller backed off in silence. A leaf module (no sibling value imports) so
 * `node --test` can pin it.
 */

/** What the user is told while a pair cannot reach the server. */
export const OFFLINE_MESSAGE =
  "Cannot connect to dosya.dev right now. Sync resumes automatically when the connection is back.";

/**
 * Whether a message describes a connectivity failure - one that resolves by
 * itself once the network is back, so the pair should be retried rather than
 * left parked until the app restarts.
 */
export function isNetworkErrorMessage(message: string | null | undefined): boolean {
  if (!message) return false;
  return /\b(ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENETDOWN|EPIPE|EAI_AGAIN|UND_ERR\w*|ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_NAME_NOT_RESOLVED)\b/i.test(message)
    || /\b(fetch failed|network error|socket hang up|request timed out)\b/i.test(message);
}

/** The same question asked of anything throwable, including a bare string. */
export function isOfflineError(err: unknown): boolean {
  if (err instanceof Error) return isNetworkErrorMessage(err.message);
  if (typeof err === "string") return isNetworkErrorMessage(err);
  if (typeof err === "object" && err !== null) {
    const m = (err as { message?: unknown }).message;
    return typeof m === "string" && isNetworkErrorMessage(m);
  }
  return false;
}
