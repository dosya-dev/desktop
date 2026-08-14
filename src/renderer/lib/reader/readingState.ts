/**
 * Per-book reading state: where you were, and what you bookmarked.
 *
 * The shape is deliberately identical to apps/mobile/src/reader/readingState.ts
 * so the two readers mean the same thing by a bookmark. Storage is NOT shared:
 * mobile writes a file in its own sandbox and this writes localStorage, because
 * no server-side reading-state endpoint exists. Positions and bookmarks are
 * therefore per-device on both platforms - the same limitation, not a new one.
 */
export interface Bookmark {
  id: string;
  location: string;
  label: string;
  createdAt: string;
}

export interface ReadingState {
  version: 1;
  location: string | null;
  percent: number;
  bookmarks: Bookmark[];
}

export const EMPTY_STATE: ReadingState = { version: 1, location: null, percent: 0, bookmarks: [] };

/** Debounce for position writes. Matches mobile's saver. */
export const SAVE_DEBOUNCE_MS = 2000;

const keyFor = (fileId: string) => `dosya.reader.${fileId}`;

function isReadingState(s: unknown): s is ReadingState {
  if (!s || typeof s !== "object") return false;
  const c = s as ReadingState;
  return c.version === 1 && Array.isArray(c.bookmarks) && typeof c.percent === "number";
}

export function loadReadingState(fileId: string): ReadingState {
  try {
    const raw = localStorage.getItem(keyFor(fileId));
    if (!raw) return EMPTY_STATE;
    const parsed: unknown = JSON.parse(raw);
    // A shape we do not recognise is treated as absent rather than repaired: a
    // half-understood state would put the reader at a position it cannot trust.
    return isReadingState(parsed) ? parsed : EMPTY_STATE;
  } catch {
    return EMPTY_STATE;
  }
}

export function saveReadingState(fileId: string, state: ReadingState): void {
  try {
    localStorage.setItem(keyFor(fileId), JSON.stringify(state));
  } catch {
    // A full or unavailable quota must not take the reader down with it - losing
    // a bookmark is bad, being unable to read the book is worse.
  }
}

/**
 * Read-modify-write, so the debounced position flush and a bookmark toggle
 * cannot clobber each other.
 *
 * Mobile needs a real per-file queue because its writes are async file IO. Here
 * localStorage is synchronous, so read-modify-write in one turn is already
 * atomic with respect to other code in this renderer.
 */
export function updateReadingState(
  fileId: string,
  mutate: (prev: ReadingState) => ReadingState,
): ReadingState {
  const next = mutate(loadReadingState(fileId));
  saveReadingState(fileId, next);
  return next;
}

export function addBookmark(state: ReadingState, location: string, label: string, id?: string): ReadingState {
  const bookmark: Bookmark = {
    id: id ?? (crypto.randomUUID?.() ?? `bm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    location,
    label,
    createdAt: new Date().toISOString(),
  };
  return { ...state, bookmarks: [...state.bookmarks, bookmark] };
}

export function removeBookmark(state: ReadingState, id: string): ReadingState {
  return { ...state, bookmarks: state.bookmarks.filter((b) => b.id !== id) };
}

export function hasBookmarkAt(state: ReadingState, location: string): Bookmark | undefined {
  return state.bookmarks.find((b) => b.location === location);
}
