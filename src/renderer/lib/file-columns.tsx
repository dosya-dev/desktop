// Ported from apps/web/src/lib/file-columns.tsx - keep in sync with the web copy.
/**
 * Table column definitions for the files list and the library table layout.
 *
 * Moved out of pages/FileBrowserPage.tsx so the library table can reuse the
 * same column set instead of redefining it: the folder listing's table and the
 * library's rows now render from one array, so a column added or relabelled in
 * one place cannot drift out of the other.
 *
 * The two row shapes live here too, because they are what a column renders and
 * both this module and the page need them.
 */
import type { ViewerFile } from "@/components/files/FileViewer";
import { formatBytes } from "@/lib/format";
import { timeAgo, extOf, originLabel, kindLabel, regionLabel } from "@/lib/file-type";
import { KIND_COPY, formatItemDate, type LibraryKind, type LibraryItem } from "@/lib/library-request";

export interface FolderRow {
  id: string;
  name: string;
  created_at: number;
  updated_at: number;
  file_count: number;
  lock_mode: string;
  is_hidden: number;
  /** Who `is_hidden` hides this from - "none" | "everyone" | "users" | "roles". */
  hidden_mode: string;
  is_synced: number;
  total_size_bytes: number;
  content_updated_at: number;
  region: string | null;
  uploader_name: string | null;
  share_count: number;
  comment_count: number;
  origin: string | null;
}

export interface FileRow extends ViewerFile {
  uploaded_by: string;
  is_synced: number;
}

// ── Table columns (web parity) ─────────────────────────────

/**
 * Every column in ALL_COLUMNS, plus the library-only `taken`. `taken` is never
 * in ALL_COLUMNS and never persisted (see `loadSavedColumns`): it exists only
 * in the set `libraryColumnsFor` builds, where the item carries a `taken_at`
 * for it to render.
 */
export type ColumnKey =
  | "name" | "size" | "created" | "modified" | "type" | "extension"
  | "version" | "uploader" | "region" | "origin" | "shares" | "comments"
  | "taken";

export interface ColumnDef {
  key: ColumnKey;
  label: string;
  defaultVisible: boolean;
  /** Fixed column width in px. Omitted only for `name`, which takes the rest. */
  width?: number;
  render: (f: FileRow) => React.ReactNode;
  renderFolder?: (f: FolderRow) => React.ReactNode;
}

/**
 * Widths are px, not Tailwind classes, because the table needs to add them up.
 *
 * Turning on every column used to crush twelve of them into whatever the window
 * was, wrapping MIME types over three lines and leaving the header unreadable.
 * The table now declares `min-width` = these widths + a floor for Name, so once
 * the columns no longer fit the container scrolls sideways instead of
 * compressing. See the colgroup in the table in FileBrowserPage.
 */
export const NAME_COL_MIN = 260;
export const CHECKBOX_COL = 32;
export const ACTIONS_COL = 40;

export const ALL_COLUMNS: ColumnDef[] = [
  { key: "name", label: "Name", defaultVisible: true, render: () => null /* handled separately */ },
  { key: "size", label: "Size", defaultVisible: true, width: 88, render: (f) => formatBytes(f.size_bytes), renderFolder: (f) => formatBytes(f.total_size_bytes ?? 0) },
  { key: "created", label: "Created", defaultVisible: true, width: 104, render: (f) => timeAgo(f.created_at), renderFolder: (f) => timeAgo(f.created_at) },
  { key: "modified", label: "Modified", defaultVisible: false, width: 104, render: (f) => timeAgo(f.updated_at), renderFolder: (f) => timeAgo(f.content_updated_at ?? f.created_at) },
  // The raw MIME type was unreadable at any column width
  // ("application/vnd.openxmlformats-officedocument.wordprocessingml.document").
  // A category rather than the extension, because Extension is its own column
  // and two columns reading "DOCX" would waste one of them. The full MIME type
  // is still on hover, via the title attribute that cell carries.
  { key: "type", label: "Type", defaultVisible: false, width: 96, render: (f) => kindLabel(f.name), renderFolder: () => "Folder" },
  { key: "extension", label: "Extension", defaultVisible: false, width: 88, render: (f) => (f.extension || extOf(f.name) || "-").toUpperCase() },
  { key: "version", label: "Version", defaultVisible: false, width: 80, render: (f) => (f.current_version ?? 1) > 1 ? `v${f.current_version}` : "-" },
  { key: "uploader", label: "Uploader", defaultVisible: false, width: 120, render: (f) => f.uploader_name ?? "-", renderFolder: (f) => f.uploader_name ?? "-" },
  // regionLabel already existed and turns "ap-southeast-2" into "Sydney" - the
  // raw code was both wider and less useful.
  { key: "region", label: "Region", defaultVisible: true, width: 112, render: (f) => f.region ? regionLabel(f.region) : "-", renderFolder: (f) => f.region ? regionLabel(f.region) : "-" },
  { key: "origin", label: "Origin", defaultVisible: true, width: 88, render: (f) => originLabel(f.origin), renderFolder: (f) => originLabel(f.origin) },
  { key: "shares", label: "Shares", defaultVisible: false, width: 72, render: (f) => f.share_count > 0 ? String(f.share_count) : "-", renderFolder: (f) => f.share_count > 0 ? String(f.share_count) : "-" },
  { key: "comments", label: "Comments", defaultVisible: false, width: 88, render: (f) => f.comment_count > 0 ? String(f.comment_count) : "-", renderFolder: (f) => f.comment_count > 0 ? String(f.comment_count) : "-" },
];

