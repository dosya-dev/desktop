import { useEffect } from "react";

/**
 * Trackpad pinch zooms the whole interface, the same zoom as View > Zoom In
 * and Zoom Out. Chromium turns a pinch into wheel events with `ctrlKey` set
 * (a real Ctrl + mouse wheel looks the same, and zooms the same way), and
 * Electron leaves them unhandled, so the gesture did nothing before.
 *
 * A screen with its own pinch (the map) calls preventDefault on the wheel
 * event; those are left alone. The main process clamps and applies the
 * factor and saves it (main/zoom.ts).
 */

/**
 * The factor after a pinch of `deltaY`. Chromium reports a pinch to scale
 * `s` as deltaY = -100 * ln(s), so this follows the fingers one to one.
 */
export function pinchedZoom(current: number, deltaY: number): number {
  return current * Math.exp(-deltaY / 100);
}

/** The −/+ buttons in Profile > Appearance step through these, as browsers do. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3];

/** The next step above (+1) or below (−1) `current`; the end steps stay put. */
export function steppedZoom(current: number, direction: 1 | -1): number {
  const eps = 0.005;
  if (direction > 0) return ZOOM_STEPS.find((s) => s > current + eps) ?? ZOOM_STEPS[ZOOM_STEPS.length - 1];
  return [...ZOOM_STEPS].reverse().find((s) => s < current - eps) ?? ZOOM_STEPS[0];
}

/** Installs the pinch listener for this window. Mounted once, in App. */
export function usePinchZoom(): void {
  useEffect(() => {
    const api = window.electronAPI;
    if (!api?.setZoom || !api.getZoom) return;
    let live = true;
    let current = 1;
    let pending = 0;
    let frame = 0;
    let inFlight = false;

    const read = () => api.getZoom().then((f) => { if (live && !inFlight) current = f; }).catch(() => {});
    read();

    // One update per frame, and never two in flight: the next frame starts
    // from the factor main actually applied.
    const flush = () => {
      frame = 0;
      if (inFlight || pending === 0) return;
      const target = pinchedZoom(current, pending);
      pending = 0;
      inFlight = true;
      api.setZoom(target)
        .then((applied) => { current = applied; })
        .catch(() => {})
        .finally(() => {
          inFlight = false;
          if (live && pending !== 0 && !frame) frame = requestAnimationFrame(flush);
        });
    };

    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey || e.defaultPrevented) return;
      pending += e.deltaY;
      if (!frame) frame = requestAnimationFrame(flush);
    };

    window.addEventListener("wheel", onWheel, { passive: true });
    // ⌘+ / ⌘− and the Appearance control change the zoom too; a zoom change
    // resizes the viewport, so re-read it then and the next pinch starts there.
    window.addEventListener("resize", read);
    return () => {
      live = false;
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("wheel", onWheel);
      window.removeEventListener("resize", read);
    };
  }, []);
}
