// Ported from apps/web/src/lib/library-request.ts - keep in sync with the web copy.
// No `@/` imports here on purpose: `npm run test:unit` runs this file under
// plain `node --test`, which cannot resolve path aliases.

export const LIBRARY_PAGE_SIZE = 60;
export const LIBRARY_QUERY_ROOT = "library";

export type LibraryKind = "photos" | "videos" | "documents";
export type LibrarySort = "taken_desc" | "taken_asc" | "uploaded_desc";

/** The sidebar's type filters that open the library; every other filter is the folder listing. */
export function kindForFilter(filter: string): LibraryKind | null {
  if (filter === "images") return "photos";
  if (filter === "videos") return "videos";
  if (filter === "documents") return "documents";
  return null;
}

export const KIND_COPY: Record<LibraryKind, {
  title: string; noun: string; nounPlural: string; searchPlaceholder: string; emptyTitle: string; emptyDescription: string; primaryDateLabel: string;
}> = {
  photos: { title: "Photos", noun: "photo", nounPlural: "photos", searchPlaceholder: "Search photos...", emptyTitle: "No photos yet", emptyDescription: "Photos you upload or sync to any folder will show up here, by month.", primaryDateLabel: "Date taken" },
  videos: { title: "Videos", noun: "video", nounPlural: "videos", searchPlaceholder: "Search videos...", emptyTitle: "No videos yet", emptyDescription: "Videos you upload or sync to any folder will show up here, by month.", primaryDateLabel: "Date created" },
  documents: { title: "Documents", noun: "document", nounPlural: "documents", searchPlaceholder: "Search documents...", emptyTitle: "No documents yet", emptyDescription: "Documents you upload or sync to any folder will show up here, by month.", primaryDateLabel: "Date created" },
};

/** The wire sort values are the same for every kind; only the label of the primary date differs. */
export function sortOptionsFor(kind: LibraryKind): { value: LibrarySort; label: string }[] {
  const d = KIND_COPY[kind].primaryDateLabel;
  return [
    { value: "taken_desc", label: `${d} · newest` },
    { value: "taken_asc", label: `${d} · oldest` },
    { value: "uploaded_desc", label: "Date uploaded · newest" },
  ];
}

export function plural(kind: LibraryKind, n: number): string {
  const c = KIND_COPY[kind];
  return `${n.toLocaleString()} ${n === 1 ? c.noun : c.nounPlural}`;
}

/** A /api/files row plus what the library feed adds. Structurally assignable to FileBrowserPage's FileRow. */
export interface LibraryItem {
  id: string;
  name: string;
  size_bytes: number;
  mime_type: string;
  extension: string | null;
  region: string;
  created_at: number;
  updated_at: number;
  current_version: number;
  lock_mode: string;
  is_hidden: number;
  hidden_mode?: string;
  uploaded_by: string;
  uploader_name: string | null;
  share_count: number;
  comment_count: number;
  is_synced: number;
  origin?: string | null;
  folder_id: string | null;
  /** Effective date, unix seconds: photos EXIF → source date → upload; videos and documents source date → upload. */
  taken_at: number;
}

export interface LibraryPage {
  ok: boolean;
  kind?: LibraryKind;
  months: { key: string; label: string; files: LibraryItem[] }[];
  next_cursor: string | null;
  counts?: Record<string, number>;
  total?: number;
  can_lock?: boolean;
  can_hide?: boolean;
}

export interface LibraryView {
  workspaceId: string;
  kind: LibraryKind;
  sort: LibrarySort;
  q: string;
}

export function libraryQueryKey(view: LibraryView) {
  return [LIBRARY_QUERY_ROOT, view.workspaceId, view.kind, view.sort, view.q] as const;
}

export function libraryRequestPath(view: LibraryView, cursor: string | null): string {
  const params = new URLSearchParams({
    workspace_id: view.workspaceId,
    kind: view.kind,
    limit: String(LIBRARY_PAGE_SIZE),
    sort: view.sort,
  });
  if (view.q) params.set("q", view.q);
  if (cursor) params.set("cursor", cursor);
  return `/api/library?${params}`;
}

export interface MonthGroup {
  key: string;
  label: string;
  count: number;
  files: LibraryItem[];
}

export interface Library {
  months: MonthGroup[];
  files: LibraryItem[];
  total: number;
  loaded: number;
  hasMore: boolean;
  canLock: boolean;
  canHide: boolean;
}

export function mergeLibraryPages(pages: LibraryPage[]): Library {
  const first = pages[0];
  const counts = first?.counts ?? {};
  const months: MonthGroup[] = [];
  const files: LibraryItem[] = [];
  const seen = new Set<string>();
  for (const page of pages) {
    for (const m of page.months) {
      const fresh = m.files.filter((f) => !seen.has(f.id));
      for (const f of fresh) seen.add(f.id);
      const last = months[months.length - 1];
      if (last && last.key === m.key) last.files.push(...fresh);
      else months.push({ key: m.key, label: m.label, count: counts[m.key] ?? m.files.length, files: [...fresh] });
      files.push(...fresh);
    }
  }
  const lastPage = pages[pages.length - 1];
  return {
    months, files,
    total: first?.total ?? 0,
    loaded: files.length,
    hasMore: !!lastPage && lastPage.next_cursor != null,
    canLock: first?.can_lock ?? false,
    canHide: first?.can_hide ?? false,
  };
}

/** "Jun 15, 2024" - the hover caption under a tile. */
export function formatItemDate(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
}

// ── Per-kind layout preference (grid vs. table) ─────────────

export type LibraryLayout = "grid" | "list";

export const LIBRARY_LAYOUT_KEY = "dosya_library_layout";

const LIBRARY_KINDS: LibraryKind[] = ["photos", "videos", "documents"];

/** Documents read better as a table from the first visit; photos and videos as a grid. */
export function defaultLayoutFor(kind: LibraryKind): LibraryLayout {
  return kind === "documents" ? "list" : "grid";
}

function defaultLayouts(): Record<LibraryKind, LibraryLayout> {
  return {
    photos: defaultLayoutFor("photos"),
    videos: defaultLayoutFor("videos"),
    documents: defaultLayoutFor("documents"),
  };
}

export function loadLibraryLayouts(): Record<LibraryKind, LibraryLayout> {
  const defaults = defaultLayouts();
  try {
    const saved = localStorage.getItem(LIBRARY_LAYOUT_KEY);
    if (!saved) return defaults;
    const parsed: unknown = JSON.parse(saved);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return defaults;
    const merged = { ...defaults };
    const record = parsed as Record<string, unknown>;
    for (const kind of LIBRARY_KINDS) {
      const value = record[kind];
      if (value === "grid" || value === "list") merged[kind] = value;
    }
    return merged;
  } catch {
    return defaults;
  }
}

export function saveLibraryLayout(kind: LibraryKind, layout: LibraryLayout): void {
  const current = loadLibraryLayouts();
  current[kind] = layout;
  try {
    localStorage.setItem(LIBRARY_LAYOUT_KEY, JSON.stringify(current));
  } catch {
    // Private windows, a full storage quota, or a locked-down environment
    // can all make this throw. The caller's in-memory UI state has already
    // moved on, so losing the persisted preference is fine - crashing the
    // page over it is not.
  }
}
