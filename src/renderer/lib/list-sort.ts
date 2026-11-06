// Copied from apps/web/src/lib/list-sort.ts so both apps sort columns the same way.
// Sort state for the files list. The table lets users sort by any column;
// the API accepts the six legacy modes plus a generic `<column>_<asc|desc>`
// (whitelisted server-side in apps/api/src/lib/list-sort.ts).

export type SortKey =
  | "name" | "size" | "created" | "modified" | "taken" | "type" | "extension"
  | "version" | "uploader" | "region" | "origin" | "shares" | "comments";
export type SortDir = "asc" | "desc";
export interface SortSpec { key: SortKey; dir: SortDir }

export const DEFAULT_SORT: SortSpec = { key: "created", dir: "desc" };

// `taken` (Contract 5) orders by COALESCE(captured_at, source_created_at,
// created_at) server-side - the date a photo was taken, falling back to the
// file's own date and then the upload.
const SORT_KEYS: SortKey[] = [
  "name", "size", "created", "modified", "taken", "type", "extension",
  "version", "uploader", "region", "origin", "shares", "comments",
];

// The six modes the toolbar dropdown has always offered keep their legacy
// wire names so the API param stays byte-identical for the common cases.
const LEGACY_BY_NAME: Record<string, SortSpec> = {
  newest: { key: "created", dir: "desc" },
  oldest: { key: "created", dir: "asc" },
  name_asc: { key: "name", dir: "asc" },
  name_desc: { key: "name", dir: "desc" },
  largest: { key: "size", dir: "desc" },
  smallest: { key: "size", dir: "asc" },
};

export function serializeSort(sort: SortSpec): string {
  for (const [name, spec] of Object.entries(LEGACY_BY_NAME)) {
    if (spec.key === sort.key && spec.dir === sort.dir) return name;
  }
  return `${sort.key}_${sort.dir}`;
}

/** Whether a table column key is one the API can order by. Desktop-only addition. */
export function isSortKey(key: string): key is SortKey {
  return (SORT_KEYS as string[]).includes(key);
}

export function parseSort(value: string): SortSpec {
  const legacy = LEGACY_BY_NAME[value];
  if (legacy) return legacy;
  const idx = value.lastIndexOf("_");
  const key = value.slice(0, idx) as SortKey;
  const dir = value.slice(idx + 1);
  if (SORT_KEYS.includes(key) && (dir === "asc" || dir === "desc")) return { key, dir };
  return DEFAULT_SORT;
}

// First click on a header: text columns read naturally A→Z, while sizes,
// dates and counters are most useful biggest/newest first.
const FIRST_CLICK_DIR: Record<SortKey, SortDir> = {
  name: "asc", type: "asc", extension: "asc", uploader: "asc", region: "asc", origin: "asc",
  size: "desc", created: "desc", modified: "desc", taken: "desc", version: "desc", shares: "desc", comments: "desc",
};

export function toggleSort(current: SortSpec, key: SortKey): SortSpec {
  if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
  return { key, dir: FIRST_CLICK_DIR[key] };
}
