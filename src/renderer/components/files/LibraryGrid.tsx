// Ported from apps/web/src/components/library/library-view.tsx - keep in sync with the web copy.
// Restyled to the desktop's --color-* tokens; the native checkbox matches FileBrowserPage's cards.
//
// Serves photos, videos and documents - one component, kind and layout picked
// at the call site. Presentational: selection, favourites, the viewer, the
// context menu and every mutation belong to FileBrowserPage, so the bulk bar
// and modals the folder listing already has keep working unchanged in library
// mode.
//
// Two layouts, every kind: `grid` draws the kind's tile (square photos, 16:9
// video cards, square document plates), `list` draws one row per item from the
// shared column definitions, under a single table header. The columns come from
// the caller (`libraryColumnsFor(kind)`) so the library table and the folder
// listing's table never drift apart.
import type { MouseEvent as ReactMouseEvent, KeyboardEvent as ReactKeyboardEvent } from "react";
import { Image as ImageIcon, Lock, Search, Star, Upload, AlertCircle, RefreshCw, Loader2, Play, FileText } from "lucide-react";
import { FilePreviewImage } from "@/components/files/FilePreviewImage";
import { FileIcon } from "@/components/files/FileIcon";
import { extOf, colorFor, humanSize } from "@/lib/file-type";
import { NAME_COL_MIN, type ColumnDef } from "@/lib/file-columns";
import { formatItemDate, LIBRARY_PAGE_SIZE, KIND_COPY, plural, type MonthGroup, type LibraryItem, type LibraryKind, type LibraryLayout } from "@/lib/library-request";

export type TileSize = "small" | "large";

export interface LibraryGridProps {
  kind: LibraryKind;
  months: MonthGroup[];
  total: number;
  loaded: number;
  hasMore: boolean;
  isLoading: boolean;
  isLoadingMore: boolean;
  error: string | null;
  search: string;
  selected: Set<string>;
  favourites: Set<string>;
  unlockedFiles: Map<string, string>;
  activeId: string | null;
  tileSize: TileSize;
  /** Tiles or a table. */
  layout: LibraryLayout;
  /** The active table columns for the list layout, name first, `taken` included - from `libraryColumnsFor(kind)`. */
  columns: ColumnDef[];
  onLoadMore: () => void;
  onRetry: () => void;
  onUploadClick: () => void;
  onOpen: (file: LibraryItem) => void;
  onToggleSelect: (id: string) => void;
  onSelectMany: (ids: string[]) => void;
  onFavourite: (id: string) => void;
  onContextMenu: (e: ReactMouseEvent, file: LibraryItem) => void;
}

const GRID = {
  photos: { small: "grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(148px,1fr))]", large: "grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(228px,1fr))]" },
  videos: { small: "grid gap-2 grid-cols-[repeat(auto-fill,minmax(220px,1fr))]", large: "grid gap-2 grid-cols-[repeat(auto-fill,minmax(320px,1fr))]" },
  documents: { small: "grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(148px,1fr))]", large: "grid gap-1.5 grid-cols-[repeat(auto-fill,minmax(228px,1fr))]" },
} as const;

/** Every kind stacks the same way in the table layout. */
const LIST = "flex flex-col gap-0.5";

/** The kind's mark - the empty state's icon here, and the files page's stand-in for the breadcrumb. */
export const KIND_ICON = { photos: ImageIcon, videos: Play, documents: FileText } as const;

// The placeholder has to match the shape it stands in for, or the grid jumps
// when the real items land: square tiles for photos and documents, 16:9 cards
// for videos, and a uniform row for every kind in the table layout.
const SKELETON = { photos: "aspect-square rounded-lg", videos: "aspect-video rounded-lg", documents: "aspect-square rounded-lg" } as const;
const LIST_SKELETON = "h-10 rounded-lg";

const btn = "inline-flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs hover:bg-[var(--color-bg-secondary)] disabled:opacity-50";

