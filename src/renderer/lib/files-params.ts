/**
 * The query string is the single source of truth for what the files browser is
 * showing: `folder` (where you are), `filter` (which file types), `deleted` /
 * `hidden` (the two special views), plus `sort`, `q` and `page`.
 *
 * Picking a view used to be FileBrowserPage's private business, because the only
 * thing that could pick one was its own chip row. The sidebar now picks views
 * too, from outside the page - so the rule about which params survive a
 * transition lives here, in one place, instead of being re-derived by each
 * caller. apps/web splits it out for the same reason (see its files-params.ts).
 */

/** Every view a sidebar row or chip can select. */
export type FilterId =
  | "all" | "documents" | "videos" | "images"
  | "shared" | "favourites" | "deleted" | "hidden";

/**
 * Select a view, keeping the folder you are standing in so a filtered view stays
 * filtered while you browse - except for the trash and the hidden view, which
 * span the whole workspace and so always open at their own root.
 *
 * Pass a fresh `URLSearchParams` when navigating from another page: carrying a
 * different page's query into /files is how unrelated params leak in.
 */
export function filterNavParams(current: URLSearchParams, filter: FilterId): URLSearchParams {
  const next = new URLSearchParams(current);
  // Pagination is per-view: item 3 of Images has nothing to do with item 3 of All.
  next.delete("page");
  next.delete("deleted");
  next.delete("hidden");

  if (filter === "deleted" || filter === "hidden") {
    // A folder id inside the trash addresses a TRASHED folder, which means
    // something else entirely to a live folder lookup. Never carry it across.
    next.set("filter", "all");
    next.set(filter, "1");
    next.delete("folder");
  } else {
    next.set("filter", filter);
  }
  return next;
}

/** Which view the given query string is currently showing. */
export function activeFilter(params: URLSearchParams): FilterId {
  if (params.get("deleted") === "1") return "deleted";
  if (params.get("hidden") === "1") return "hidden";
  return (params.get("filter") || "all") as FilterId;
}

/** Build the href a sidebar row should point at, from wherever the user is now. */
export function filesHref(current: URLSearchParams, onFilesPage: boolean, filter: FilterId): string {
  const base = onFilesPage ? current : new URLSearchParams();
  const qs = filterNavParams(base, filter).toString();
  return qs ? `/files?${qs}` : "/files";
}
