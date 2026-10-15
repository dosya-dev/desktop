/**
 * The sidebar's per-workspace sync dots, expressed as pure functions so they
 * can be tested without a store, a DOM or an IPC bridge.
 *
 * `status.pairs` arrives over IPC (structured-cloned on every tick), so it is
 * a brand-new array identity even when nothing in it changed. A selector that
 * returns the array itself - or an object built fresh from it - makes
 * zustand's `Object.is` comparison fail on every tick, which re-rendered
 * every subscriber (Sidebar included) twice a second regardless of whether
 * the payload actually differed (DSK-002). `syncSummaryKey` collapses the
 * same reduction down to a single primitive string, which a shallow/identity
 * compare CAN settle on, so the subscribing component only re-renders when a
 * workspace's displayed state actually flips.
 */

/** Just the parts of a pair's status this decision needs. */
export interface SyncSummaryPair {
  workspaceId: string;
  status: string;
}

export interface WorkspaceSyncSummary {
  syncing: boolean;
  error: boolean;
  paused: boolean;
  count: number;
}

/**
 * Per-workspace sync summary: workspaceId -> { syncing, error, paused, count }.
 *
 * Lifted verbatim from the reduction that used to live inline in
 * `Sidebar.tsx` (around line 285) - the mapping is pinned by the test file
 * beside this one and must not drift:
 * - `error` covers status `error`, `needs-confirmation` AND
 *   `needs-permission` (a held deletion and a dropped sandbox grant both
 *   need the user as much as an error does).
 * - `paused` covers status `paused`.
 * - `syncing` covers status `syncing`.
 * - `count` counts every pair with a non-empty `workspaceId`; a pair with an
 *   empty `workspaceId` is skipped entirely (not counted anywhere).
 *
 * The flags are independent, not mutually exclusive: a workspace with two
 * pairs, one `syncing` and one `error`, reports both `syncing: true` and
 * `error: true`.
 */
export function workspaceSyncSummary(pairs: SyncSummaryPair[]): Record<string, WorkspaceSyncSummary> {
  const map: Record<string, WorkspaceSyncSummary> = {};
  for (const p of pairs) {
    const wsId = p.workspaceId;
    if (!wsId) continue;
    if (!map[wsId]) map[wsId] = { syncing: false, error: false, paused: false, count: 0 };
    map[wsId].count++;
    if (p.status === "syncing") map[wsId].syncing = true;
    // A held deletion needs the user as much as an error does; so does a
    // dropped sandbox grant (Mac App Store builds only) - sync is stuck
    // until the folder is reselected.
    if (p.status === "error" || p.status === "needs-confirmation" || p.status === "needs-permission") map[wsId].error = true;
    if (p.status === "paused") map[wsId].paused = true;
  }
  return map;
}

/** Deterministic label for one workspace's three independent flags. */
function stateLabel(s: WorkspaceSyncSummary): string {
  const flags: string[] = [];
  // Fixed order (error, syncing, paused) so two pairs arrays that produce the
  // same flag combination always serialize to the same substring, regardless
  // of which pair set the flag or in what order.
  if (s.error) flags.push("error");
  if (s.syncing) flags.push("syncing");
  if (s.paused) flags.push("paused");
  return flags.length > 0 ? flags.join("+") : "idle";
}

/**
 * A primitive the sidebar can subscribe to instead of the pairs array or the
 * summary object - e.g. `ws_1:syncing,ws_2:error+paused`.
 *
 * Built from `workspaceSyncSummary` so the two can never disagree about what
 * counts as a state change. Workspace ids are sorted, so array order (which
 * can vary tick to tick) never changes the key for an unchanged summary.
 * `count`'s exact number is deliberately left out: nothing the UI renders
 * depends on it beyond "is this workspace present at all" (count > 0), and a
 * workspace only ever appears in the summary once it has at least one pair -
 * so presence in the key already carries that information. Two different
 * flag combinations can never collide into the same label because each
 * combination maps to a distinct, fixed-order substring ("idle" for all-false,
 * otherwise some non-empty subset of "error"/"syncing"/"paused" joined by
 * "+"), and workspace ids are delimited by "," with no id containing either
 * separator character.
 */
export function syncSummaryKey(pairs: SyncSummaryPair[]): string {
  const summary = workspaceSyncSummary(pairs);
  return Object.keys(summary)
    .sort()
    .map((id) => `${id}:${stateLabel(summary[id])}`)
    .join(",");
}

// ── The dashboard's Sync card ───────────────────────────────────────

/** Just the parts of a pair the dashboard's Sync card renders. */
export interface SyncPairCard {
  pairId: string;
  remoteFolderName: string;
  workspaceName: string;
  status: string;
}

/**
 * `DashboardPage`'s `SyncCard` had the same problem the sidebar did, and the
 * fix for the sidebar did not reach it.
 *
 * The card renders exactly four fields per pair - the status icon, the folder
 * name, the workspace name and the status word - and nothing that advances
 * per tick. It subscribed to `useSyncPairs()` anyway, so on the dashboard it
 * re-rendered twice a second for a payload whose displayed content was
 * identical. A 64-minute soak is what surfaced it: with the sidebar fixed,
 * act 2 ("syncing, foreground") still showed ~59 React commits per 30 s
 * sample, which is the pre-fix rate.
 *
 * So the card subscribes to `syncPairCardsKey` and derives its rows from the
 * store only when that key changes, exactly as the sidebar does.
 */
export function syncPairCards(pairs: SyncPairCard[]): SyncPairCard[] {
  return pairs.map((p) => ({
    pairId: p.pairId,
    remoteFolderName: p.remoteFolderName,
    workspaceName: p.workspaceName,
    status: p.status,
  }));
}

/**
 * A primitive for the four fields the card shows, in array order - e.g.
 * `sp_1|Photos|Test Workspace|syncing`.
 *
 * Array order is preserved rather than sorted, unlike `syncSummaryKey`:
 * the card renders the pairs in the order the engine sends them, so a
 * reorder IS a displayed change and must re-render. The field separator is
 * "|" and the record separator "\n", neither of which can appear in a pair
 * id or a status; a folder or workspace NAME could contain "|", but the only
 * consequence would be two different pair lists colliding into one key, so
 * each field is length-prefixed to rule that out.
 */
export function syncPairCardsKey(pairs: SyncPairCard[]): string {
  return pairs
    .map((p) =>
      [p.pairId, p.remoteFolderName, p.workspaceName, p.status]
        .map((f) => `${f.length}:${f}`)
        .join("|"),
    )
    .join("\n");
}
