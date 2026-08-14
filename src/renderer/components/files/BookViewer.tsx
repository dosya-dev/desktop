import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bookmark as BookmarkIcon, ChevronLeft, ChevronRight, List, Loader2,
  Minus, Palette, Plus, Search, Trash2, X,
} from "lucide-react";
import { apiBase } from "@/lib/api-client";
import { READER_HTML } from "@/lib/reader/readerHtml.generated";
import {
  addBookmark, hasBookmarkAt, loadReadingState, removeBookmark, updateReadingState,
  SAVE_DEBOUNCE_MS, type Bookmark, type ReadingState,
} from "@/lib/reader/readingState";
import {
  clampFont, FONT_MAX, FONT_MIN, FONT_STEP, loadPrefs, READER_THEMES, savePrefs, themeById,
} from "@/lib/reader/readerThemes";

interface TocItem {
  label: string;
  href: string;
  depth: number;
}

interface SearchHit {
  cfi: string;
  excerpt: string;
}

type Panel = "none" | "toc" | "bookmarks" | "search" | "themes";

/**
 * The ebook reader.
 *
 * The reader page is SHARED with apps/mobile - same vendored foliate-js, same
 * message protocol - so this inherits pagination, theming and search instead of
 * reimplementing them. It runs in an iframe rather than a react-native-webview,
 * and the page's index.html shims the host bridge so the shared code needs no
 * branching.
 *
 * Reading state matches mobile's shape exactly, but NOT its storage: mobile
 * writes a file in its sandbox, this writes localStorage, because there is no
 * server-side reading-state endpoint. Bookmarks and positions are per-device on
 * both platforms - the same limitation, not a new one.
 */
