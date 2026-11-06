// apps/desktop/src/renderer/components/workspaces/ai-index-donut.ts
//
// Ported from apps/web/src/lib/ai-index-donut.ts - keep the two in step
// (slot order, the three adjusted steps, OTHER_COLOR, ring geometry, the
// minimum-angle rule and the share format).
//
// Data side of the AI index by workspace donut on the account workspace
// dashboard (AiIndexDonut.tsx): slices, colour slots, angles and the share
// format.
import { SWATCH_BY_NAME, type SwatchName } from "@/lib/palette";
import { intlLocale } from "@/lib/locale-state";
import type { AccountAiWorkspace } from "@/lib/ai-search";

/**
 * Colours are the brand's identity swatches in a fixed slot order, validated
 * with the dataviz palette validator for consecutive slots (and the wrap from
 * the last back to the first for every slice count 2-6, plus "Other"). Slots
 * follow workspace id order (slotsById), so two non-consecutive slots can meet
 * on the ring; the 2 px gaps, the legend and the tooltip are the secondary
 * encoding for those pairs. Three steps differ from the swatch's own fill,
 * each a step the swatch list already holds (palette.ts LEGACY_SWATCH): light
 * teal #0f766e reads grey, so light uses #06b6d4; dark green and dark pink sit
 * too close to dark teal and dark violet under CVD, so dark uses #059669 and
 * #db2777.
 */
export const DONUT_SLOTS: { swatch: SwatchName; light: string; dark: string }[] = [
  { swatch: "teal", light: "#06b6d4", dark: SWATCH_BY_NAME.teal.dark },
  { swatch: "pink", light: SWATCH_BY_NAME.pink.light, dark: "#db2777" },
  { swatch: "violet", light: SWATCH_BY_NAME.violet.light, dark: SWATCH_BY_NAME.violet.dark },
  { swatch: "green", light: SWATCH_BY_NAME.green.light, dark: "#059669" },
  { swatch: "blue", light: SWATCH_BY_NAME.blue.light, dark: SWATCH_BY_NAME.blue.dark },
  { swatch: "orange", light: SWATCH_BY_NAME.orange.light, dark: SWATCH_BY_NAME.orange.dark },
];
/** The folded remainder: a neutral, never a seventh hue. */
export const OTHER_COLOR = { light: "#71717a", dark: "#71717a" };
export const MAX_SLICES = DONUT_SLOTS.length;
export const OTHER_KEY = "__other";

export interface DonutSlice {
  key: string;
  /** Null for "Other"; the label is translated at render. */
  name: string | null;
  images: number;
  documents: number;
  value: number;
  /** 0..1 of the total. */
  share: number;
  /** Index into DONUT_SLOTS, or -1 for "Other". */
  slot: number;
  /** Start, end and middle angle in radians, clockwise from twelve o'clock (the direction is applied at drawing). */
  a0: number;
  a1: number;
  mid: number;
}

export function sliceColor(slot: number): { light: string; dark: string } {
  return slot < 0 ? OTHER_COLOR : DONUT_SLOTS[slot];
}

/** Ring geometry in px. The hover stroke fits inside the box; the focus halo may overflow it (svg overflow-visible). */
export const RING = (() => {
  const size = 140;
  const stroke = 14;
  const hoverStroke = stroke + 2;
  const r = (size - hoverStroke) / 2 - 1;
  return { size, stroke, hoverStroke, r, c: size / 2, gapPx: 2, minPx: 3 };
})();

/** The gap between two neighbours, and the smallest arc a slice is drawn with, as angles on the ring. */
export const GAP_ANGLE = RING.gapPx / RING.r;
export const MIN_ANGLE = RING.minPx / RING.r;

/**
 * Colour slot per named workspace: the named set sorted by id, in order. A
 * pure function of which workspaces are named, so a value change never
 * repaints anyone; only a workspace entering or leaving the six can.
 */
