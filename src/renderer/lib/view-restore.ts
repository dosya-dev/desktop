// Deep-link restore decision for FileBrowserPage's `?view=<id>` / `?panel=<id>`
// params (web parity). Pulled out as a pure function so the loop-guard logic
// against the URL-mirror effect (which writes the open viewer/panel back into
// the same params) can be unit-tested without rendering the 2600-line page.
//
// The page keeps a single piece of memory across renders: the id it last
// opened *because of* a restore (not because the user clicked a row). That
// memory, not a one-shot "have we ever restored" flag, is what has to decide
// whether a given params snapshot is something new to open:
//   - same id as last restored -> the mirror effect just wrote this back, do nothing
//   - different id -> a real navigation (back/forward, a new link, a rename of
//     the hash) landed on an already-mounted page, open it
//   - no id at all -> nothing to show, AND the memory must clear, so a later
//     return to the same id (e.g. closing the viewer and reopening the same
//     file by hand) is treated as new rather than silently swallowed
export type RestoreAction = "view" | "detail";

export type RestoreDecision =
  | { type: "restore"; id: string; action: RestoreAction }
  | { type: "clear" }
  | { type: "noop" };

/**
 * Decide what FileBrowserPage's deep-link effect should do for the current
 * `searchParams`, given the id it last restored (or `null` if nothing has
 * been restored yet, or the params were last empty).
 *
 * `view` wins over `panel` when both are present - today's behaviour,
 * preserved here rather than changed.
 */
export function restoreTarget(params: URLSearchParams, lastRestoredId: string | null): RestoreDecision {
  const viewId = params.get("view");
  const panelId = params.get("panel");
  const id = viewId || panelId;

  if (!id) {
    // Nothing to restore. If we were remembering an id, drop it: the page is
    // back to a clean slate, so the *next* appearance of that same id (the
    // user reopens the same file) must restore again, not be mistaken for
    // the mirror effect's own echo.
    return lastRestoredId === null ? { type: "noop" } : { type: "clear" };
  }

  if (id === lastRestoredId) {
    // This is either the mirror effect's own write coming back around, or a
    // repeat of a param we already acted on. Either way, opening again would
    // loop (restore -> mirror writes the url -> restore sees "new" params ->
    // restore again -> ...).
    return { type: "noop" };
  }

  return { type: "restore", id, action: viewId ? "view" : "detail" };
}
