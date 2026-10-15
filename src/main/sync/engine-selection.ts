import type { Distribution } from "../distribution";

/**
 * Whether the sync engine runs inside the main process instead of its own
 * utility process.
 *
 * In-process is the escape hatch for debugging (DOSYA_SYNC_IN_PROCESS=1 puts
 * the engine where the inspector already is) and the rule for the Mac App
 * Store build: the grant a security-scoped bookmark reopens is taken by the
 * main process (src/main/sync/bookmarks.ts), and whether a utility child
 * inherits it is unverified. Revisit after the first TestFlight build; a
 * child that does inherit would let the store build keep the isolation.
 */
export function shouldRunEngineInProcess({
  env,
  distribution,
}: {
  env: Record<string, string | undefined>;
  distribution: Distribution;
}): boolean {
  if (env.DOSYA_SYNC_IN_PROCESS === "1") return true;
  return distribution === "mas";
}
