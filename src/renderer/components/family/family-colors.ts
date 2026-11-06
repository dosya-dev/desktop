// apps/desktop/src/renderer/components/family/family-colors.ts
import { SWATCHES } from "@/lib/palette";

/**
 * Per-person colours from the identity swatches, assigned by rank (payer
 * first, then by usage). A family holds at most 16 people and SWATCHES has 7:
 * past the list, people share the last swatch rather than cycling back to
 * someone else's colour.
 */
export function personColor(index: number, dark: boolean): string {
  const sw = SWATCHES[Math.min(index, SWATCHES.length - 1)];
  return dark ? sw.dark : sw.light;
}

/** The label colour that meets AA on personColor (avatar initials). */
export function personInk(index: number, dark: boolean): string {
  const sw = SWATCHES[Math.min(index, SWATCHES.length - 1)];
  return dark ? sw.darkInk : sw.lightInk;
}

/** A person's colour, faded: reserved space they have not used yet. */
export function tint(color: string, pct: number): string {
  return `color-mix(in srgb, ${color} ${pct}%, transparent)`;
}

export function isDarkTheme(): boolean {
  return typeof document !== "undefined" && document.documentElement.classList.contains("dark");
}

/** One stretch of the pool: someone's used storage, or their reserved space they have not used yet. */
export type PoolSegment = { key: string; bytes: number; color: string };

/**
 * The amber note (reservations over the plan, a reservation below use) and the
 * green chip, from the mockup's warn and accent tones. Inline because the
 * app's theme is the `.dark` class and Tailwind's `dark:` follows the OS.
 */
export function warnTone(dark: boolean): { background: string; color: string } {
  return dark ? { background: "rgba(251,191,36,.12)", color: "#fbbf24" } : { background: "rgba(180,83,9,.10)", color: "#b45309" };
}
export function greenTone(dark: boolean): { background: string; color: string } {
  const green = personColor(0, dark);
  return { background: tint(green, dark ? 14 : 10), color: green };
}