export function BookViewer({
  file,
  onClose,
}: {
  file: { id: string; name: string };
  onClose?: () => void;
}) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [toc, setToc] = useState<TocItem[]>([]);
  const [panel, setPanel] = useState<Panel>("none");
  const [section, setSection] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [fraction, setFraction] = useState(0);

  const [prefs, setPrefs] = useState(() => loadPrefs());
  const [reading, setReading] = useState<ReadingState>(() => loadReadingState(file.id));

  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const theme = useMemo(() => themeById(prefs.themeId), [prefs.themeId]);

  const page = useCallback((): Record<string, any> | null => {
    const win = frameRef.current?.contentWindow as unknown as Record<string, any> | undefined;
    return win && typeof win.__dosyaOpen === "function" ? win : null;
  }, []);

  // ── load ────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    const onMessage = (e: MessageEvent) => {
      if (e.source !== frameRef.current?.contentWindow) return;
      let msg: Record<string, any>;
      try {
        msg = typeof e.data === "string" ? JSON.parse(e.data) : e.data;
      } catch {
        return;
      }

      if (msg.type === "loaded") void deliver();
      if (msg.type === "toc") setToc(Array.isArray(msg.items) ? msg.items : []);
      if (msg.type === "relocated") {
        setState("ready");
        setFraction(typeof msg.fraction === "number" ? msg.fraction : 0);
        setSection(msg.section ?? null);
        setLocation(typeof msg.location === "string" ? msg.location : null);
        queuePositionSave(msg.location, msg.fraction);
      }
      if (msg.type === "searchResults" && Array.isArray(msg.items)) {
        setHits((prev) => [...prev, ...msg.items.map(toHit)].slice(0, 200));
      }
      if (msg.type === "searchDone") setSearching(false);
      if (msg.type === "searchError") {
        setSearching(false);
        setError(null);
      }
      if (msg.type === "error") {
        setError(String(msg.message ?? "This book could not be opened."));
        setState("error");
      }
      if (msg.type === "externalLink" && typeof msg.href === "string") {
        window.open(msg.href, "_blank", "noopener,noreferrer");
      }
    };

    async function deliver() {
      const win = page();
      if (!win || cancelled) return;
      try {
        const res = await fetch(`${apiBase()}/api/files/${file.id}/raw`, { credentials: "include" });
        if (!res.ok) throw new Error(`Could not download the book (${res.status})`);
        const buf = new Uint8Array(await res.arrayBuffer());
        if (cancelled) return;

        const saved = loadReadingState(file.id);
        win.__dosyaInit({
          format: "epub",
          name: file.name,
          // Resume where this device left off. The page falls forward to page one
          // when a stored location no longer resolves.
          location: saved.location,
          fontSizePct: prefs.fontSizePct,
          bg: theme.bg,
          fg: theme.fg,
        });
        win.__dosyaChunk(toBase64(buf));
        await win.__dosyaOpen();
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : "This book could not be opened.");
        setState("error");
      }
    }

    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [file.id, file.name, page]);

  /**
   * Debounced, because `relocated` fires on every page turn and a book being
   * flicked through would otherwise write on every frame.
   */
  const queuePositionSave = useCallback((loc: unknown, frac: unknown) => {
    if (typeof loc !== "string") return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      // Read-modify-write, so a bookmark added between turns is not clobbered by
      // this flush.
      setReading(updateReadingState(file.id, (prev) => ({
        ...prev,
        location: loc,
        percent: typeof frac === "number" ? frac : prev.percent,
      })));
    }, SAVE_DEBOUNCE_MS);
  }, [file.id]);

  // Live settings, applied without reopening the book.
  useEffect(() => {
    savePrefs(prefs);
    page()?.__dosyaApply?.({ fontSizePct: prefs.fontSizePct, bg: theme.bg, fg: theme.fg });
  }, [prefs, theme, page]);

  const turn = useCallback((dir: "prev" | "next") => {
    const win = page();
    if (dir === "prev") win?.__dosyaPrev?.();
    else win?.__dosyaNext?.();
  }, [page]);

  const goTo = useCallback((target: string) => {
    page()?.__dosyaGoTo?.(target);
    setPanel("none");
  }, [page]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Not while typing a search query.
      if ((e.target as HTMLElement | null)?.tagName === "INPUT") return;
      if (e.key === "ArrowLeft") turn("prev");
      if (e.key === "ArrowRight") turn("next");
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [turn]);

  // ── bookmarks ───────────────────────────────────────────
  const bookmarkHere = hasBookmarkAt(reading, location ?? "");

  const toggleBookmark = useCallback(() => {
    if (!location) return;
    setReading(updateReadingState(file.id, (prev) => {
      const existing = hasBookmarkAt(prev, location);
      // The label is what makes a bookmark list readable later - a CFI is not
      // something anyone recognises.
      return existing
        ? removeBookmark(prev, existing.id)
        : addBookmark(prev, location, section ?? `${Math.round(fraction * 100)}%`);
    }));
  }, [file.id, location, section, fraction]);

  const dropBookmark = useCallback((id: string) => {
    setReading(updateReadingState(file.id, (prev) => removeBookmark(prev, id)));
  }, [file.id]);

  // ── search ──────────────────────────────────────────────
  const runSearch = useCallback(() => {
    const q = query.trim();
    if (!q) return;
    setHits([]);
    setSearching(true);
    page()?.__dosyaSearch?.(q);
  }, [query, page]);

  const clearSearch = useCallback(() => {
    setQuery("");
    setHits([]);
    setSearching(false);
    page()?.__dosyaSearchClear?.();
  }, [page]);

  const togglePanel = (p: Panel) => setPanel((cur) => (cur === p ? "none" : p));
  const chrome = "rounded-lg p-1.5 hover:bg-[var(--color-bg-secondary)] disabled:opacity-40";
  const active = (p: Panel) => (panel === p ? " bg-[var(--color-bg-tertiary)]" : "");

  return (
    <div className="flex h-full w-full flex-col" data-testid="book-viewer">
      <div className="flex items-center gap-1.5 border-b px-3 py-2" style={{ borderColor: "var(--color-border)" }}>
        <button data-testid="book-toc-toggle" onClick={() => togglePanel("toc")} disabled={toc.length === 0} title="Contents" className={chrome + active("toc")}>
          <List size={15} />
        </button>
        <button data-testid="book-bookmarks-toggle" onClick={() => togglePanel("bookmarks")} title="Bookmarks" className={chrome + active("bookmarks")}>
          <BookmarkIcon size={15} />
          {reading.bookmarks.length > 0 && (
            <span data-testid="book-bookmark-count" className="ml-1 text-xs">{reading.bookmarks.length}</span>
          )}
        </button>
        <button data-testid="book-search-toggle" onClick={() => togglePanel("search")} title="Search in book" className={chrome + active("search")}>
          <Search size={15} />
        </button>
        <button data-testid="book-themes-toggle" onClick={() => togglePanel("themes")} title="Reading theme" className={chrome + active("themes")}>
          <Palette size={15} />
        </button>

        <span className="mx-1 h-4 w-px" style={{ background: "var(--color-border)" }} />

        <button data-testid="book-prev" onClick={() => turn("prev")} title="Previous page" className={chrome}>
          <ChevronLeft size={15} />
        </button>
        <button data-testid="book-next" onClick={() => turn("next")} title="Next page" className={chrome}>
          <ChevronRight size={15} />
        </button>

        <button
          data-testid="book-bookmark-here"
          onClick={toggleBookmark}
          disabled={!location}
          title={bookmarkHere ? "Remove bookmark" : "Bookmark this page"}
          className={chrome + (bookmarkHere ? " text-[var(--color-primary)]" : "")}
        >
          <BookmarkIcon size={15} fill={bookmarkHere ? "currentColor" : "none"} />
        </button>

        <span data-testid="book-position" className="flex-1 truncate px-2 text-xs text-[var(--color-text-muted)]">
          {section ? section : file.name}
          {state === "ready" && ` · ${Math.round(fraction * 100)}%`}
        </span>

        <button data-testid="book-font-smaller" onClick={() => setPrefs((p) => ({ ...p, fontSizePct: clampFont(p.fontSizePct - FONT_STEP) }))} disabled={prefs.fontSizePct <= FONT_MIN} title="Smaller text" className={chrome}>
          <Minus size={14} />
        </button>
        <span data-testid="book-font-size" className="w-10 text-center text-xs text-[var(--color-text-muted)]">{prefs.fontSizePct}%</span>
        <button data-testid="book-font-bigger" onClick={() => setPrefs((p) => ({ ...p, fontSizePct: clampFont(p.fontSizePct + FONT_STEP) }))} disabled={prefs.fontSizePct >= FONT_MAX} title="Larger text" className={chrome}>
          <Plus size={14} />
        </button>
        {onClose && (
          <button data-testid="book-close" onClick={onClose} title="Close" className={chrome}>
            <X size={15} />
          </button>
        )}
      </div>

      <div className="relative flex min-h-0 flex-1">
        {panel !== "none" && (
          <aside
            data-testid={`book-panel-${panel}`}
            className="w-72 shrink-0 overflow-y-auto border-r py-2"
            style={{ borderColor: "var(--color-border)" }}
          >
            {panel === "toc" && (
              <div data-testid="book-toc">
                {toc.map((item, i) => (
                  <button
                    key={`${item.href}-${i}`}
                    data-testid={`book-toc-item-${i}`}
                    onClick={() => goTo(item.href)}
                    className="block w-full truncate px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-secondary)]"
                    style={{ paddingLeft: 12 + item.depth * 12 }}
                    title={item.label}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            )}

            {panel === "bookmarks" && (
              <div data-testid="book-bookmarks">
                {reading.bookmarks.length === 0 ? (
                  <p data-testid="book-bookmarks-empty" className="px-3 py-2 text-xs text-[var(--color-text-muted)]">
                    No bookmarks yet. Use the ribbon to mark this page.
                  </p>
                ) : (
                  reading.bookmarks.map((b: Bookmark) => (
                    <div key={b.id} data-testid={`book-bookmark-${b.id}`} className="group flex items-center gap-1 px-3 py-1.5 text-xs hover:bg-[var(--color-bg-secondary)]">
                      <button onClick={() => goTo(b.location)} className="flex-1 truncate text-left" title={b.label}>
                        {b.label}
                      </button>
                      <button
                        data-testid={`book-bookmark-${b.id}-remove`}
                        onClick={() => dropBookmark(b.id)}
                        title="Remove bookmark"
                        className="text-[var(--color-text-muted)] opacity-0 transition-opacity group-hover:opacity-100 hover:text-[var(--color-danger)]"
                      >
                        <Trash2 size={11} />
                      </button>
                    </div>
                  ))
                )}
              </div>
            )}

            {panel === "search" && (
              <div data-testid="book-search">
                <div className="flex items-center gap-1 px-2 pb-2">
                  <input
                    data-testid="book-search-input"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }}
                    placeholder="Search in this book"
                    className="min-w-0 flex-1 rounded-lg border px-2 py-1 text-xs outline-none focus:border-[var(--color-primary)]"
                    style={{ borderColor: "var(--color-border)" }}
                  />
                  <button data-testid="book-search-clear" onClick={clearSearch} title="Clear" className={chrome}>
                    <X size={12} />
                  </button>
                </div>
                {searching && (
                  <p data-testid="book-search-busy" className="px-3 py-1 text-xs text-[var(--color-text-muted)]">Searching…</p>
                )}
                {!searching && hits.length === 0 && query.trim() !== "" && (
                  <p data-testid="book-search-none" className="px-3 py-1 text-xs text-[var(--color-text-muted)]">No matches.</p>
                )}
                {hits.map((h, i) => (
                  <button
                    key={`${h.cfi}-${i}`}
                    data-testid={`book-search-hit-${i}`}
                    onClick={() => goTo(h.cfi)}
                    className="block w-full px-3 py-1.5 text-left text-xs hover:bg-[var(--color-bg-secondary)]"
                  >
                    <span className="line-clamp-2 text-[var(--color-text-secondary)]">{h.excerpt}</span>
                  </button>
                ))}
              </div>
            )}

            {panel === "themes" && (
              <div data-testid="book-themes" className="px-2">
                {READER_THEMES.map((t) => (
                  <button
                    key={t.id}
                    data-testid={`book-theme-${t.id}`}
                    onClick={() => setPrefs((p) => ({ ...p, themeId: t.id }))}
                    className={`mb-1 flex w-full items-center gap-2 rounded-lg border px-2 py-1.5 text-xs ${prefs.themeId === t.id ? "border-[var(--color-primary)]" : ""}`}
                    style={{ borderColor: prefs.themeId === t.id ? "var(--color-primary)" : "var(--color-border)" }}
                  >
                    <span className="h-4 w-4 rounded border" style={{ background: t.bg, borderColor: "var(--color-border)" }} />
                    <span>{t.label}</span>
                  </button>
                ))}
              </div>
            )}
          </aside>
        )}

        <div className="relative min-w-0 flex-1">
          <iframe
            ref={frameRef}
            data-testid="book-frame"
            title={`Book: ${file.name}`}
            srcDoc={READER_HTML}
            className="h-full w-full border-none"
            style={{ background: theme.bg }}
          />

          {state === "loading" && (
            <div data-testid="book-loading" className="absolute inset-0 flex flex-col items-center justify-center gap-2" style={{ background: theme.bg }}>
              <Loader2 size={18} className="animate-spin text-[var(--color-text-muted)]" />
              <p className="text-xs text-[var(--color-text-muted)]">Opening {file.name}…</p>
            </div>
          )}

          {state === "error" && (
            <div data-testid="book-error" className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center" style={{ background: theme.bg }}>
              <p className="text-sm font-medium">This book could not be opened</p>
              <p className="text-xs text-[var(--color-text-muted)]">{error}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The page already flattens each hit to { cfi, excerpt } (see reader-page's
 * __dosyaSearch), so this only guards against a missing field.
 */
function toHit(item: unknown): SearchHit {
  const h = (item ?? {}) as { cfi?: unknown; excerpt?: unknown };
  return { cfi: String(h.cfi ?? ""), excerpt: String(h.excerpt ?? "").trim() };
}

/** Bytes to base64 without blowing the argument limit on a large book. */
function toBase64(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    out += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(out);
}
