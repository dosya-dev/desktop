/**
 * Persisted window geometry so a reclaimed (or restarted) window reopens
 * exactly where the user left it. Pure logic + injected displays/dir - unit
 * tested without Electron (same DI pattern as device-id.ts / window-reclaim.ts).
 */
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";

export interface Rect { x: number; y: number; width: number; height: number }
export interface SavedWindowState extends Rect { maximized: boolean }

export const WINDOW_STATE_FILE = "window-state.json";

/** Minimum visible sliver for a saved position to count as "still on a screen". */
const MIN_VISIBLE_W = 100;
const MIN_VISIBLE_H = 40;

export function captureWindowState(win: { isMaximized(): boolean; getNormalBounds(): Rect }): SavedWindowState {
  const b = win.getNormalBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height, maximized: win.isMaximized() };
}

const finite = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function resolveWindowState(
  raw: unknown,
  displays: Rect[],
  defaults: { width: number; height: number; minWidth: number; minHeight: number },
): { bounds: Rect | null; maximized: boolean } {
  if (typeof raw !== "object" || raw === null) return { bounds: null, maximized: false };
  const s = raw as Record<string, unknown>;
  // Captured as consts so the narrowing survives into the closure below.
  const x = s.x, y = s.y, savedW = s.width, savedH = s.height;
  if (!finite(x) || !finite(y) || !finite(savedW) || !finite(savedH)) {
    return { bounds: null, maximized: false };
  }
  const maximized = s.maximized === true;

  // Clamp size: at least the window minimums, at most the biggest work area.
  const maxW = Math.max(...displays.map((d) => d.width), defaults.minWidth);
  const maxH = Math.max(...displays.map((d) => d.height), defaults.minHeight);
  const width = Math.min(Math.max(savedW, defaults.minWidth), maxW);
  const height = Math.min(Math.max(savedH, defaults.minHeight), maxH);

  // The saved position must leave a grabbable sliver on SOME display -
  // otherwise the monitor it was on is gone, and we recenter instead of
  // opening the window where nobody can reach it.
  const visible = displays.some((d) => {
    const ow = Math.min(x + width, d.x + d.width) - Math.max(x, d.x);
    const oh = Math.min(y + height, d.y + d.height) - Math.max(y, d.y);
    return ow >= MIN_VISIBLE_W && oh >= MIN_VISIBLE_H;
  });
  if (!visible) return { bounds: null, maximized };

  return { bounds: { x, y, width, height }, maximized };
}

export function readWindowState(dir: string): SavedWindowState | null {
  try {
    return JSON.parse(readFileSync(join(dir, WINDOW_STATE_FILE), "utf-8")) as SavedWindowState;
  } catch {
    return null;
  }
}

/** Best-effort - losing a geometry save must never break anything else. */
export function writeWindowState(dir: string, state: SavedWindowState): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, WINDOW_STATE_FILE), JSON.stringify(state));
  } catch {}
}
