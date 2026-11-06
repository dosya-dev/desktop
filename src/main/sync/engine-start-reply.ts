/**
 * Whether the child's reply to "start" means the engine is now running.
 *
 * SyncEngine.start() returns without starting when no session cookie exists
 * yet, which is every launch made while signed out. The host used to keep
 * `running = true` regardless, so the sign-in that followed saw isRunning()
 * and only refreshed the session: the engine never started, and every sync
 * folder logged "startPair skipped - engine not started" until a relaunch.
 * The child now replies with its real state; only an explicit `false` means
 * "not started" (null is a reply from an engine predating the change).
 */
export function engineStartedFromReply(value: unknown): boolean {
  return value !== false;
}