export function LibraryGrid(props: LibraryGridProps) {
  const {
    kind, months, total, loaded, hasMore, isLoading, isLoadingMore, error, search,
    selected, favourites, unlockedFiles, activeId, tileSize, layout, columns,
    onLoadMore, onRetry, onUploadClick, onOpen, onToggleSelect, onSelectMany, onFavourite, onContextMenu,
  } = props;
  const copy = KIND_COPY[kind];
  const list = layout === "list";
  const bodyClass = list ? LIST : GRID[kind][tileSize];
  const skeletonClass = `animate-pulse bg-[var(--color-bg-tertiary)] ${list ? LIST_SKELETON : SKELETON[kind]}`;
  const EmptyIcon = KIND_ICON[kind];
  const anySelected = selected.size > 0;

  if (error && months.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        <AlertCircle size={40} className="mb-4 text-[var(--color-danger)] opacity-50" />
        <p className="mb-1 text-sm font-medium">Could not load your {copy.nounPlural}</p>
        <p className="mb-3 max-w-80 text-xs text-[var(--color-text-muted)]">{error}</p>
        <button className={btn} style={{ borderColor: "var(--color-border)" }} onClick={onRetry}><RefreshCw size={12} /> Try again</button>
      </div>
    );
  }

  if (isLoading && months.length === 0) {
    return (
      <div className={bodyClass} aria-busy="true">
        {Array.from({ length: 18 }, (_, i) => <div key={i} className={skeletonClass} />)}
      </div>
    );
  }

  if (months.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-20 text-center">
        {search ? <Search size={40} className="mb-4 text-[var(--color-text-muted)] opacity-40" /> : <EmptyIcon size={40} className="mb-4 text-[var(--color-text-muted)] opacity-40" />}
        <p className="mb-1 text-sm font-medium">{search ? `No ${copy.nounPlural} match "${search}"` : copy.emptyTitle}</p>
        <p className="mb-4 max-w-80 text-xs text-[var(--color-text-muted)]">
          {search ? `Try a different name, or clear the search to see every ${copy.noun}.` : copy.emptyDescription}
        </p>
        {!search && (
          <button className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--color-primary)] px-3 py-1.5 text-xs text-[var(--color-primary-fg)]" onClick={onUploadClick}>
            <Upload size={12} /> Upload {copy.nounPlural}
          </button>
        )}
      </div>
    );
  }

  const remaining = Math.max(0, total - loaded);
  const pct = total > 0 ? Math.max(2, Math.round((loaded / total) * 100)) : 100;

  // List layout only: what the header and each month's rows need before they
  // start scrolling instead of shrinking - the checkbox slot (16px), the
  // thumbnail slot (28px), Name's floor, the columns' own px widths, and the
  // gap-3 (12px) gutter between every one of those slots. Mirrors
  // FileBrowserPage's tableMinWidth for the All-mode table, so a row and its
  // hover/selected background never stop short of the cells it holds.
  const listMinWidth = 16 + 28 + NAME_COL_MIN +
    columns.filter((c) => c.key !== "name").reduce((n, c) => n + (c.width ?? 0), 0) +
    12 * (columns.length + 1);

  return (
    <div data-testid="library-grid">
      {/* One table header for the whole listing, above the first month. It is a
          plain div, not role="row": there is no table/grid/rowgroup around it,
          and an orphan row role is invalid ARIA. The columns are not sort
          buttons either - the library sorts by the toolbar's sort menu
          (taken/uploaded), not by an arbitrary column. */}
      {list && columns.length > 0 && (
        <div
          data-testid="library-table-header"
          title="Rows follow the sort menu's date order"
          className="mb-0.5 flex items-center gap-3 border-b px-3 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
          style={{ borderColor: "var(--color-border)", minWidth: listMinWidth }}
        >
          {/* The row's two leading slots, to the pixel: the checkbox (16px) and
              the thumbnail (28px). A 28px checkbox slot would push every label
              12px right of the cell it names. */}
          <div className="w-4 shrink-0" />
          <div className="w-7 shrink-0" />
          {columns.map((col) => col.key === "name" ? (
            <div key="name" className="flex-1 truncate" style={{ minWidth: NAME_COL_MIN }}>{col.label}</div>
          ) : (
            <div key={col.key} className="shrink-0 truncate" style={{ width: col.width }}>{col.label}</div>
          ))}
        </div>
      )}
      {months.map((m, mi) => {
        const selectable = m.files.filter((f) => f.lock_mode !== "full_lock" || unlockedFiles.has(f.id)).map((f) => f.id);
        const partial = m.files.length < m.count;
        const isLast = mi === months.length - 1;
        return (
          <section key={m.key} className="group/month" data-month={m.key}>
            <div className="sticky top-0 z-10 flex items-baseline gap-2.5 pb-2.5 pt-4 backdrop-blur-md" style={{ background: "color-mix(in oklab, var(--color-bg) 90%, transparent)" }}>
              <h3 className="text-[15px] font-semibold tracking-tight">{m.label}</h3>
              <span className="text-xs tabular-nums text-[var(--color-text-muted)]">{plural(kind, m.count)}</span>
              {partial && <span className="text-[11px] tabular-nums text-[var(--color-text-muted)]">· {m.files.length} loaded</span>}
              <button
                type="button"
                className="ml-auto rounded px-1.5 py-0.5 text-[11px] text-[var(--color-text-muted)] opacity-0 transition-opacity hover:bg-[var(--color-bg-tertiary)] hover:text-[var(--color-text)] focus-visible:opacity-100 group-hover/month:opacity-100"
                onClick={() => onSelectMany(selectable)}
              >
                {partial ? `Select ${selectable.length} loaded` : "Select all"}
              </button>
            </div>
            <div className={bodyClass} style={list ? { minWidth: listMinWidth } : undefined}>
              {m.files.map((f) => {
                // Every item, tile or row, gets the same wiring - only the
                // shape differs. The row has no favourite button (the star in
                // the name cell is an indicator), so onFavourite is tile-only.
                const item = {
                  file: f,
                  selected: selected.has(f.id),
                  anySelected,
                  active: activeId === f.id,
                  isFavourite: favourites.has(f.id),
                  unlockToken: unlockedFiles.get(f.id) ?? null,
                  onOpen: () => onOpen(f),
                  onToggle: () => onToggleSelect(f.id),
                  onContextMenu: (e: ReactMouseEvent) => onContextMenu(e, f),
                };
                if (list) return <LibraryListRow key={f.id} kind={kind} columns={columns} {...item} />;
                const tile = { ...item, onFavourite: () => onFavourite(f.id) };
                if (kind === "photos") return <PhotoTile key={f.id} {...tile} />;
                if (kind === "videos") return <VideoCard key={f.id} {...tile} />;
                return <DocumentTile key={f.id} {...tile} />;
              })}
              {isLast && isLoadingMore && Array.from({ length: Math.min(LIBRARY_PAGE_SIZE, remaining) || 6 }, (_, i) => (
                <div key={`sk-${i}`} className={skeletonClass} />
              ))}
            </div>
          </section>
        );
      })}

      <div className="flex flex-col items-center gap-2.5 pb-2 pt-8">
        {hasMore ? (
          <>
            <span className="text-xs tabular-nums text-[var(--color-text-muted)]">Showing {loaded.toLocaleString()} of {plural(kind, total)}</span>
            <div className="h-[3px] w-[200px] overflow-hidden rounded-full bg-[var(--color-bg-tertiary)]" aria-hidden="true">
              <div className="h-full bg-[var(--color-primary)] transition-[width] duration-300" style={{ width: `${pct}%` }} />
            </div>
            <button className={btn} style={{ borderColor: "var(--color-border)" }} disabled={isLoadingMore} onClick={onLoadMore}>
              {isLoadingMore ? <><Loader2 size={12} className="animate-spin" /> Loading</> : `Load ${Math.min(LIBRARY_PAGE_SIZE, remaining)} more`}
            </button>
          </>
        ) : (
          <span className="text-xs text-[var(--color-text-muted)]">That's all {plural(kind, loaded)}.</span>
        )}
      </div>
    </div>
  );
}

