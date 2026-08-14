/**
 * Reading themes, ported from apps/mobile/src/reader/readerThemes.ts so a book
 * looks the same on both.
 *
 * These are the READER's own palettes, not the app's 8-theme system. A book is
 * read for a long time in one sitting, and sepia on a bright screen at night is
 * a different decision from which accent colour the file browser uses.
 */
export interface ReaderTheme {
  id: string;
  label: string;
  bg: string;
  fg: string;
}

/**
 * `app` carries no colours of its own - resolveTheme fills them from the running
 * app's computed tokens, so a book matches whatever theme the site is wearing
 * (including all eight accents and light/dark). It is the default because a
 * reader that ignores the app's theme looks like a different product bolted on.
 *
 * The three fixed palettes stay, because reading is not browsing: sepia at night
 * is a choice people make about a book, not about an app.
 */
export const READER_THEMES: ReaderTheme[] = [
  { id: "app", label: "Match app", bg: "", fg: "" },
  { id: "light", label: "Light", bg: "#ffffff", fg: "#1a1a1a" },
  { id: "sepia", label: "Sepia", bg: "#f4ecd8", fg: "#5b4636" },
  { id: "dark", label: "Dark", bg: "#121212", fg: "#c8c8c8" },
];

export const DEFAULT_THEME_ID = "app";

export function themeById(id: string): ReaderTheme {
  return READER_THEMES.find((t) => t.id === id) ?? READER_THEMES[0];
}

/**
 * A theme with real colours, resolving `app` against the live DOM.
 *
 * The app states its palette in CSS custom properties, which this cannot parse
 * reliably - so rather than try, it paints a
 * throwaway element and reads back what the browser computed. That also means it
 * follows every theme the app ever gains without being taught about any of them.
 */
export function resolveTheme(id: string): { bg: string; fg: string } {
  const theme = themeById(id);
  if (theme.id !== "app") return { bg: theme.bg, fg: theme.fg };

  const probe = document.createElement("div");
  probe.style.cssText = "position:absolute;visibility:hidden;pointer-events:none";
  probe.style.background = "var(--color-bg)";
  probe.style.color = "var(--color-text-primary)";
  document.body.append(probe);
  const cs = getComputedStyle(probe);
  const bg = cs.backgroundColor;
  const fg = cs.color;
  probe.remove();

  // A browser that resolved neither leaves us with transparent/empty, which
  // would paint an unreadable page - fall back to the fixed light palette.
  const usable = bg && bg !== "rgba(0, 0, 0, 0)" && fg;
  return usable ? { bg, fg } : { bg: "#ffffff", fg: "#1a1a1a" };
}

export function isKnownThemeId(id: string): boolean {
  return READER_THEMES.some((t) => t.id === id);
}

/** Font bounds match mobile's readerPrefs so the same book reads at the same size. */
export const FONT_MIN = 70;
export const FONT_MAX = 200;
export const FONT_STEP = 10;

const PREFS_KEY = "dosya.reader.prefs";

export interface ReaderPrefs {
  fontSizePct: number;
  themeId: string;
}

export const DEFAULT_PREFS: ReaderPrefs = { fontSizePct: 100, themeId: DEFAULT_THEME_ID };

export function clampFont(v: number): number {
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(v)));
}

/** Prefs are per-reader, not per-book: they follow the person, like mobile's. */
export function loadPrefs(): ReaderPrefs {
  try {
    const raw = localStorage.getItem(PREFS_KEY);
    if (!raw) return DEFAULT_PREFS;
    const p = JSON.parse(raw) as Partial<ReaderPrefs>;
    return {
      fontSizePct: clampFont(typeof p.fontSizePct === "number" ? p.fontSizePct : 100),
      themeId: typeof p.themeId === "string" && isKnownThemeId(p.themeId) ? p.themeId : DEFAULT_THEME_ID,
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

export function savePrefs(prefs: ReaderPrefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* see readingState.saveReadingState - a quota failure must not break reading */
  }
}
