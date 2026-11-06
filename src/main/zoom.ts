/**
 * The interface zoom (the same zoom as View > Zoom In / Zoom Out), persisted
 * as `<dir>/zoom.json` so someone who needs the app larger gets it back on
 * every launch. The renderer sets it from the trackpad pinch and the
 * Appearance control through `app:set-zoom`; the menu's zoom roles change it
 * directly, so the main window also saves it when it closes.
 *
 * Pure logic + an injected dir, unit tested without Electron (same pattern as
 * window-state.ts). Read and write are best-effort: a zoom file must never
 * block boot or break anything else.
 */
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

export const ZOOM_FILE = "zoom.json";
export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3;

/** A zoom factor inside the supported range; anything unusable is 100%. */
export function clampZoom(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return 1;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, value));
}

export function readZoom(dir: string): number {
  try {
    return clampZoom((JSON.parse(readFileSync(join(dir, ZOOM_FILE), "utf-8")) as { factor?: unknown } | null)?.factor);
  } catch {
    return 1;
  }
}

export function writeZoom(dir: string, factor: number): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, ZOOM_FILE), JSON.stringify({ factor: clampZoom(factor) }));
  } catch {}
}

/**
 * A pinch sets the zoom many times a second; this writes once it has been
 * still for `delayMs`, so a gesture costs one write.
 */
export function createZoomSaver(dir: string, delayMs = 500, write: typeof writeZoom = writeZoom): (factor: number) => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (factor: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      write(dir, factor);
    }, delayMs);
  };
}
