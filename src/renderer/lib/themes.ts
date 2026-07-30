// Theme registry - MUST stay in sync with apps/web/src/lib/themes.ts and the
// API allow-list in apps/api/src/lib/appearance.ts. Ported to the desktop app so
// the same theme options offered on the web are available here too.

export type Mode = "light" | "dark" | "system";

export interface ThemeMeta {
  id: string;
  label: string;
  swatch: { bg: string; primary: string; accent: string };
}

export const THEMES: ThemeMeta[] = [
  { id: "default",    label: "Default",       swatch: { bg: "#eef7f1", primary: "#2fa563", accent: "#63c98d" } },
  { id: "mono",       label: "Mono",          swatch: { bg: "#ffffff", primary: "#242424", accent: "#d4d4d4" } },
  { id: "claude",     label: "Claude",        swatch: { bg: "#f7f3ec", primary: "#b8623f", accent: "#e5c9b3" } },
  { id: "amber",      label: "Amber",         swatch: { bg: "#fdfbf5", primary: "#e0a020", accent: "#f2d488" } },
  { id: "ocean",      label: "Ocean",         swatch: { bg: "#f2f7fc", primary: "#2f6fd0", accent: "#9cc0ec" } },
  { id: "bubblegum",  label: "Bubblegum",     swatch: { bg: "#fdf2f8", primary: "#db4d94", accent: "#f4a9cf" } },
  { id: "vercel",     label: "Vercel",        swatch: { bg: "#ffffff", primary: "#111111", accent: "#e5e5e5" } },
  { id: "neo-brutal", label: "Neo-Brutalism", swatch: { bg: "#f4f4f0", primary: "#ff5a4d", accent: "#3fca6b" } },
];

export const THEME_IDS = THEMES.map((t) => t.id);
export const DEFAULT_THEME = "default";
export const DEFAULT_MODE: Mode = "system";

export function isThemeId(v: unknown): v is string {
  return typeof v === "string" && THEME_IDS.includes(v);
}
export function isMode(v: unknown): v is Mode {
  return v === "light" || v === "dark" || v === "system";
}