export function slotsById(ids: string[]): Map<string, number> {
  return new Map([...ids].sort().map((id, i) => [id, i]));
}

/**
 * Slices largest first, at most MAX_SLICES named ones and the rest folded into
 * "Other". A workspace with nothing indexed (enabled or not) has no slice.
 * Angles: each slice gets its share of the circle, but never less than
 * MIN_ANGLE; what the small ones gain comes out of the largest slice, so the
 * ring still adds up to 360 degrees. `share` stays the true share.
 */
export function buildSlices(workspaces: AccountAiWorkspace[]): { slices: DonutSlice[]; total: number } {
  const rows = workspaces
    .map((w) => ({ w, value: Math.max(0, w.images) + Math.max(0, w.documents) }))
    .filter((r) => r.value > 0)
    .sort((a, b) => b.value - a.value || a.w.id.localeCompare(b.w.id));
  const total = rows.reduce((s, r) => s + r.value, 0);
  if (total === 0) return { slices: [], total };
  const named = rows.slice(0, MAX_SLICES);
  const rest = rows.slice(MAX_SLICES);
  const slots = slotsById(named.map((r) => r.w.id));

  const parts = named.map((r) => ({
    key: r.w.id, name: r.w.name as string | null, images: r.w.images, documents: r.w.documents, value: r.value, slot: slots.get(r.w.id)!,
  }));
  if (rest.length) {
    parts.push({
      key: OTHER_KEY, name: null, slot: -1,
      images: rest.reduce((s, r) => s + r.w.images, 0),
      documents: rest.reduce((s, r) => s + r.w.documents, 0),
      value: rest.reduce((s, r) => s + r.value, 0),
    });
  }

  const angles = parts.map((p) => (p.value / total) * 2 * Math.PI);
  if (angles.length > 1) {
    let deficit = 0;
    for (let i = 1; i < angles.length; i++) {
      if (angles[i] < MIN_ANGLE) { deficit += MIN_ANGLE - angles[i]; angles[i] = MIN_ANGLE; }
    }
    // Index 0 is the largest; it gives up what the small ones gained.
    angles[0] -= deficit;
  }

  const slices: DonutSlice[] = [];
  let a0 = 0;
  parts.forEach((p, i) => {
    const a1 = i === parts.length - 1 ? 2 * Math.PI : a0 + angles[i];
    slices.push({ ...p, share: p.value / total, a0, a1, mid: (a0 + a1) / 2 });
    a0 = a1;
  });
  return { slices, total };
}

/**
 * The part of a slice that is painted: half a gap trimmed off each end, except
 * on a slice too thin to lose it (under two gaps), which is painted whole so
 * it never disappears; its neighbours' half gaps still separate it.
 */
export function paintedArc(slice: Pick<DonutSlice, "a0" | "a1">, count: number): { from: number; to: number } {
  if (count < 2) return { from: slice.a0, to: slice.a1 };
  const trim = slice.a1 - slice.a0 < 2 * GAP_ANGLE ? 0 : GAP_ANGLE / 2;
  return { from: slice.a0 + trim, to: slice.a1 - trim };
}

/**
 * A donut starts at twelve o'clock and runs with the reading direction:
 * clockwise in a left-to-right language, counter-clockwise in a right-to-left
 * one (the web's lib/chart-rtl donutDirection).
 */
export function donutDirection(dir: "ltr" | "rtl"): { sweep: 1 | -1; arcFlag: 0 | 1 } {
  const rtl = dir === "rtl";
  return { sweep: rtl ? -1 : 1, arcFlag: rtl ? 0 : 1 };
}

/** A share as a percentage in the current language; under 1% keeps one decimal so it never reads 0%. */
export function formatShare(share: number): string {
  const digits = share > 0 && share < 0.01 ? 1 : 0;
  return new Intl.NumberFormat(intlLocale("en"), { style: "percent", maximumFractionDigits: digits }).format(share);
}