type TileProps = {
  file: LibraryItem; selected: boolean; anySelected: boolean; active: boolean; isFavourite: boolean; unlockToken: string | null;
  onOpen: () => void; onToggle: () => void; onFavourite: () => void; onContextMenu: (e: ReactMouseEvent) => void;
};

/** A table row shows the favourite as a star in the name cell, so it has no favourite button. */
type RowProps = Omit<TileProps, "onFavourite"> & { kind: LibraryKind; columns: ColumnDef[] };

function PhotoTile({ file, selected, anySelected, active, isFavourite, unlockToken, onOpen, onToggle, onFavourite, onContextMenu }: TileProps) {
  const locked = file.lock_mode === "full_lock" && !unlockToken;
  const ext = extOf(file.name).toUpperCase() || "FILE";
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onOpen(); }
    if (e.key === " " && !locked) { e.preventDefault(); onToggle(); }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={file.name}
      data-testid={`photo-${file.id}`}
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
        selected ? "ring-2 ring-inset ring-[var(--color-primary)]" : active ? "ring-2 ring-green-500" : "ring-1 ring-black/10"
      }`}
      onClick={(e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey || (anySelected && !locked)) onToggle(); else onOpen(); }}
      onKeyDown={onKey}
      onContextMenu={onContextMenu}
    >
      <div className={`absolute inset-0 transition-transform duration-200 ease-out ${selected ? "scale-[.88] overflow-hidden rounded-md" : "group-hover:scale-[1.03]"}`}>
        {locked ? (
          <div className="flex h-full w-full items-center justify-center bg-neutral-900 text-white/70"><Lock size={20} /></div>
        ) : (
          <FilePreviewImage
            fileId={file.id}
            fileName={file.name}
            version={file.current_version}
            query={unlockToken ? `ut=${unlockToken}` : undefined}
            size={256}
            className="h-full w-full object-cover"
            fallback={
              <div className="flex h-full w-full items-center justify-center" style={{ background: `linear-gradient(135deg, ${colorFor(file.name)}22, #0a0a0a)` }}>
                <span className="font-mono text-sm font-bold uppercase tracking-widest" style={{ color: colorFor(file.name) }}>{ext}</span>
              </div>
            }
          />
        )}
      </div>

      {!locked && (
        <input
          type="checkbox"
          aria-label={`Select ${file.name}`}
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className={`absolute left-2 top-2 z-20 h-4 w-4 accent-[var(--color-primary)] transition-opacity ${selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        />
      )}

      <button
        type="button"
        title={isFavourite ? "Remove from favourites" : "Add to favourites"}
        className={`absolute right-2 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-opacity hover:bg-black/55 ${isFavourite ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        onClick={(e) => { e.stopPropagation(); onFavourite(); }}
      >
        <Star size={14} className={isFavourite ? "fill-orange-400 text-orange-400" : "text-white"} />
      </button>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 bg-gradient-to-t from-black/75 to-transparent px-2 pb-1.5 pt-5 text-white opacity-0 transition-opacity group-hover:opacity-100">
        <p className="truncate text-[11px] font-medium leading-tight">{file.name}</p>
        <p className="text-[10px] tabular-nums opacity-80">{formatItemDate(file.taken_at)}</p>
      </div>
    </div>
  );
}

// No poster in this pass, so the card is a tinted 16:9 plate: a centred play
// mark (a lock, when the file is locked), the format top-right, and the name
// and size always on - there is nothing to reveal on hover.
function VideoCard({ file, selected, anySelected, active, isFavourite, unlockToken, onOpen, onToggle, onFavourite, onContextMenu }: TileProps) {
  const locked = file.lock_mode === "full_lock" && !unlockToken;
  const ext = extOf(file.name).toUpperCase() || "VIDEO";
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onOpen(); }
    if (e.key === " " && !locked) { e.preventDefault(); onToggle(); }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={file.name}
      data-testid={`video-${file.id}`}
      data-kind="video"
      className={`group relative aspect-video cursor-pointer overflow-hidden rounded-lg text-white outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
        selected ? "ring-2 ring-inset ring-[var(--color-primary)]" : active ? "ring-2 ring-green-500" : "ring-1 ring-black/5 dark:ring-white/10"
      }`}
      style={{ background: `linear-gradient(135deg, ${colorFor(file.name)}55, #0a0a0a)` }}
      onClick={(e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey || (anySelected && !locked)) onToggle(); else onOpen(); }}
      onKeyDown={onKey}
      onContextMenu={onContextMenu}
    >
      <span
        className="absolute left-1/2 top-1/2 flex h-10 w-10 -translate-x-1/2 -translate-y-1/2 items-center justify-center rounded-full bg-black/45 backdrop-blur-sm"
        data-testid={locked ? "lock" : "play"}
      >
        {locked ? <Lock size={16} /> : <Play size={16} className="ml-0.5 fill-white" />}
      </span>
      <span className="absolute right-2 top-2 z-10 rounded-full bg-black/45 px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider backdrop-blur-sm">{ext}</span>
      {!locked && (
        <input
          type="checkbox"
          aria-label={`Select ${file.name}`}
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className={`absolute left-2 top-2 z-20 h-4 w-4 accent-[var(--color-primary)] transition-opacity ${selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        />
      )}
      <button
        type="button"
        title={isFavourite ? "Remove from favourites" : "Add to favourites"}
        aria-label={isFavourite ? "Remove from favourites" : "Add to favourites"}
        className={`absolute right-14 top-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-black/35 backdrop-blur-sm transition-opacity hover:bg-black/55 ${isFavourite ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        onClick={(e) => { e.stopPropagation(); onFavourite(); }}
      >
        <Star size={14} className={isFavourite ? "fill-orange-400 text-orange-400" : "text-white"} />
      </button>
      <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-2.5 pb-2 pt-6">
        <p className="truncate text-[12px] font-medium leading-tight">{file.name}</p>
        <p className="text-[10px] tabular-nums opacity-80">{humanSize(file.size_bytes)} · {formatItemDate(file.taken_at)}</p>
      </div>
    </div>
  );
}

/**
 * A document in the grid layout: the same square plate as a photo, with the
 * format's icon instead of a thumbnail. Selection, ring states, keyboard and
 * context menu behave exactly as a VideoCard.
 */
function DocumentTile({ file, selected, anySelected, active, isFavourite, unlockToken, onOpen, onToggle, onFavourite, onContextMenu }: TileProps) {
  const locked = file.lock_mode === "full_lock" && !unlockToken;
  const ext = extOf(file.name).toUpperCase() || "FILE";
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onOpen(); }
    if (e.key === " " && !locked) { e.preventDefault(); onToggle(); }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={file.name}
      data-testid={`document-${file.id}`}
      data-kind="document"
      className={`group relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-[var(--color-bg-tertiary)] text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
        selected ? "ring-2 ring-inset ring-[var(--color-primary)]" : active ? "ring-2 ring-green-500" : "ring-1 ring-black/5 dark:ring-white/10"
      }`}
      onClick={(e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey || (anySelected && !locked)) onToggle(); else onOpen(); }}
      onKeyDown={onKey}
      onContextMenu={onContextMenu}
    >
      <div className="absolute inset-0 flex items-center justify-center">
        <FileIcon name={file.name} size={48} />
      </div>
      {!locked && (
        <input
          type="checkbox"
          aria-label={`Select ${file.name}`}
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className={`absolute left-2 top-2 z-20 h-4 w-4 accent-[var(--color-primary)] transition-opacity ${selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        />
      )}
      <div className="absolute right-2 top-2 z-10 flex items-center gap-1">
        {locked && (
          <span className="flex h-5 w-5 items-center justify-center rounded bg-[var(--color-bg)]/80 text-[var(--color-text-muted)]" data-testid="lock">
            <Lock size={12} />
          </span>
        )}
        <span className="rounded bg-[var(--color-bg)]/80 px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase text-[var(--color-text-muted)]">{ext}</span>
      </div>
      <button
        type="button"
        title={isFavourite ? "Remove from favourites" : "Add to favourites"}
        aria-label={isFavourite ? "Remove from favourites" : "Add to favourites"}
        className={`absolute bottom-11 right-2 z-20 flex h-6 w-6 items-center justify-center rounded-full bg-[var(--color-bg)]/80 backdrop-blur-sm transition-opacity hover:bg-[var(--color-bg)] ${isFavourite ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        onClick={(e) => { e.stopPropagation(); onFavourite(); }}
      >
        <Star size={14} className={isFavourite ? "fill-orange-400 text-orange-400" : "text-[var(--color-text-muted)]"} />
      </button>
      <div className="absolute inset-x-0 bottom-0 bg-[var(--color-bg)]/85 px-2 py-1.5 backdrop-blur-sm">
        <p className="truncate text-xs font-medium">{file.name}</p>
        <p className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{humanSize(file.size_bytes)} · {formatItemDate(file.taken_at)}</p>
      </div>
    </div>
  );
}

/**
 * One item in the table layout, for every kind. The cells come from the
 * caller's column defs (`libraryColumnsFor(kind)`), so this row and the folder
 * listing's table always show the same columns at the same widths - only the
 * name cell and the thumbnail are the library's own.
 *
 * A locked item never gets a thumbnail request: the preview endpoint would
 * refuse it, and the format icon is the honest stand-in. The lock rides in the
 * name cell, and the checkbox slot stays an empty spacer so the columns still
 * line up with the header.
 */
function LibraryListRow({ file, kind, columns, selected, anySelected, active, isFavourite, unlockToken, onOpen, onToggle, onContextMenu }: RowProps) {
  const locked = file.lock_mode === "full_lock" && !unlockToken;
  const icon = <FileIcon name={file.name} size={28} />;
  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === "Enter") { e.preventDefault(); onOpen(); }
    if (e.key === " " && !locked) { e.preventDefault(); onToggle(); }
  };
  return (
    <div
      role="button"
      tabIndex={0}
      aria-label={file.name}
      data-testid={`library-row-${file.id}`}
      data-kind={KIND_COPY[kind].noun}
      className={`group flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2 text-[var(--color-text)] outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-primary)] ${
        selected ? "bg-[var(--color-primary)]/10" : active ? "ring-2 ring-inset ring-green-500" : "hover:bg-[var(--color-bg-secondary)]"
      }`}
      onClick={(e) => { e.stopPropagation(); if (e.ctrlKey || e.metaKey || (anySelected && !locked)) onToggle(); else onOpen(); }}
      onKeyDown={onKey}
      onContextMenu={onContextMenu}
    >
      {locked ? (
        <span className="h-4 w-4 shrink-0" />
      ) : (
        <input
          type="checkbox"
          aria-label={`Select ${file.name}`}
          checked={selected}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className={`h-4 w-4 shrink-0 accent-[var(--color-primary)] transition-opacity ${selected || anySelected ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
        />
      )}
      <div className="h-7 w-7 shrink-0">
        {kind === "documents" || locked ? icon : (
          <FilePreviewImage
            fileId={file.id}
            fileName={file.name}
            version={file.current_version}
            query={unlockToken ? `ut=${unlockToken}` : undefined}
            size={128}
            className="h-7 w-7 rounded bg-[var(--color-bg-tertiary)] object-cover"
            fallback={icon}
          />
        )}
      </div>
      {columns.map((col) => col.key === "name" ? (
        <div key="name" className="flex flex-1 items-center gap-2" style={{ minWidth: NAME_COL_MIN }}>
          <span className="truncate text-sm font-medium">{file.name}</span>
          {locked && <Lock size={12} className="shrink-0 text-[var(--color-text-muted)]" />}
          {isFavourite && <Star size={12} className="shrink-0 fill-orange-400 text-orange-400" />}
        </div>
      ) : (
        <div key={col.key} className="shrink-0 truncate text-xs tabular-nums text-[var(--color-text-muted)]" style={{ width: col.width }}>{col.render(file)}</div>
      ))}
    </div>
  );
}
