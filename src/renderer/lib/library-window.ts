/**
 * The photo/video/document library's row model - the pure half of LibraryGrid.
 *
 * The grid used to render every loaded item: 25 "Load 60 more" pages put 15,322
 * elements in the DOM and turned each further append into a 433 ms commit
 * (audit finding DSK-004). The fix is to virtualize, and virtualizing a grid of
 * uniform tiles inside month sections means flattening it to ROWS first: one
 * row per month header, then ceil(files / columns) rows of tiles under it.
 * `@tanstack/react-virtual` then mounts only the rows the viewport can see.
 *
 * Everything the grid needs to reason about off-screen items lives here, so it
 * can be tested without a renderer:
 *
 *  - `tileColumns` reproduces what CSS `auto-fill` picks, so a row holds
 *    exactly as many tiles as the grid is wide.
 *  - `buildLibraryRows` is the flattened model.
 *  - `rowOffsets` / `rowIndexAtOffset` turn a scroll position into a row and
 *    back, which is how the grid keeps the viewport anchored if rows ever leave
 *    the head of the feed.
 *  - `stickyHeaderIndex` names the month header to pin, so the sticky
 *    separators survive virtualization.
 *
 * No `@/` imports and no DOM here on purpose: `npm run test:unit` runs this
 * file's suite under plain `node --test`, which resolves neither path aliases
 * nor a browser. The month shape is declared structurally so `MonthGroup` from
 * library-request.ts is assignable without importing it.
 */

/** Structurally what `MonthGroup` is, for the parts the row model reads. */
export interface WindowMonth {
  key: string;
  files: { id: string }[];
}

/** One virtualized row: a month header, a strip of up to `columns` tiles, or load-more skeletons. */
export type LibraryRow =
  | { type: "header"; key: string; month: number }
  | { type: "items"; key: string; month: number; from: number; count: number }
  | { type: "skeletons"; key: string; count: number };

/** Row heights, in px. `itemH` is the tile/table-row height; `gap` is the vertical gutter under it. */
export interface RowMetrics {
  headerH: number;
  itemH: number;
  gap: number;
}

/**
 * How many tiles fit across, the way `grid-cols-[repeat(auto-fill,minmax(Npx,1fr))]`
 * counts them: n tiles need n*min + (n-1)*gap. Always at least one, so a window
 * narrower than a single tile still renders (the tile overflows, exactly as
 * auto-fill does today) instead of producing a zero-column model.
 */
export function tileColumns(width: number, minTile: number, gap: number): number {
  if (!Number.isFinite(width) || width <= 0) return 1;
  return Math.max(1, Math.floor((width + gap) / (minTile + gap)));
}

/**
 * Flatten the month groups into rows.
 *
 * An item row is keyed by its FIRST file's id, not by its offset in the month:
 * when items leave the head of a month every later row keeps its key, so React
 * reuses those subtrees instead of remounting the whole grid, and the grid can
 * still find the row the viewport was on.
 */
export function buildLibraryRows(
  months: readonly WindowMonth[],
  columns: number,
  skeletonCount = 0,
): LibraryRow[] {
  const cols = Math.max(1, Math.floor(columns) || 1);
  const rows: LibraryRow[] = [];
  for (let month = 0; month < months.length; month++) {
    const m = months[month];
    rows.push({ type: "header", key: `h:${m.key}`, month });
    for (let from = 0; from < m.files.length; from += cols) {
      rows.push({
        type: "items",
        key: `i:${m.files[from].id}`,
        month,
        from,
        count: Math.min(cols, m.files.length - from),
      });
    }
  }
  for (let i = 0, left = Math.max(0, Math.floor(skeletonCount)); left > 0; i++, left -= cols) {
    rows.push({ type: "skeletons", key: `sk:${i}`, count: Math.min(cols, left) });
  }
  return rows;
}

/** Cumulative row tops, `rows.length + 1` long - the last entry is the total height. */
export function rowOffsets(rows: readonly LibraryRow[], m: RowMetrics): number[] {
  const offsets = new Array<number>(rows.length + 1);
  let y = 0;
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y;
    y += rows[i].type === "header" ? m.headerH : m.itemH + m.gap;
  }
  offsets[rows.length] = y;
  return offsets;
}

/** The row under `offset`, clamped to the model. Binary search over `rowOffsets`. */
export function rowIndexAtOffset(offsets: readonly number[], offset: number): number {
  const last = offsets.length - 2; // offsets has one entry more than there are rows
  if (last < 0) return 0;
  if (!Number.isFinite(offset) || offset <= 0) return 0;
  if (offset >= offsets[last + 1]) return last;
  let lo = 0;
  let hi = last;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (offsets[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/**
 * The month header to pin at the top of the viewport: the last header at or
 * before the first visible row.
 *
 * -1 only when there is no header at or before `startIndex` - in practice an
 * empty model, since row 0 of a non-empty model is always a header. In
 * particular it is NOT -1 for a viewport showing only trailing skeletons: the
 * skeletons come after their month's header, so the backwards scan finds that
 * header and pins it, which is what the user should see.
 */
export function stickyHeaderIndex(rows: readonly LibraryRow[], startIndex: number): number {
  for (let i = Math.min(startIndex, rows.length - 1); i >= 0; i--) {
    if (rows[i].type === "header") return i;
  }
  return -1;
}
