// Theme application + persistence for the desktop renderer. Mirrors
// apps/web/src/lib/theme.ts so both clients behave identically: a theme id +
// mode is applied to <html> (data-theme attribute + .dark class), cached in
// localStorage, and reconciled against the account's saved appearance on login.

import { type Mode, DEFAULT_THEME, DEFAULT_MODE, isThemeId, isMode } from "./themes";

export const THEME_CHANGE_EVENT = "ui-theme-change";

export interface ThemePref { theme: string; mode: Mode }

export const CACHE_KEY = "ui-theme";

export function readCache(): ThemePref {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<ThemePref>;
      if (isThemeId(p.theme) && isMode(p.mode)) return { theme: p.theme, mode: p.mode };
    }
    // Legacy: pre-multitheme builds stored only localStorage.theme = 'dark' | 'light'.
    const legacy = localStorage.getItem("theme");
    if (legacy === "dark" || legacy === "light") return { theme: DEFAULT_THEME, mode: legacy };
  } catch { /* ignore malformed storage */ }
  return { theme: DEFAULT_THEME, mode: DEFAULT_MODE };
}

export function writeCache(pref: ThemePref): void {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(pref)); } catch { /* ignore */ }
}

export function prefersDark(): boolean {
  return typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
}

export function resolveDark(mode: Mode): boolean {
  return mode === "dark" || (mode === "system" && prefersDark());
}

export function applyTheme(pref: ThemePref): void {
  const el = document.documentElement;
  if (pref.theme && pref.theme !== DEFAULT_THEME) el.setAttribute("data-theme", pref.theme);
  else el.removeAttribute("data-theme");
  el.classList.toggle("dark", resolveDark(pref.mode));
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent(THEME_CHANGE_EVENT, { detail: pref }));
}

/** Re-apply on OS scheme change while the user is on 'system'. Returns an unsubscribe fn. */
export function initSystemListener(getPref: () => ThemePref): () => void {
  if (typeof matchMedia !== "function") return () => {};
  const mq = matchMedia("(prefers-color-scheme: dark)");
  const handler = () => { const p = getPref(); if (p.mode === "system") applyTheme(p); };
  mq.addEventListener("change", handler);
  return () => mq.removeEventListener("change", handler);
}

/** Subscribe to any applyTheme() call; the callback receives the applied pref
 *  (via the event detail) so late account reconciliation updates consumers' UI. */
export function subscribeThemeChange(cb: (pref: ThemePref) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => cb((e as CustomEvent<ThemePref>).detail);
  window.addEventListener(THEME_CHANGE_EVENT, handler);
  return () => window.removeEventListener(THEME_CHANGE_EVENT, handler);
}