export const DEFAULT_VISIBLE: Set<ColumnKey> = new Set(ALL_COLUMNS.filter((c) => c.defaultVisible).map((c) => c.key));

export const TABLE_COLUMNS_KEY = "dosya_table_columns";

export function loadSavedColumns(): Set<ColumnKey> {
  try {
    const saved = localStorage.getItem(TABLE_COLUMNS_KEY);
    if (!saved) return new Set(DEFAULT_VISIBLE);
    const parsed: unknown = JSON.parse(saved);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_VISIBLE);
    // The cast this used to do was a lie: localStorage is user-writable and
    // outlives any column rename, so an unknown key silently produced a table
    // whose headers and cells disagreed. Keep only keys that still exist, and
    // fall back rather than render an empty table. This is also what keeps
    // `taken` out of the picker's set: it is not in ALL_COLUMNS, so even a
    // hand-edited value cannot smuggle it into the folder listing's table.
    const known = new Set<string>(ALL_COLUMNS.map((c) => c.key));
    const valid = parsed.filter((k): k is ColumnKey => typeof k === "string" && known.has(k));
    // Name is not optional - a table without it is just a table of dates and
    // sizes with no way to tell the rows apart - so it rides along with
    // whatever the user actually saved, valid or not.
    return valid.length > 0 ? new Set<ColumnKey>(["name", ...valid]) : new Set(DEFAULT_VISIBLE);
  } catch {}
  return new Set(DEFAULT_VISIBLE);
}

/**
 * The library table layout: ALL_COLUMNS plus a library-only `taken` column,
 * labelled per kind ("Date taken" for photos, "Date created" for videos and
 * documents - mirrors KIND_COPY's primaryDateLabel) and rendering
 * LibraryItem.taken_at.
 *
 * The library feed's `created_at` is COALESCE(source_created_at, created_at)
 * (display-time.ts), and `taken_at` resolves through the same expression for
 * videos and documents - so for those two kinds `created` and `taken` are
 * byte-equal, and showing both would be two columns naming the same value
 * twice, one of them mislabelled ("Created" reading as upload time when it
 * is not). `created` is dropped for videos and documents, with `taken` in
 * its place. Photos differ: `taken_at` there prefers EXIF over the source
 * date, so the two genuinely disagree - `created` stays, and `taken` is
 * inserted right after it.
 */
export function libraryColumnsFor(kind: LibraryKind): ColumnDef[] {
  const takenColumn: ColumnDef = {
    key: "taken",
    label: KIND_COPY[kind].primaryDateLabel,
    defaultVisible: true,
    width: 104,
    render: (f) => formatItemDate((f as LibraryItem).taken_at),
  };
  const columns = [...ALL_COLUMNS];
  const createdIdx = columns.findIndex((c) => c.key === "created");
  if (kind === "photos") {
    columns.splice(createdIdx + 1, 0, takenColumn);
  } else {
    // Videos and documents: `taken` takes `created`'s slot outright.
    columns.splice(createdIdx, 1, takenColumn);
  }
  return columns;
}
